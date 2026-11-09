import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { createMockPublishingAdapters, createPublishingWorker, type PublishingAdapters } from "../src/server/publishing/publishing-worker.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { itemToRow } from "../src/server/prisma/mappers.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { makeCycle, makeItem, NOW } from "./helpers.ts";
import type { PreflightReport } from "../src/lib/domain/preflight.ts";
import type { Repository, SocialAccountRecord } from "../src/server/repository.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { HmacTemporaryMediaAccessAdapter, MockTemporaryMediaAccessAdapter } from "../src/server/storage/temporary-media-access.ts";

const future = new Date(NOW.getTime() + 3_600_000);
const readyPreflight: PreflightReport = { overall: "ready", canStart: true, checks: [] };
const blockedPreflight: PreflightReport = { overall: "blocked", canStart: false, checks: [{ id: "instagram_public_url", level: "blocked", message: "No public media URL is available.", itemIds: ["item1"] }] };

async function fixture(overrides: { cycleStatus?: "draft" | "running"; accountStatus?: "connected" | "token_expired" | "revoked" | "disconnected"; selectedRenderOutputId?: string | null } = {}) {
  const repo = new MemoryRepository();
  await repo.createCycle({ ...makeCycle({ id: "cycle1", ownerId: "bob", status: overrides.cycleStatus ?? "running", finalReviewConfirmed: true }), name: "Campaign", socialAccountId: "acct1" });
  const selectedOutputId = overrides.selectedRenderOutputId !== undefined ? overrides.selectedRenderOutputId : "render-output-1";
  repo.items.set("item1", makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", selectedRenderOutputId: selectedOutputId, status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1000), captionText: "Mock caption" }));
  repo.media.set("media1", { id: "media1", ownerId: "bob", status: "active", sizeBytes: 1000, deleteAfter: null, title: "Source video", kind: "video", durationMs: 5000, createdAt: NOW, width: 1080, height: 1920, validation: "verified", mimeType: "video/mp4" });
  if (selectedOutputId) {
    repo.renders.set(selectedOutputId, { id: selectedOutputId, sourceMediaId: "media1", ownerId: "bob", storageKey: `render/bob/${selectedOutputId}`, sizeBytes: 2000, settingsHash: "hash1", createdAt: NOW });
  }
  repo.socialAccounts.set("acct1", { id: "acct1", userId: "bob", platform: "instagram", status: overrides.accountStatus ?? "connected", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: future });
  return repo;
}

function worker(repo: Repository, options: { adapters?: PublishingAdapters; enabled?: boolean; workerId?: string; requirePublicMedia?: boolean; storage?: import("../src/server/storage/media-storage.ts").MediaStorage | null; mediaAccess?: import("../src/server/storage/temporary-media-access.ts").TemporaryMediaAccessAdapter | null; preflight?: (candidate: Parameters<NonNullable<import("../src/server/publishing/publishing-worker.ts").PublishingWorkerOptions["preflight"]>>[0]) => Promise<PreflightReport>; cancellationRequested?: import("../src/server/publishing/publishing-worker.ts").PublishingWorkerOptions["cancellationRequested"] } = {}) {
  return createPublishingWorker({ repo, enabled: options.enabled ?? true, workerId: options.workerId ?? "worker-1", requirePublicMedia: options.requirePublicMedia, adapters: options.adapters ?? createMockPublishingAdapters(), storage: options.storage, mediaAccess: options.mediaAccess, now: () => NOW, newId: () => "attempt1", leaseSeconds: 90, preflight: options.preflight ? (candidate) => options.preflight!(candidate) : async () => readyPreflight, cancellationRequested: options.cancellationRequested });
}

test("worker is disabled by default and does not claim or call adapters", async () => {
  const repo = await fixture(); let calls = 0;
  const adapters = createMockPublishingAdapters(); adapters.createContainer = async () => { calls += 1; return { kind: "ambiguous" }; };
  const result = await createPublishingWorker({ repo, adapters, now: () => NOW, newId: () => "attempt1" }).runOnce();
  assert.deepEqual(result, { status: "disabled" }); assert.equal(calls, 0); assert.equal(repo.publishingJobs.size, 0);
});

test("worker completes a terminal cycle and queues an automatic repeat as an unstarted draft", async () => {
  const repo = await fixture();
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, repeatBehavior: "automatic" });
  let createCalls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "definite_failure", category: "container_rejected" } });
  adapters.createContainer = async () => { createCalls += 1; return { kind: "definite_failure", category: "container_rejected" }; };

  const result = await worker(repo, { adapters }).runOnce();

  assert.equal(result.status, "failed");
  assert.equal(createCalls, 1);
  assert.equal(repo.cycles.get("cycle1")?.status, "completed");
  const next = [...repo.cycles.values()].find((cycle) => cycle.id !== "cycle1");
  assert.ok(next);
  assert.equal(next.status, "draft");
  assert.equal(repo.items.get("item1")?.status, "failed");
  const nextItems = [...repo.items.values()].filter((item) => item.cycleId === next.id);
  assert.equal(nextItems.length, 1);
  assert.equal(nextItems[0]?.status, "upcoming");
  assert.equal(nextItems[0]?.scheduledFor, null);
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.completed").length, 1);
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.repeat_queued").length, 1);
});

