import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { mediaKeyFor } from "../src/server/storage/media-storage.ts";
import { requestSharedMediaImport, retrySharedMediaImport, scheduleOwnedMediaDeletion } from "../src/server/handlers/media-import.ts";
import { runNextMediaImportJob } from "../src/server/media-import/import-worker.ts";
import { makeCollection, makeMedia, NOW, inDays } from "./helpers.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import type { RequestContext } from "../src/server/context.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";

const sourceBytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function heartbeatHarness() {
  let pulse: (() => Promise<void>) | null = null; let cancelled = false;
  return {
    scheduleHeartbeat: (fn: () => Promise<void>) => { pulse = fn; return () => { cancelled = true; }; },
    async pulse() { assert.ok(pulse); await pulse!(); },
    get cancelled() { return cancelled; },
  };
}
function memoryFixture() {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  const source = makeMedia({ id: "source", ownerId: "owner", sizeBytes: sourceBytes.byteLength, title: "Original", mimeType: "video/mp4", kind: "video", checksumSha256: null });
  repo.media.set(source.id, source); repo.storageKeys.set(source.id, mediaKeyFor("owner", source.id)); storage.objects.set(mediaKeyFor("owner", source.id), sourceBytes.slice());
  repo.collections.set("shared", makeCollection({ id: "shared", ownerId: "owner", mediaIds: [source.id] }));
  repo.grants.push({ collectionId: "shared", granteeId: "recipient", capabilities: ["view", "import_copy"], status: "active", expiresAt: null, grantedById: "owner" });
  repo.plans.set("recipient", "creator");
  let id = 0;
  const ctx: RequestContext = { userId: "recipient", now: NOW, repo, newId: () => `id-${++id}`, config: { coverSupport: "unknown" }, durableMediaImports: true };
  return { repo, storage, source, ctx };
}

async function queueMemory(f: ReturnType<typeof memoryFixture>) {
  return requestSharedMediaImport(f.ctx, { sourceMediaId: "source", sourceCollectionId: "shared", warningAcknowledged: true });
}

test("memory import denies unauthorized and malformed requests, enforces quota, and idempotently creates one audited job", async () => {
  const f = memoryFixture();
  await assert.rejects(() => requestSharedMediaImport({ ...f.ctx, userId: "stranger" }, { sourceMediaId: "source", sourceCollectionId: "shared", warningAcknowledged: true }));
  await assert.rejects(() => requestSharedMediaImport(f.ctx, { sourceMediaId: "source", sourceCollectionId: "shared", warningAcknowledged: true, importerId: "owner" }));
  await assert.rejects(() => requestSharedMediaImport(f.ctx, { sourceMediaId: "source", sourceCollectionId: "shared", warningAcknowledged: false }));
  const full = memoryFixture(); full.repo.plans.set("recipient", "free"); full.repo.media.set("filler", makeMedia({ id: "filler", ownerId: "recipient", sizeBytes: getPlan("free").limits.storageBytes }));
  await assert.rejects(() => requestSharedMediaImport(full.ctx, { sourceMediaId: "source", sourceCollectionId: "shared", warningAcknowledged: true }), (error: { code?: string }) => error.code === "plan_limit");
  const first = await queueMemory(f); assert.equal(first.status, "pending");
  const duplicate = await queueMemory(f);
  assert.equal(duplicate.status, "existing");
  assert.equal(f.repo.mediaImportJobs.size, 1);
  assert.equal(f.repo.audit.filter((entry) => entry.action === "media.import_requested").length, 1);
});

test("an idempotent import replay still requires current import permission", async () => {
  const f = memoryFixture(); await queueMemory(f);
  f.repo.grants[0]!.status = "revoked";
  await assert.rejects(() => queueMemory(f));
  assert.equal(f.repo.mediaImportJobs.size, 1);
  assert.equal(f.repo.audit.filter((entry) => entry.action === "media.import_requested").length, 1);
});

test("failed import retry is denied after its sharing grant is revoked", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  const claim = await f.repo.claimNextMediaImportJob({ workerId: "worker", now: NOW, leaseSeconds: 60, jobId: queued.jobId }); assert.ok(claim);
  assert.equal(await f.repo.failMediaImportJob({ jobId: queued.jobId, lockToken: claim!.lockToken!, now: NOW, reason: "copy failed" }), true);
  f.repo.grants[0]!.status = "revoked";
  assert.equal(await f.repo.retryMediaImportJob("recipient", queued.jobId, NOW), false);
  assert.equal(f.repo.mediaImportJobs.get(queued.jobId)?.status, "failed");
});

