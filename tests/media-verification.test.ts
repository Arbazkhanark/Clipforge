import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { runNextMediaVerificationJob } from "../src/server/media-verification.ts";
import { mediaVerificationRoute } from "../src/server/media-verification-route.ts";
import { mediaKeyFor, stagingKeyFor } from "../src/server/storage/media-storage.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { mediaVerificationLoadingCopy } from "../src/components/MediaVerificationStatus.tsx";
import type { MediaVerificationJobRecord } from "../src/server/repository.ts";
import type { Runtime } from "../src/server/runtime.ts";

const now = new Date("2026-11-15T12:00:00.000Z");
test("status polling failures are visible and indicate automatic retry", () => {
  assert.deepEqual(mediaVerificationLoadingCopy(false), { label: "Checking", description: "Verification status is loading." });
  assert.deepEqual(mediaVerificationLoadingCopy(true), { label: "Status unavailable", description: "Verification status could not be loaded. Retrying automatically." });
});

const mp4 = new Uint8Array([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0x69,0x73,0x6f,0x6d,0x6d,0x70,0x34,0x31,1,2,3,4,5,6,7,8]);

async function fixture(options: { probe?: null | ((filePath: string) => Promise<{ width: number; height: number; durationSeconds: number }>) } = {}) {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage(); const ownerId = "owner"; const mediaId = "asset1";
  const stagingKey = stagingKeyFor(mediaId); const storageKey = mediaKeyFor(ownerId, mediaId);
  await storage.stage(stagingKey, mp4); await storage.commit(stagingKey, storageKey);
  const media = { id: mediaId, ownerId, status: "active" as const, sizeBytes: mp4.length, deleteAfter: null, title: "clip.mp4", kind: "video" as const, durationMs: 1_000, width: 160, height: 120, createdAt: now, validation: "incomplete" as const, mimeType: "video/mp4", hasThumbnail: false, checksumSha256: createHash("sha256").update(mp4).digest("hex") };
  const job: MediaVerificationJobRecord = { id: "job1", ownerId, mediaAssetId: mediaId, status: "queued", progressPercent: 0, attempts: 0, idempotencyKey: `media-verification:${mediaId}`, lockedBy: null, lockToken: null, lockExpiresAt: null, errorMessage: null, createdAt: now, finishedAt: null, payload: { stage: "queued", outcome: "processing", completedStages: ["uploaded_to_storage"], updatedAt: now.toISOString(), thumbnailStatus: "skipped" } };
  const audit = { actorId: ownerId, action: "media.uploaded", entityType: "MediaAsset", entityId: mediaId, metadata: { validation: "processing" } };
  assert.equal(await repo.addMediaWithVerificationJobIfStorageWithin(media, { storageKey, thumbnailKey: null }, job, audit, 1_000_000), true);
  const ctx = { userId: null, now, repo, newId: () => "unused", config: { coverSupport: "unknown" as const }, media: { storage, probe: options.probe === undefined ? async () => ({ width: 160, height: 120, durationSeconds: 1 }) : options.probe, maxUploadBytes: 10_000 } };
  return { repo, storage, job, ctx, mediaId, storageKey, media };
}

test("verification reads the committed private object, checks size and SHA-256, probes media, then marks verified", async () => {
  const f = await fixture();
  assert.equal(await runNextMediaVerificationJob(f.ctx, "worker-a"), "verified");
  const stored = await f.repo.getMedia(f.mediaId);
  assert.equal(stored?.validation, "verified");
  assert.equal(stored?.width, 160);
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.status, "verified");
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.thumbnailStatus, "skipped");
  assert.equal((await f.repo.getMediaVerificationForOwner("other", f.mediaId)), null);
});