test("mock workflow follows container create, poll, publish order and stores only the supplied mock confirmation", async () => {
  const repo = await fixture(); const calls: string[] = [];
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "mock-container-1" }, containerStatus: { kind: "ready" }, publishing: { kind: "confirmed", instagramMediaId: "mock-media-1" } });
  adapters.createContainer = async (input) => { calls.push(`create:${input.cycleItemId}`); assert.equal("lockToken" in input, false); return { kind: "created", containerId: "mock-container-1" }; };
  adapters.pollContainer = async (input) => { calls.push(`poll:${input.containerId}`); return { kind: "ready" }; };
  adapters.publishContainer = async (input) => { calls.push(`publish:${input.containerId}`); return { kind: "confirmed", instagramMediaId: "mock-media-1" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "published");
  assert.deepEqual(calls, ["create:item1", "poll:mock-container-1", "publish:mock-container-1"]);
  assert.equal(repo.publishingJobs.get("attempt1")?.stage, "published");
  assert.equal(repo.items.get("item1")?.externalPostId, "mock-media-1");
  assert.equal(JSON.stringify(repo.publishingJobs.get("attempt1")).includes("ig-token"), false);
});

test("a full or unverifiable account quota never calls media_publish and retains the ready attempt", async () => {
  for (const publishingQuota of [{ kind: "limit_reached", usage: 25, total: 25, durationSeconds: 86_400 } as const, { kind: "unknown" } as const]) {
    const repo = await fixture(); let publishCalls = 0;
    const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "quota-container" }, containerStatus: { kind: "ready" }, publishingQuota });
    adapters.publishContainer = async () => { publishCalls++; return { kind: "confirmed", instagramMediaId: "must-not-publish" }; };
    assert.equal((await worker(repo, { adapters }).runOnce()).status, "blocked");
    assert.equal(publishCalls, 0);
    assert.equal(repo.publishingJobs.get("attempt1")?.stage, "ready_to_publish");
    assert.equal(repo.items.get("item1")?.externalPostId, null);
  }
});

test("a selected JPEG cover is passed as a public scoped URL before container creation", async () => {
  const repo = await fixture(); const storage = new MemoryMediaStorage();
  const renderKey = "render/bob/render-output-1"; const renderBytes = new Uint8Array([1, 2, 3]);
  await storage.stage("staging/render", renderBytes); await storage.commit("staging/render", renderKey);
  repo.renders.set("render-output-1", { ...repo.renders.get("render-output-1")!, storageKey: renderKey, sizeBytes: renderBytes.length });
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0]); const coverKey = "media/bob/cover1";
  repo.media.set("cover1", { id: "cover1", ownerId: "bob", status: "active", sizeBytes: coverBytes.length, deleteAfter: null, title: "Cover", kind: "image", mimeType: "image/jpeg", createdAt: NOW, durationMs: null, width: 1, height: 1, validation: "verified" });
  repo.storageKeys.set("cover1", coverKey);
  await storage.stage("staging/cover", coverBytes); await storage.commit("staging/cover", coverKey);
  repo.items.set("item1", { ...repo.items.get("item1")!, coverMediaId: "cover1" });
  const mediaAccess = new HmacTemporaryMediaAccessAdapter("https://clipforge.example.test", Buffer.alloc(32, 7));
  let received: import("../src/server/publishing/publishing-worker.ts").PublishingAdapterInput | undefined;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "cover-container" }, containerStatus: { kind: "ready" }, publishing: { kind: "confirmed", instagramMediaId: "mock-post" } });
  adapters.createContainer = async (input) => { received = input; return { kind: "created", containerId: "cover-container" }; };
  assert.equal((await worker(repo, { adapters, storage, mediaAccess, requirePublicMedia: true }).runOnce()).status, "published");
  assert.equal(received?.coverSelected, true);
  assert.match(received?.coverUrl ?? "", /^https:\/\/clipforge\.example\.test\/api\/publishing-covers\//);
});