test("memory worker imports a verified copy; original metadata and bytes remain intact and completion is audited", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  assert.equal(queued.status, "pending"); assert.equal((await f.repo.getMedia("source"))?.status, "active");
  const before = structuredClone(f.source);
  assert.equal(await runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "worker", now: () => NOW }), "succeeded");
  const job = f.repo.mediaImportJobs.get(queued.jobId)!; const copy = await f.repo.getMedia(job.resultMediaAssetId);
  assert.equal(job.status, "succeeded"); assert.equal(copy?.ownerId, "recipient"); assert.equal(copy?.importedFromId, "source"); assert.equal(copy?.sizeBytes, sourceBytes.length);
  assert.deepEqual(f.repo.media.get("source"), before); assert.deepEqual(f.storage.objects.get(mediaKeyFor("owner", "source")), sourceBytes);
  assert.deepEqual(f.repo.audit.map((entry) => entry.action), ["media.import_requested", "media.import_completed"]);
  assert.equal(await runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "worker-2", now: () => inDays(1) }), "idle");
  assert.equal(f.repo.media.size, 2);
});

test("worker renews during slow copying past the original lease and still completes", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const gate = deferred(); const started = deferred();
  const copy = f.storage.copyCommittedToStaging.bind(f.storage);
  f.storage.copyCommittedToStaging = async (...args) => { started.resolve(); await gate.promise; return copy(...args); };
  const clock = { ms: NOW.getTime() }; const heartbeat = heartbeatHarness();
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "slow-copy", jobId: queued.jobId, leaseSeconds: 1, now: () => new Date(clock.ms), scheduleHeartbeat: heartbeat.scheduleHeartbeat });
  await started.promise;
  clock.ms += 800; await heartbeat.pulse();
  clock.ms += 800; await heartbeat.pulse(); // work has outlasted the original one-second lease
  gate.resolve();
  assert.equal(await run, "succeeded"); assert.equal(f.repo.mediaImportJobs.get(queued.jobId)?.status, "succeeded");
  assert.equal(heartbeat.cancelled, true);
});

test("worker renews during slow source hashing past the original lease", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const gate = deferred(); const started = deferred();
  const clock = { ms: NOW.getTime() }; const heartbeat = heartbeatHarness(); let hashCalls = 0;
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "slow-hash", jobId: queued.jobId, leaseSeconds: 1, now: () => new Date(clock.ms), scheduleHeartbeat: heartbeat.scheduleHeartbeat,
    checksumFile: async (_path, assertOwned) => { hashCalls++; if (hashCalls === 1) { started.resolve(); await gate.promise; } await assertOwned(); return "verified-test-hash"; },
  });
  await started.promise;
  clock.ms += 800; await heartbeat.pulse();
  clock.ms += 800; await heartbeat.pulse();
  gate.resolve();
  assert.equal(await run, "succeeded"); assert.equal(hashCalls, 2);
});

test("worker renews during slow staged-file verification", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const gate = deferred(); const started = deferred();
  const clock = { ms: NOW.getTime() }; const heartbeat = heartbeatHarness(); let hashCalls = 0;
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "slow-staged-hash", jobId: queued.jobId, leaseSeconds: 1, now: () => new Date(clock.ms), scheduleHeartbeat: heartbeat.scheduleHeartbeat,
    checksumFile: async (_path, assertOwned) => { hashCalls++; if (hashCalls === 2) { started.resolve(); await gate.promise; } await assertOwned(); return "verified-test-hash"; },
  });
  await started.promise;
  clock.ms += 800; await heartbeat.pulse();
  clock.ms += 800; await heartbeat.pulse();
  gate.resolve();
  assert.equal(await run, "succeeded"); assert.equal(hashCalls, 2);
});