test("missing committed object and checksum mismatch fail closed without marking media verified", async () => {
  const missing = await fixture(); await missing.storage.deleteUnreferencedUpload(missing.storageKey);
  assert.equal(await runNextMediaVerificationJob(missing.ctx, "worker-a"), "failed");
  assert.equal((await missing.repo.getMedia(missing.mediaId))?.validation, "incomplete");
  assert.equal((await missing.repo.getMediaVerificationForOwner("owner", missing.mediaId))?.errorCode, "storage_missing");

  const mismatch = await fixture();
  mismatch.repo.media.get(mismatch.mediaId)!.checksumSha256 = "0".repeat(64);
  assert.equal(await runNextMediaVerificationJob(mismatch.ctx, "worker-a"), "failed");
  assert.equal((await mismatch.repo.getMedia(mismatch.mediaId))?.validation, "incomplete");
  assert.equal((await mismatch.repo.getMediaVerificationForOwner("owner", mismatch.mediaId))?.errorCode, "storage_checksum_mismatch");
});

test("temporary storage failure is retried with bounded backoff and successful retry verifies the same object", async () => {
  const f = await fixture();
  const original = f.storage.getPrivateMetadata.bind(f.storage); let fail = true;
  f.storage.getPrivateMetadata = async (key) => { if (fail) { fail = false; throw new Error("synthetic storage outage"); } return original(key); };
  assert.equal(await runNextMediaVerificationJob(f.ctx, "worker-a"), "failed");
  const queued = f.repo.mediaVerificationJobs.get(f.job.id)!;
  assert.equal(queued.status, "queued"); assert.equal(queued.attempts, 1);
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.status, "processing");
  assert.equal(await runNextMediaVerificationJob({ ...f.ctx, now: new Date(Date.now() + 60_000) }, "worker-b"), "verified");
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.status, "verified");
});

test("owner can manually retry a retryable failure, while concurrent or non-retryable retries are refused", async () => {
  const f = await fixture();
  const original = f.storage.getPrivateMetadata.bind(f.storage);
  f.storage.getPrivateMetadata = async () => { throw new Error("synthetic storage outage"); };
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal(await runNextMediaVerificationJob({ ...f.ctx, now: new Date(Date.now() + 60_000 * attempt) }, `worker-${attempt}`), "failed");
  assert.equal(f.repo.mediaVerificationJobs.get(f.job.id)?.status, "failed");
  assert.equal(await f.repo.retryMediaVerification("owner", f.mediaId, new Date()), "queued");
  assert.equal(await f.repo.retryMediaVerification("owner", f.mediaId, new Date()), "existing");
  assert.equal(await f.repo.retryMediaVerification("someone-else", f.mediaId, new Date()), "missing");
  f.storage.getPrivateMetadata = original;
  assert.equal(await runNextMediaVerificationJob({ ...f.ctx, now: new Date(Date.now() + 60_000) }, "worker-final"), "verified");
});

test("duplicate job creation is rejected and concurrent workers can claim a job only once", async () => {
  const f = await fixture();
  const audit = { actorId: "owner", action: "media.uploaded", entityType: "MediaAsset", entityId: f.mediaId };
  assert.equal(await f.repo.addMediaWithVerificationJobIfStorageWithin(f.media, { storageKey: f.storageKey, thumbnailKey: null }, { ...f.job, id: "job2" }, audit, 1_000_000), false);
  const claims = await Promise.all(["w1", "w2"].map((workerId) => f.repo.claimNextMediaVerificationJob({ workerId, now, leaseSeconds: 60 })));
  assert.equal(claims.filter(Boolean).length, 1);
});

test("expired worker lease is reclaimed after interruption and completes under the new lock", async () => {
  const f = await fixture();
  const first = await f.repo.claimNextMediaVerificationJob({ workerId: "interrupted", now, leaseSeconds: 1 }); assert.ok(first);
  const recoveredAt = new Date(now.getTime() + 2_000);
  assert.equal(await runNextMediaVerificationJob({ ...f.ctx, now: recoveredAt }, "recovery-worker"), "verified");
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.status, "verified");
  assert.equal(f.repo.mediaVerificationJobs.get(f.job.id)?.attempts, 2);
});