test("an invalid or unavailable selected cover blocks before any container request", async () => {
  for (const mode of ["missing", "wrong-owner", "wrong-format", "missing-object"] as const) {
    const repo = await fixture(); const storage = new MemoryMediaStorage();
    const coverKey = "media/bob/cover1";
    repo.media.set("cover1", { id: "cover1", ownerId: mode === "wrong-owner" ? "mallory" : "bob", status: "active", sizeBytes: 4, deleteAfter: null, title: "Cover", kind: mode === "wrong-format" ? "image" : "image", mimeType: mode === "wrong-format" ? "image/png" : "image/jpeg", createdAt: NOW, durationMs: null, width: 1, height: 1, validation: "verified" });
    if (mode !== "missing") repo.items.set("item1", { ...repo.items.get("item1")!, coverMediaId: "cover1" });
    if (mode !== "missing-object") {
      repo.storageKeys.set("cover1", coverKey);
      await storage.stage("staging/cover", new Uint8Array([0xff, 0xd8, 0xff, 0])); await storage.commit("staging/cover", coverKey);
    }
    let createCalls = 0;
    const adapters = createMockPublishingAdapters(); adapters.createContainer = async () => { createCalls++; return { kind: "created", containerId: "unexpected" }; };
    const result = await worker(repo, { adapters, storage, mediaAccess: new HmacTemporaryMediaAccessAdapter("https://clipforge.example.test", Buffer.alloc(32, 7)), requirePublicMedia: true }).runOnce();
    assert.equal(result.status, "blocked", mode);
    assert.equal(createCalls, 0, mode);
    assert.equal(repo.publishingJobs.size, 0, mode);
  }
});

test("missing publishing prerequisites stop before an attempt or adapter call", async () => {
  const repo = await fixture(); let calls = 0;
  const adapters = createMockPublishingAdapters(); adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters, preflight: async () => blockedPreflight }).runOnce();
  assert.equal(result.status, "blocked"); assert.equal(repo.publishingJobs.size, 0); assert.equal(calls, 0);
});

test("worker refuses unsupported account types, unknown status, missing scope/token, and expired credentials before creating an attempt", async () => {
  const badAccounts: Partial<SocialAccountRecord>[] = [
    { accountType: "PERSONAL" }, { accountType: "UNKNOWN" }, { accountType: undefined },
    { status: "unknown" as never }, { grantedScopes: ["instagram_business_basic"] }, { grantedScopes: ["instagram_business_basic", "instagram_business_content_publish", "bad!scope"] },
    { hasToken: false }, { tokenExpiresAt: new Date(NOW.getTime() - 1) },
  ];
  for (const change of badAccounts) {
    const repo = await fixture();
    repo.socialAccounts.set("acct1", { ...repo.socialAccounts.get("acct1")!, ...change });
    let calls = 0;
    const result = await worker(repo, { adapters: { ...createMockPublishingAdapters(), async createContainer() { calls += 1; return { kind: "ambiguous" }; } } }).runOnce();
    assert.equal(result.status, "blocked");
    assert.equal(repo.publishingJobs.size, 0);
    assert.equal(calls, 0);
  }
});

test("stored account ineligibility is rechecked by atomic claim", async () => {
  const repo = await fixture({ accountStatus: "token_expired" }); let calls = 0;
  const adapters = createMockPublishingAdapters(); adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked"); assert.equal(calls, 0); assert.equal(repo.items.get("item1")?.status, "scheduled");
});

test("definite container creation failure terminates without polling or publishing", async () => {
  const repo = await fixture(); let calls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "definite_failure", category: "container_rejected" } });
  adapters.pollContainer = async () => { calls += 1; return { kind: "ready" }; };
  adapters.publishContainer = async () => { calls += 1; return { kind: "ambiguous" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "failed"); assert.equal(calls, 0); assert.equal(repo.items.get("item1")?.status, "failed");
});