test("heartbeat failure stops worker before verification or finalization", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const started = deferred(); const finalized = f.repo.finalizeMediaImportJob.bind(f.repo); let finalizations = 0; let stats = 0;
  f.repo.finalizeMediaImportJob = async (...args) => { finalizations++; return finalized(...args); };
  const stat = f.storage.statSize.bind(f.storage); f.storage.statSize = async (...args) => { stats++; return stat(...args); };
  f.repo.heartbeatMediaImportJob = async () => false;
  const heartbeat = heartbeatHarness(); const copy = f.storage.copyCommittedToStaging.bind(f.storage);
  f.storage.copyCommittedToStaging = async (...args) => { started.resolve(); await heartbeat.pulse(); return copy(...args); };
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "lost", jobId: queued.jobId, scheduleHeartbeat: heartbeat.scheduleHeartbeat });
  await started.promise;
  assert.equal(await run, "stale"); assert.equal(finalizations, 0); assert.equal(stats, 0); assert.equal(f.storage.staged.size, 0);
});

test("a heartbeat error fails closed and cannot let an expired worker finalize over a newer claim", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const started = deferred(); const finalized = f.repo.finalizeMediaImportJob.bind(f.repo); let finalizations = 0; let newerToken: string | null = null;
  f.repo.finalizeMediaImportJob = async (...args) => { finalizations++; return finalized(...args); };
  const claim = f.repo.claimNextMediaImportJob.bind(f.repo); let clockMs = NOW.getTime();
  f.repo.heartbeatMediaImportJob = async (input) => {
    clockMs = NOW.getTime() + 2_000;
    const newer = await claim({ workerId: "new-worker", now: new Date(clockMs), leaseSeconds: 60, jobId: input.jobId }); newerToken = newer?.lockToken ?? null;
    throw new Error("heartbeat unavailable");
  };
  const heartbeat = heartbeatHarness(); const copy = f.storage.copyCommittedToStaging.bind(f.storage); const gate = deferred();
  f.storage.copyCommittedToStaging = async (...args) => { started.resolve(); await gate.promise; return copy(...args); };
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "old-worker", jobId: queued.jobId, leaseSeconds: 1, now: () => new Date(clockMs || NOW.getTime()), scheduleHeartbeat: heartbeat.scheduleHeartbeat });
  await started.promise; await heartbeat.pulse(); gate.resolve();
  assert.equal(await run, "stale"); assert.ok(newerToken); assert.equal(finalizations, 0);
  assert.equal(f.repo.mediaImportJobs.get(queued.jobId)?.lockToken, newerToken);
});

test("worker cleanup waits for an in-flight heartbeat before removing staging", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const heartbeatGate = deferred<boolean>(); const started = deferred(); let cleanups = 0;
  f.repo.heartbeatMediaImportJob = async () => heartbeatGate.promise;
  const discard = f.storage.discardStaged.bind(f.storage); f.storage.discardStaged = async (...args) => { cleanups++; return discard(...args); };
  const heartbeat = heartbeatHarness();
  f.storage.copyCommittedToStaging = async () => { started.resolve(); void heartbeat.pulse(); throw new Error("copy failed"); };
  let settled = false;
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "cleanup", jobId: queued.jobId, scheduleHeartbeat: heartbeat.scheduleHeartbeat }).finally(() => { settled = true; });
  await started.promise; await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(cleanups, 0);
  heartbeatGate.resolve(false);
  assert.equal(await run, "stale"); assert.equal(cleanups, 1); assert.equal(heartbeat.cancelled, true);
});

test("overlapping heartbeat ticks are coalesced into one repository renewal", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f); const heartbeatGate = deferred<boolean>(); const started = deferred(); let calls = 0; let overlappingCalls = 0;
  f.repo.heartbeatMediaImportJob = async () => { calls++; return heartbeatGate.promise; };
  const heartbeat = heartbeatHarness(); const copy = f.storage.copyCommittedToStaging.bind(f.storage);
  f.storage.copyCommittedToStaging = async (...args) => { started.resolve(); const first = heartbeat.pulse(); const second = heartbeat.pulse(); await Promise.resolve(); assert.equal(calls, 1); overlappingCalls = calls; heartbeatGate.resolve(true); await Promise.all([first, second]); return copy(...args); };
  const run = runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "coalesced", jobId: queued.jobId, scheduleHeartbeat: heartbeat.scheduleHeartbeat });
  await started.promise;
  assert.equal(await run, "succeeded"); assert.equal(overlappingCalls, 1); assert.equal(calls, 2); // one final pre-commit renewal
});