test("expired jobs after multiple worker interruptions remain reclaimable until the bounded attempt limit", async () => {
  const f = await fixture();
  const interrupted = { ...f.repo.mediaVerificationJobs.get(f.job.id)!, status: "running" as const, attempts: 3, lockedBy: "dead-worker", lockToken: "old-fence", lockExpiresAt: new Date(now.getTime() - 1) };
  f.repo.mediaVerificationJobs.set(f.job.id, interrupted);
  const reclaimed = await f.repo.claimNextMediaVerificationJob({ workerId: "replacement", now, leaseSeconds: 60 });
  assert.equal(reclaimed?.attempts, 4);
  assert.notEqual(reclaimed?.lockToken, "old-fence");

  const exhausted = { ...reclaimed!, attempts: 6, lockExpiresAt: new Date(now.getTime() - 1) };
  f.repo.mediaVerificationJobs.set(f.job.id, exhausted);
  assert.equal(await f.repo.claimNextMediaVerificationJob({ workerId: "too-late", now, leaseSeconds: 60 }), null);
  const final = f.repo.mediaVerificationJobs.get(f.job.id)!;
  assert.equal(final.status, "failed");
  assert.equal((final.payload as Record<string, unknown>)?.["retryable"], false);
  assert.equal(await f.repo.retryMediaVerification("owner", f.mediaId, now), "not_retryable");
});

test("failure at the maximum attempt count is not shown as manually retryable", async () => {
  const f = await fixture();
  const job = f.repo.mediaVerificationJobs.get(f.job.id)!;
  f.repo.mediaVerificationJobs.set(f.job.id, { ...job, attempts: 5 });
  f.storage.getPrivateMetadata = async () => { throw new Error("synthetic storage outage"); };
  assert.equal(await runNextMediaVerificationJob(f.ctx, "worker-final-attempt"), "failed");
  const state = await f.repo.getMediaVerificationForOwner("owner", f.mediaId);
  assert.equal(state?.status, "failed");
  assert.equal(state?.retryable, false);
  assert.equal(await f.repo.retryMediaVerification("owner", f.mediaId, now), "not_retryable");
});

test("status and retry API stay owner-scoped and reject cross-site retry requests", async () => {
  const f = await fixture();
  const makeRuntime = (userId: string | null) => ({ mode: "local" as const, repo: f.repo, currentUserId: async () => userId, newId: () => "unused", now: () => now }) as Runtime;
  const ownerRoute = mediaVerificationRoute(() => makeRuntime("owner"));
  const otherRoute = mediaVerificationRoute(() => makeRuntime("other-user"));
  const read = await ownerRoute.GET(new Request(`http://localhost/api/media/verification?ids=${f.mediaId}`));
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { items: { mediaId: string; status: string }[] }).items[0]?.status, "processing");
  const hidden = await otherRoute.GET(new Request(`http://localhost/api/media/verification?ids=${f.mediaId}`));
  assert.deepEqual((await hidden.json() as { items: unknown[] }).items, []);
  const crossSite = await ownerRoute.POST(new Request("http://localhost/api/media/verification", { method: "POST", headers: { origin: "https://attacker.invalid", host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ mediaId: f.mediaId }) }));
  assert.equal(crossSite.status, 403);
  const anonymous = await mediaVerificationRoute(() => makeRuntime(null)).GET(new Request(`http://localhost/api/media/verification?ids=${f.mediaId}`));
  assert.equal(anonymous.status, 401);
});

test("probe unavailable remains incomplete and never promotes media to verified", async () => {
  const f = await fixture({ probe: null });
  await runNextMediaVerificationJob(f.ctx, "worker-a");
  assert.equal((await f.repo.getMedia(f.mediaId))?.validation, "incomplete");
  assert.equal((await f.repo.getMediaVerificationForOwner("owner", f.mediaId))?.errorCode, "media_probe_unavailable");
});