test("container processing failure is recorded as definite failure", async () => {
  const repo = await fixture(); let publishCalls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, containerStatus: { kind: "definite_failure", category: "container_rejected" } });
  adapters.publishContainer = async () => { publishCalls += 1; return { kind: "confirmed", instagramMediaId: "must-not-persist" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "failed"); assert.equal(publishCalls, 0); assert.equal(repo.items.get("item1")?.externalPostId, null);
});

test("processing containers renew the lease and resume polling without recreating the container", async () => {
  const repo = await fixture(); let createCalls = 0, pollCalls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, publishing: { kind: "confirmed", instagramMediaId: "mock-media" } });
  adapters.createContainer = async () => { createCalls += 1; return { kind: "created", containerId: "container-1" }; };
  adapters.pollContainer = async () => { pollCalls += 1; return pollCalls === 1 ? { kind: "processing" } : { kind: "ready" }; };
  const instance = worker(repo, { adapters });
  assert.equal((await instance.runOnce()).status, "processing");
  assert.equal((await instance.runOnce()).status, "published");
  assert.equal(createCalls, 1); assert.equal(pollCalls, 2);
});

test("a definite publishing failure is terminal and does not trigger an automatic retry", async () => {
  const repo = await fixture(); let publishCalls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, containerStatus: { kind: "ready" }, publishing: { kind: "definite_failure", category: "publish_rejected" } });
  adapters.publishContainer = async () => { publishCalls += 1; return { kind: "definite_failure", category: "publish_rejected" }; };
  assert.equal((await worker(repo, { adapters }).runOnce()).status, "failed");
  assert.equal((await worker(repo, { adapters, workerId: "worker-2" }).runOnce()).status, "idle");
  assert.equal(publishCalls, 1);
});

test("ambiguous publish is verified once, moved to review, and never automatically published again", async () => {
  const repo = await fixture(); let publishCalls = 0, verifyCalls = 0;
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, containerStatus: { kind: "ready" }, publishing: { kind: "ambiguous" }, verification: { kind: "unknown" } });
  adapters.publishContainer = async () => { publishCalls += 1; return { kind: "ambiguous" }; };
  adapters.verifyPublishingResult = async () => { verifyCalls += 1; return { kind: "unknown" }; };
  assert.equal((await worker(repo, { adapters }).runOnce()).status, "needs_manual_review");
  assert.equal((await worker(repo, { adapters, workerId: "worker-2" }).runOnce()).status, "idle");
  assert.equal(publishCalls, 1); assert.equal(verifyCalls, 1); assert.equal(repo.items.get("item1")?.status, "needs_review");
});

test("an expired lease is moved to manual review without calling an adapter", async () => {
  const repo = await fixture();
  const attempt = await repo.createOrGetPublishingAttempt({ id: "attempt1", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", socialAccountId: "acct1", attemptNumber: 1, idempotencyKey: "publish:cycle1:item1:1", now: NOW });
  assert.ok(attempt.job);
  const claimed = await repo.claimPublishingAttempt({ attemptId: "attempt1", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", socialAccountId: "acct1", expectedItemVersion: 1, workerId: "dead-worker", now: NOW, leaseSeconds: 1 });
  assert.ok(claimed);
  repo.publishingJobs.set(claimed.id, { ...claimed, leaseExpiresAt: new Date(NOW.getTime() - 1) });
  const result = await worker(repo).runOnce();
  assert.equal(result.status, "needs_manual_review"); assert.equal(repo.publishingJobs.get("attempt1")?.stage, "needs_manual_review");
});

test("a slow adapter cannot commit after its lease expires and is never replayed", async () => {
  const repo = await fixture(); let timestamp = NOW, createCalls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { createCalls += 1; timestamp = new Date(NOW.getTime() + 11_000); return { kind: "created", containerId: "container-1" }; };
  const instance = createPublishingWorker({ repo, enabled: true, workerId: "worker-1", adapters, now: () => timestamp, newId: () => "attempt1", leaseSeconds: 10, preflight: async () => readyPreflight });
  assert.equal((await instance.runOnce()).status, "skipped");
  assert.equal((await instance.runOnce()).status, "needs_manual_review");
  assert.equal(createCalls, 1); assert.equal(repo.publishingJobs.get("attempt1")?.stage, "needs_manual_review");
});

test("duplicate runOnce calls on one worker do not duplicate adapter execution", async () => {
  const repo = await fixture(); let calls = 0; let release!: () => void; let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, containerStatus: { kind: "ready" }, publishing: { kind: "confirmed", instagramMediaId: "mock-media" } });
  adapters.createContainer = async () => { calls += 1; entered(); await hold; return { kind: "created", containerId: "container-1" }; };
  const instance = worker(repo, { adapters });
  const first = instance.runOnce(); await enteredPromise;
  assert.equal((await instance.runOnce()).status, "busy"); release();
  assert.equal((await first).status, "published"); assert.equal(calls, 1);
});

test("different worker instances racing for one due item reach one mock adapter execution in memory", async () => {
  const repo = await fixture(); let calls = 0;
  const makeAdapters = () => {
    const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "container-1" }, containerStatus: { kind: "ready" }, publishing: { kind: "confirmed", instagramMediaId: "mock-media" } });
    adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "container-1" }; };
    return adapters;
  };
  const results = await Promise.all([worker(repo, { workerId: "worker-a", adapters: makeAdapters() }).runOnce(), worker(repo, { workerId: "worker-b", adapters: makeAdapters() }).runOnce()]);
  assert.equal(results.filter((result) => result.status === "published").length, 1);
  assert.equal(calls, 1);
});