test("memory import finalization rechecks grant and collection membership; deletion stays blocked while import is pending", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  assert.equal(await scheduleOwnedMediaDeletion({ ...f.ctx, userId: "owner" }, { mediaId: "source", confirm: true }).then(() => "scheduled", (e: { code?: string }) => e.code), "conflict");
  const claimed = await f.repo.claimNextMediaImportJob({ workerId: "w", now: NOW, leaseSeconds: 60 }); assert.ok(claimed);
  assert.equal(await f.repo.markMediaImportVerifying({ jobId: claimed!.id, lockToken: claimed!.lockToken!, now: NOW }), true);
  f.repo.grants[0]!.status = "revoked";
  const job = claimed!; const copy = { ...f.source, id: job.resultMediaAssetId, ownerId: "recipient", importedFromId: "source" };
  assert.equal(await f.repo.finalizeMediaImportJob({ jobId: job.id, lockToken: job.lockToken!, importerId: "recipient", now: NOW, media: copy, storageKey: job.newObjectKey, commitStagedObject: async () => undefined }), "unauthorized");
  assert.equal(f.repo.media.has(job.resultMediaAssetId), false);
  assert.equal((await f.repo.getMediaImportJobForOwner("stranger", queued.jobId)), null);
  assert.equal(await scheduleOwnedMediaDeletion({ ...f.ctx, userId: "owner" }, { mediaId: "source", confirm: true }).then(() => "scheduled", (e: { code?: string }) => e.code), "conflict");
});

test("expired import lease is reclaimed with a new fencing token and stale worker cannot advance it", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  const first = await f.repo.claimNextMediaImportJob({ workerId: "first", now: NOW, leaseSeconds: 1, jobId: queued.jobId }); assert.ok(first);
  const later = new Date(NOW.getTime() + 2_000);
  const second = await f.repo.claimNextMediaImportJob({ workerId: "second", now: later, leaseSeconds: 60, jobId: queued.jobId }); assert.ok(second);
  assert.notEqual(first!.lockToken, second!.lockToken);
  assert.equal(await f.repo.markMediaImportVerifying({ jobId: queued.jobId, lockToken: first!.lockToken!, now: later }), false);
  assert.equal(await f.repo.markMediaImportVerifying({ jobId: queued.jobId, lockToken: second!.lockToken!, now: later }), true);
});

test("reclaimed worker cleans interrupted attempt staging and does not leave duplicate copies", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  const first = await f.repo.claimNextMediaImportJob({ workerId: "interrupted", now: NOW, leaseSeconds: 1, jobId: queued.jobId }); assert.ok(first);
  await f.storage.copyCommittedToStaging(mediaKeyFor("owner", "source"), first!.stagingObjectKey!);
  assert.equal(f.storage.staged.size, 1);
  assert.equal(await runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "recovery", now: () => new Date(NOW.getTime() + 2_000), jobId: queued.jobId }), "succeeded");
  assert.equal(f.storage.staged.size, 0);
  assert.equal(f.storage.objects.size, 2);
  assert.equal((await f.repo.getMediaImportJobForOwner("recipient", queued.jobId))?.status, "succeeded");
});

test("memory audit failure rolls back imported record and job completion; failed jobs can be retried", async () => {
  const f = memoryFixture(); const queued = await queueMemory(f);
  f.repo.beforeMediaImportAuditInsert = (entry) => entry.action !== "media.import_completed";
  assert.equal(await runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "worker", now: () => NOW }), "failed");
  let job = f.repo.mediaImportJobs.get(queued.jobId)!;
  assert.equal(job.status, "failed"); assert.equal(f.repo.media.has(job.resultMediaAssetId), false);
  assert.equal(f.storage.staged.size, 0);
  assert.deepEqual(f.repo.audit.map((entry) => entry.action), ["media.import_requested", "media.import_failed"]);
  f.repo.beforeMediaImportAuditInsert = null;
  assert.deepEqual(await retrySharedMediaImport(f.ctx, { jobId: queued.jobId }), { jobId: queued.jobId, collectionId: "shared", status: "pending" });
  assert.equal(await runNextMediaImportJob({ repo: f.repo, storage: f.storage, workerId: "worker-2", now: () => inDays(1) }), "succeeded");
  job = f.repo.mediaImportJobs.get(queued.jobId)!; assert.equal(job.status, "succeeded");
});

test("memory import request and each finalization write fail without partial repository state", async () => {
  const requestFailure = memoryFixture(); requestFailure.repo.beforeMediaImportAuditInsert = () => false;
  await assert.rejects(() => queueMemory(requestFailure));
  assert.equal(requestFailure.repo.mediaImportJobs.size, 0); assert.equal(requestFailure.repo.audit.length, 0);
  for (const stage of ["asset_create", "job_transition"] as const) {
    const f = memoryFixture(); const queued = await queueMemory(f); const claim = await f.repo.claimNextMediaImportJob({ workerId: "worker", now: NOW, leaseSeconds: 60, jobId: queued.jobId }); assert.ok(claim);
    await f.repo.markMediaImportVerifying({ jobId: queued.jobId, lockToken: claim!.lockToken!, now: NOW });
    f.repo.beforeMediaImportWrite = (write) => write !== stage;
    const copy = { ...f.source, id: claim!.resultMediaAssetId, ownerId: "recipient", importedFromId: "source" };
    await assert.rejects(() => f.repo.finalizeMediaImportJob({ jobId: queued.jobId, lockToken: claim!.lockToken!, importerId: "recipient", now: NOW, media: copy, storageKey: claim!.newObjectKey, commitStagedObject: async () => undefined }));
    assert.equal(f.repo.media.has(claim!.resultMediaAssetId), false); assert.equal(f.repo.mediaImportJobs.get(queued.jobId)?.status, "verifying");
    assert.deepEqual(f.repo.audit.map((entry) => entry.action), ["media.import_requested"]);
  }
});

async function prismaFixture() {
  const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", email: "owner@example.test" } }); await db.user.create({ data: { id: "recipient", email: "recipient@example.test" } });
  const repo = new PrismaRepository(db, () => NOW);
  await repo.addMediaIfStorageWithin(makeMedia({ id: "source", ownerId: "owner", sizeBytes: sourceBytes.length, title: "Original", kind: "video", mimeType: "video/mp4" }), { storageKey: mediaKeyFor("owner", "source"), thumbnailKey: null }, 10_000);
  await repo.createCollection(makeCollection({ id: "shared", ownerId: "owner", mediaIds: ["source"] }));
  await db.collectionPermission.create({ data: { collectionId: "shared", granteeId: "recipient", capabilities: ["view", "import_copy"], status: "active", expiresAt: null, grantedById: "owner", revokedAt: null } });
  return { db, repo };
}