test("fake-Prisma worker path exercises repository candidate lookup and transactional claiming (simulated only)", async () => {
  const client = new FakePrismaClient();
  await client.socialAccount.create({ data: { id: "acct1", userId: "bob", status: "connected", platform: "instagram", externalAccountId: "external", accountType: "BUSINESS", grantedScopes: "instagram_business_basic instagram_business_content_publish", encryptedAccessToken: "test-ciphertext", tokenExpiresAt: future } });
  await client.publishingCycle.create({ data: { id: "cycle1", ownerId: "bob", socialAccountId: "acct1", name: "Campaign", status: "running", finalReviewConfirmed: true, timezone: "Asia/Kolkata", scheduleSettings: {} } });
  await client.mediaAsset.create({ data: { id: "media1", ownerId: "bob", status: "active", sizeBytes: 1000n, title: "Source", kind: "video", storageKey: "media/bob/media1", createdAt: NOW } });
  await client.mediaDerivative.create({ data: { id: "render1", ownerId: "bob", mediaAssetId: "media1", kind: "render", sizeBytes: 2000n, storageKey: "render/bob/render1", settingsHash: "h1", createdAt: NOW } });
  await client.cycleItem.create({ data: itemToRow(makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", selectedRenderOutputId: "render1", status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1000) })) });
  const repo = new PrismaRepository(client);
  const adapters = createMockPublishingAdapters({ containerCreation: { kind: "created", containerId: "mock-container" }, containerStatus: { kind: "ready" }, publishing: { kind: "confirmed", instagramMediaId: "mock-media" } });
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "published");
  assert.equal((await client.publishingJob.findUnique({ where: { id: "attempt1" } }))?.["stage"], "published");
  assert.equal((await client.cycleItem.findUnique({ where: { id: "item1" } }))?.["externalPostId"], "mock-media");
});

test("cancellation is honored while queued or claimed, before container creation", async () => {
  const queuedRepo = await fixture(); let queuedCalls = 0;
  const queuedResult = await worker(queuedRepo, { cancellationRequested: async (_candidate, stage) => stage === "queued", adapters: { ...createMockPublishingAdapters(), async createContainer() { queuedCalls += 1; return { kind: "created", containerId: "no" }; } } }).runOnce();
  assert.equal(queuedResult.status, "cancelled"); assert.equal(queuedRepo.publishingJobs.get("attempt1")?.stage, "cancelled"); assert.equal(queuedCalls, 0);

  const claimedRepo = await fixture(); let claimedCalls = 0;
  const claimedResult = await worker(claimedRepo, { cancellationRequested: async (_candidate, stage) => stage === "claimed", adapters: { ...createMockPublishingAdapters(), async createContainer() { claimedCalls += 1; return { kind: "created", containerId: "no" }; } } }).runOnce();
  assert.equal(claimedResult.status, "cancelled"); assert.equal(claimedRepo.publishingJobs.get("attempt1")?.stage, "cancelled"); assert.equal(claimedRepo.items.get("item1")?.status, "scheduled"); assert.equal(claimedCalls, 0);
});

test("a stopped cycle is not reopened when its already-claimed safe-stage work is cancelled", async () => {
  const repo = await fixture();
  const result = await worker(repo, { cancellationRequested: async (_candidate, stage) => {
    if (stage === "claimed") repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "stopped" });
    return stage === "claimed";
  } }).runOnce();
  assert.equal(result.status, "cancelled"); assert.equal(repo.items.get("item1")?.status, "cancelled");
});