test("fake-Prisma import persists request, claim, verified copy, completion and audit atomically with user-first locks", async () => {
  const { db, repo } = await prismaFixture(); const request = await repo.createOrGetMediaImportJob({ id: "job", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy", idempotencyKey: "import:recipient:source", now: NOW });
  assert.equal(request.status, "created"); assert.deepEqual(db.lockLog.slice(-4), ["user:owner", "user:recipient", "collection:shared", "media:source"]);
  db.lockLog.length = 0;
  const claim = await repo.claimNextMediaImportJob({ workerId: "worker", now: NOW, leaseSeconds: 60, jobId: "job" }); assert.ok(claim);
  assert.deepEqual(db.lockLog.slice(0, 2), ["user:owner", "user:recipient"]);
  assert.deepEqual(db.lockLog.slice(-3), ["collection:shared", "media:source", "import-job:job"]);
  assert.equal(await repo.markMediaImportVerifying({ jobId: "job", lockToken: claim!.lockToken!, now: NOW }), true);
  const copy = makeMedia({ id: "copy", ownerId: "recipient", sizeBytes: sourceBytes.length, title: "Original", kind: "video", mimeType: "video/mp4", importedFromId: "source", checksumSha256: "hash" });
  assert.equal(await repo.finalizeMediaImportJob({ jobId: "job", lockToken: claim!.lockToken!, importerId: "recipient", now: NOW, media: copy, storageKey: claim!.newObjectKey, commitStagedObject: async () => undefined }), "applied");
  assert.equal((await db.mediaImportJob.findUnique({ where: { id: "job" } }))?.["status"], "succeeded");
  assert.equal((await db.mediaAsset.findUnique({ where: { id: "copy" } }))?.["ownerId"], "recipient");
  assert.equal(await db.auditLog.count({ where: { action: "media.import_completed" } }), 1);
});

test("fake-Prisma audit failure rolls back imported media and job success", async () => {
  const { db, repo } = await prismaFixture(); await repo.createOrGetMediaImportJob({ id: "job", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy", idempotencyKey: "import:recipient:source", now: NOW });
  const claim = await repo.claimNextMediaImportJob({ workerId: "worker", now: NOW, leaseSeconds: 60, jobId: "job" }); assert.ok(claim);
  await repo.markMediaImportVerifying({ jobId: "job", lockToken: claim!.lockToken!, now: NOW });
  const original = db.auditLog.create.bind(db.auditLog); db.auditLog.create = async (args) => { if (args.data["action"] === "media.import_completed") throw new Error("audit failure"); return original(args); };
  await assert.rejects(() => repo.finalizeMediaImportJob({ jobId: "job", lockToken: claim!.lockToken!, importerId: "recipient", now: NOW, media: makeMedia({ id: "copy", ownerId: "recipient", sizeBytes: sourceBytes.length, importedFromId: "source" }), storageKey: claim!.newObjectKey, commitStagedObject: async () => undefined }));
  assert.equal(await db.mediaAsset.findUnique({ where: { id: "copy" } }), null);
  assert.equal((await db.mediaImportJob.findUnique({ where: { id: "job" } }))?.["status"], "verifying");
  assert.equal(await db.auditLog.count({ where: { action: "media.import_completed" } }), 0);
});

test("fake-Prisma idempotent replay rechecks a currently valid grant", async () => {
  const { db, repo } = await prismaFixture();
  const first = await repo.createOrGetMediaImportJob({ id: "job", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy", idempotencyKey: "import:recipient:source", now: NOW });
  assert.equal(first.status, "created");
  await db.collectionPermission.updateMany({ where: { collectionId: "shared", granteeId: "recipient" }, data: { status: "revoked", revokedAt: NOW } });
  const replay = await repo.createOrGetMediaImportJob({ id: "job-2", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy-2", idempotencyKey: "import:recipient:source", now: NOW });
  assert.equal(replay.status, "unauthorized");
  assert.equal(await db.mediaImportJob.count({}), 1);
});

test("fake-Prisma failed import retry rechecks grant under user-first locks", async () => {
  const { db, repo } = await prismaFixture();
  await repo.createOrGetMediaImportJob({ id: "job", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy", idempotencyKey: "import:recipient:source", now: NOW });
  const claim = await repo.claimNextMediaImportJob({ workerId: "worker", now: NOW, leaseSeconds: 60, jobId: "job" }); assert.ok(claim);
  assert.equal(await repo.failMediaImportJob({ jobId: "job", lockToken: claim!.lockToken!, now: NOW, reason: "copy failed" }), true);
  await db.collectionPermission.updateMany({ where: { collectionId: "shared", granteeId: "recipient" }, data: { status: "revoked", revokedAt: NOW } });
  db.lockLog.length = 0;
  assert.equal(await repo.retryMediaImportJob("recipient", "job", NOW), false);
  assert.deepEqual(db.lockLog.slice(0, 2), ["user:owner", "user:recipient"]);
  assert.equal((await db.mediaImportJob.findUnique({ where: { id: "job" } }))?.["status"], "failed");
});

test("pending imports block collection deletion and source unlinking in memory and fake Prisma", async () => {
  const memory = memoryFixture(); await queueMemory(memory);
  assert.equal(await memory.repo.replaceCollectionMedia("shared", []), false);
  assert.equal(await memory.repo.deleteCollection("shared"), false);
  assert.ok(await memory.repo.getCollection("shared"));

  const { db, repo } = await prismaFixture();
  await repo.createOrGetMediaImportJob({ id: "job", importerId: "recipient", sourceMediaId: "source", sourceCollectionId: "shared", resultMediaAssetId: "copy", idempotencyKey: "import:recipient:source", now: NOW });
  assert.equal(await repo.replaceCollectionMedia("shared", []), false);
  assert.equal(await repo.deleteCollection("shared"), false);
  assert.ok(await repo.getCollection("shared"));
  assert.equal(await db.collectionItem.count({ where: { collectionId: "shared", mediaAssetId: "source" } }), 1);
});