test("valid selected render output reaches mock container creation adapter with renderOutputId", async () => {
  const repo = await fixture({ selectedRenderOutputId: "valid-render-123" });
  let receivedRenderOutputId: string | undefined;
  let receivedMediaAssetId: string | undefined;
  const adapters = createMockPublishingAdapters({
    containerCreation: { kind: "created", containerId: "c-1" },
    containerStatus: { kind: "ready" },
    publishing: { kind: "confirmed", instagramMediaId: "ig-media-123" },
  });
  adapters.createContainer = async (input) => {
    receivedRenderOutputId = input.renderOutputId;
    receivedMediaAssetId = input.mediaAssetId;
    return { kind: "created", containerId: "c-1" };
  };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "published");
  assert.equal(receivedRenderOutputId, "valid-render-123");
  assert.equal(receivedMediaAssetId, "media1");
  assert.notEqual(receivedRenderOutputId, receivedMediaAssetId);
});

test("missing render selection blocks before adapter is called and leaves attempt uncreated", async () => {
  const repo = await fixture({ selectedRenderOutputId: null });
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("wrong owner on selected render output blocks before adapter is called", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-mallory" });
  repo.renders.set("render-mallory", {
    id: "render-mallory",
    sourceMediaId: "media1",
    ownerId: "mallory",
    storageKey: "render/mallory/render-mallory",
    sizeBytes: 2000,
    settingsHash: "h-mallory",
    createdAt: NOW,
  });
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("wrong source media on selected render output blocks before adapter is called", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-wrong-src" });
  repo.renders.set("render-wrong-src", {
    id: "render-wrong-src",
    sourceMediaId: "other-media-999",
    ownerId: "bob",
    storageKey: "render/bob/render-wrong-src",
    sizeBytes: 2000,
    settingsHash: "h-wrong-src",
    createdAt: NOW,
  });
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("missing or failed render derivative blocks before adapter is called", async () => {
  const repo = await fixture({ selectedRenderOutputId: "nonexistent-derivative" });
  repo.renders.delete("nonexistent-derivative");
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("render output missing from configured storage blocks before adapter is called", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-storage-missing" });
  const storage = new MemoryMediaStorage();
  // Storage has no object committed under "render/bob/render-storage-missing"
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters, storage }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("original media is never used as fallback for publishing", async () => {
  // item.selectedRenderOutputId set to original media asset id
  const repo = await fixture({ selectedRenderOutputId: "media1" });
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "created", containerId: "never" }; };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(result.itemId, "item1");
  assert.equal(calls, 0);
  assert.equal(repo.publishingJobs.size, 0);
});

test("re-rendering does not change selected output, and worker continues using explicit selection", async () => {
  const repo = await fixture({ selectedRenderOutputId: "first-render" });
  repo.renders.set("first-render", {
    id: "first-render",
    sourceMediaId: "media1",
    ownerId: "bob",
    storageKey: "render/bob/first-render",
    sizeBytes: 1500,
    settingsHash: "settings-v1",
    createdAt: NOW,
  });
  // Simulate a subsequent render job finishing later for the same source media
  repo.renders.set("rerender-v2", {
    id: "rerender-v2",
    sourceMediaId: "media1",
    ownerId: "bob",
    storageKey: "render/bob/rerender-v2",
    sizeBytes: 1600,
    settingsHash: "settings-v2",
    createdAt: new Date(NOW.getTime() + 10_000),
  });
  // Cycle item explicitly remains pointing to first-render
  assert.equal(repo.items.get("item1")?.selectedRenderOutputId, "first-render");

  let usedOutputId: string | undefined;
  const adapters = createMockPublishingAdapters({
    containerCreation: { kind: "created", containerId: "c-1" },
    containerStatus: { kind: "ready" },
    publishing: { kind: "confirmed", instagramMediaId: "ig-media-1" },
  });
  adapters.createContainer = async (input) => {
    usedOutputId = input.renderOutputId;
    return { kind: "created", containerId: "c-1" };
  };
  const result = await worker(repo, { adapters }).runOnce();
  assert.equal(result.status, "published");
  assert.equal(usedOutputId, "first-render");
  assert.notEqual(usedOutputId, "rerender-v2");
});

test("temporary media access adapter provides short-lived URL for the selected output", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-with-url" });
  const storage = new MemoryMediaStorage();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const storageKey = "render/bob/render-with-url";
  repo.renders.set("render-with-url", {
    id: "render-with-url",
    sourceMediaId: "media1",
    ownerId: "bob",
    storageKey,
    sizeBytes: bytes.length,
    settingsHash: "h-url",
    createdAt: NOW,
  });
  await storage.stage("staging/r1", bytes);
  await storage.commit("staging/r1", storageKey);

  const mediaAccess = new MockTemporaryMediaAccessAdapter();
  let receivedVideoUrl: string | undefined;
  let receivedRenderId: string | undefined;
  const adapters = createMockPublishingAdapters({
    containerCreation: { kind: "created", containerId: "c-1" },
    containerStatus: { kind: "ready" },
    publishing: { kind: "confirmed", instagramMediaId: "ig-media-1" },
  });
  adapters.createContainer = async (input) => {
    receivedVideoUrl = input.videoUrl;
    receivedRenderId = input.renderOutputId;
    return { kind: "created", containerId: "c-1" };
  };

  const result = await worker(repo, { adapters, storage, mediaAccess }).runOnce();
  assert.equal(result.status, "published");
  assert.equal(receivedRenderId, "render-with-url");
  assert.ok(receivedVideoUrl);
  assert.match(receivedVideoUrl!, /^https:\/\/media-access\.mock\.invalid\//);
});

test("production mode refuses mock temporary URLs before contacting the publishing adapter", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-strict-public" });
  const storage = new MemoryMediaStorage();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const storageKey = "render/bob/render-strict-public";
  repo.renders.set("render-strict-public", { id: "render-strict-public", sourceMediaId: "media1", ownerId: "bob", storageKey, sizeBytes: bytes.length, settingsHash: "strict", createdAt: NOW });
  await storage.stage("staging/strict", bytes);
  await storage.commit("staging/strict", storageKey);
  let calls = 0;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { calls += 1; return { kind: "ambiguous" }; };
  const result = await worker(repo, { adapters, storage, mediaAccess: new MockTemporaryMediaAccessAdapter(), requirePublicMedia: true }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(calls, 0);
});

test("failure before container creation cancels claimed attempt safely without leaving publishing job active", async () => {
  const repo = await fixture({ selectedRenderOutputId: "render-deleted-after-claim" });
  const storage = new MemoryMediaStorage();
  const bytes = new Uint8Array([1, 2, 3]);
  const storageKey = "render/bob/render-deleted-after-claim";
  repo.renders.set("render-deleted-after-claim", {
    id: "render-deleted-after-claim",
    sourceMediaId: "media1",
    ownerId: "bob",
    storageKey,
    sizeBytes: bytes.length,
    settingsHash: "h-del",
    createdAt: NOW,
  });
  await storage.stage("staging/r-del", bytes);
  await storage.commit("staging/r-del", storageKey);

  // Pre-seed an attempt in claimed state
  const attempt = await repo.createOrGetPublishingAttempt({
    id: "attempt-claimed",
    ownerId: "bob",
    cycleId: "cycle1",
    cycleItemId: "item1",
    socialAccountId: "acct1",
    attemptNumber: 1,
    idempotencyKey: "publish:cycle1:item1:1",
    now: NOW,
  });
  assert.ok(attempt.job);
  const claimed = await repo.claimPublishingAttempt({
    attemptId: "attempt-claimed",
    ownerId: "bob",
    cycleId: "cycle1",
    cycleItemId: "item1",
    socialAccountId: "acct1",
    expectedItemVersion: 1,
    workerId: "worker-1",
    now: NOW,
    leaseSeconds: 90,
  });
  assert.ok(claimed);

  // Now simulate storage deletion of the render output after claim
  await storage.deleteUnreferencedUpload(storageKey);

  let containerCalled = false;
  const adapters = createMockPublishingAdapters();
  adapters.createContainer = async () => { containerCalled = true; return { kind: "created", containerId: "never" }; };

  const result = await worker(repo, { adapters, storage }).runOnce();
  assert.equal(result.status, "blocked");
  assert.equal(containerCalled, false);
  // Claim was cancelled safely
  assert.equal(repo.publishingJobs.get("attempt-claimed")?.stage, "cancelled");
  assert.equal(repo.items.get("item1")?.status, "scheduled");
});
