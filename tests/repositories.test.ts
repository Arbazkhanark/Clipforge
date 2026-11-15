import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { RenderJobRecord, Repository } from "../src/server/repository.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import { cycleToRow, grantToRow, itemToMutableData, itemToRow, mediaToRow, rowToCollection, rowToGrant, rowToItem, rowToMedia } from "../src/server/prisma/mappers.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { runRepositoryContract, type RepoHarness } from "./contracts/repository.contract.ts";
import { runAuthRepositoryContract } from "./contracts/auth-repository.contract.ts";
import { DEFAULT_EDITING_SETTINGS } from "../src/lib/domain/editing-settings.ts";
import { resolveEffectiveEntitlement } from "../src/lib/billing/entitlement-resolver.ts";
import { makeCycle, makeItem, makeMedia } from "./helpers.ts";

test("fake Prisma bulk settings operation validates ownership and atomically writes video rows with its idempotent audit", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaRepository(client);
  await client.user.create({ data: { id: "bob", email: "bob@example.test" } });
  await client.user.create({ data: { id: "eve", email: "eve@example.test" } });
  await client.mediaAsset.create({ data: mediaToRow(makeMedia({ id: "v1", ownerId: "bob", kind: "video" }), { storageKey: "key-v1", thumbnailKey: null }) });
  await client.mediaAsset.create({ data: mediaToRow(makeMedia({ id: "v2", ownerId: "eve", kind: "video" }), { storageKey: "key-v2", thumbnailKey: null }) });
  const input = {
    ownerId: "bob", operationId: "draft1", operationFingerprint: "a".repeat(64),
    templates: [{ id: "setting1", ownerId: "bob", name: "v:v1", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 2 }, createdAt: new Date("2026-11-09T00:00:00Z") }], expectedSettings: [{ name: "v:v1", settings: null }], requiredImageIds: [],
    audit: { actorId: "bob", action: "editor.bulk_applied", entityType: "BulkEditDraft", entityId: "draft1", metadata: { operationFingerprint: "a".repeat(64), updated: 1 } },
  };
  assert.equal(await repo.applyVideoSettingsBatch(input), "applied");
  assert.equal(await repo.applyVideoSettingsBatch(input), "existing");
  assert.equal(client.editingTemplate.rows.length, 1);
  assert.equal(client.auditLog.rows.length, 1);
  const changed = { ...input, operationFingerprint: "b".repeat(64), audit: { ...input.audit, metadata: { operationFingerprint: "b".repeat(64) } } };
  assert.equal(await repo.applyVideoSettingsBatch(changed), "conflict");
  const stale = { ...input, operationId: "draft-stale", operationFingerprint: "d".repeat(64), templates: [{ ...input.templates[0]!, id: "setting-stale", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 3 } }], expectedSettings: [{ name: "v:v1", settings: DEFAULT_EDITING_SETTINGS }], audit: { ...input.audit, entityId: "draft-stale", metadata: { operationFingerprint: "d".repeat(64) } } };
  assert.equal(await repo.applyVideoSettingsBatch(stale), "conflict");
  assert.equal(client.editingTemplate.rows[0]?.["settings"] && (client.editingTemplate.rows[0]!["settings"] as typeof DEFAULT_EDITING_SETTINGS).zoom, 2);
  const foreign = { ...input, operationId: "draft2", audit: { ...input.audit, entityId: "draft2" }, templates: [{ ...input.templates[0]!, id: "setting2", name: "v:v2" }], expectedSettings: [{ name: "v:v2", settings: null }] };
  assert.equal(await repo.applyVideoSettingsBatch(foreign), "not_owned");
  assert.equal(client.editingTemplate.rows.length, 1);
  assert.deepEqual(client.lockLog.filter((entry) => entry === "user:bob").length, 5);
});

test("fake Prisma bulk settings transaction rolls back on audit failure and serializes concurrent retries", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaRepository(client);
  await client.user.create({ data: { id: "bob", email: "bob@example.test" } });
  await client.mediaAsset.create({ data: mediaToRow(makeMedia({ id: "v1", ownerId: "bob", kind: "video" }), { storageKey: "key-v1", thumbnailKey: null }) });
  await client.mediaAsset.create({ data: mediaToRow(makeMedia({ id: "v2", ownerId: "bob", kind: "video" }), { storageKey: "key-v2", thumbnailKey: null }) });
  const fingerprint = "c".repeat(64);
  const input = {
    ownerId: "bob", operationId: "draft-atomic", operationFingerprint: fingerprint,
    templates: [{ id: "setting-atomic", ownerId: "bob", name: "v:v1", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 2 }, createdAt: new Date("2026-11-09T00:00:00Z") }, { id: "setting-atomic-2", ownerId: "bob", name: "v:v2", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 2 }, createdAt: new Date("2026-11-09T00:00:00Z") }], expectedSettings: [{ name: "v:v1", settings: null }, { name: "v:v2", settings: null }], requiredImageIds: [],
    audit: { actorId: "bob", action: "editor.bulk_applied", entityType: "BulkEditDraft", entityId: "draft-atomic", metadata: { operationFingerprint: fingerprint, updated: 1 } },
  };
  client.auditLog.beforeCreate = () => { throw new Error("simulated audit failure"); };
  await assert.rejects(() => repo.applyVideoSettingsBatch(input));
  assert.equal(client.editingTemplate.rows.length, 0); assert.equal(client.auditLog.rows.length, 0);
  client.auditLog.beforeCreate = null;
  const results = await Promise.all([repo.applyVideoSettingsBatch(input), repo.applyVideoSettingsBatch(input)]);
  assert.deepEqual(results.sort(), ["applied", "existing"]);
  assert.equal(client.editingTemplate.rows.length, 2); assert.equal(client.auditLog.rows.length, 1);
  assert.deepEqual(client.lockLog.filter((entry) => entry === "user:bob").length, 3);
});

test("cycle import unique conflict rolls back earlier order updates", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaRepository(client);
  await repo.createCycle({ ...makeCycle({ id: "cycle-import-atomic", status: "draft", finalReviewConfirmed: false }), name: "Atomic import test", socialAccountId: "account-import-atomic" });
  const first = makeItem({ id: "cycle-item-first", cycleId: "cycle-import-atomic", cycleOwnerId: "bob", sourceKind: "owned", sourceCollectionId: null, position: 1 });
  const existing = makeItem({ id: "cycle-item-existing", cycleId: "cycle-import-atomic", cycleOwnerId: "bob", sourceKind: "owned", sourceCollectionId: null, position: 2 });
  await repo.addCycleItems([first, existing]);

  const duplicate = { ...existing, position: 3, version: 2 };
  const reorderedFirst = { ...first, position: 2, version: 2 };
  assert.equal(await repo.addCycleItems([duplicate], {}, [{ item: reorderedFirst, expectedVersion: 1 }]), false);
  assert.deepEqual((await repo.getCycleItems("cycle-import-atomic")).map(({ id, position, version }) => ({ id, position, version })), [
    { id: "cycle-item-first", position: 1, version: 1 },
    { id: "cycle-item-existing", position: 2, version: 1 },
  ]);
});

function memoryHarness(): RepoHarness {
  const repo = new MemoryRepository();
  return {
    repo,
    seedPlan: async (u, p) => { repo.plans.set(u, p); },
    seedMedia: async (m, keys) => { repo.media.set(m.id, structuredClone(m)); if (keys) { repo.storageKeys.set(m.id, keys.storageKey); repo.thumbnailKeys.set(m.id, keys.thumbnailKey); } },
    seedCollection: async (c) => { repo.collections.set(c.id, structuredClone(c)); },
    seedGrant: async (g) => { repo.grants.push(structuredClone(g)); },
    seedSocialAccount: async (a) => { repo.socialAccounts.set(a.id, a); },
    seedCycle: async (c) => { repo.cycles.set(c.id, c); },
    seedItems: async (items) => { items.forEach((i) => repo.items.set(i.id, structuredClone(i))); },
    seedUsage: async (u, m, usage) => { repo.setUsage(u, m, usage); },
    auditActions: async () => repo.audit.map((a) => a.action), revisionCount: async () => repo.captionRevisions.length,
  };
}

function prismaHarness(): RepoHarness {
  const client = new FakePrismaClient(); let n = 0;
  const repo = new PrismaRepository(client, () => new Date("2026-06-01T12:00:00Z"));
  return {
    repo,
    seedPlan: async (userId, planId) => { const providerSubscriptionId = `sub_${userId}`; await client.subscription.create({ data: { userId, planId, interval: "monthly", status: "active", razorpaySubscriptionId: providerSubscriptionId, currentPeriodEnd: new Date("2026-07-01T12:00:00Z"), lastEventAt: 0n, trialEndsAt: null } }); await client.paymentRecord.create({ data: { userId, providerPaymentId: `pay_${userId}`, providerSubscriptionId, amountPaise: 1, currency: "INR", status: "captured" } }); },
    seedMedia: async (m, keys) => { await client.mediaAsset.create({ data: mediaToRow(m, keys ?? { storageKey: `k/${m.id}`, thumbnailKey: null }) }); },
    seedCollection: async (c) => {
      await client.videoCollection.create({ data: { id: c.id, ownerId: c.ownerId, name: c.name ?? c.id, description: c.description ?? null, visibility: c.visibility, archived: c.archived } });
      for (const [position, mediaAssetId] of c.mediaIds.entries()) await client.collectionItem.create({ data: { collectionId: c.id, mediaAssetId, position } });
    },
    seedGrant: async (g) => { await client.collectionPermission.create({ data: grantToRow(g) }); },
    seedSocialAccount: async (a) => { await client.socialAccount.create({ data: { id: a.id, userId: a.userId, status: a.status, platform: "instagram", externalAccountId: a.id } }); },
    seedCycle: async (c) => { await client.publishingCycle.create({ data: cycleToRow(c) }); },
    seedItems: async (items) => { await client.cycleItem.createMany({ data: items.map(itemToRow) }); },
    seedUsage: async (userId, periodStart, u) => {
      for (const [kind, amount] of [["processing_seconds", u.processingSeconds], ["exports", u.exports], ["scheduled_items", u.scheduledItems]] as const) await client.usageRecord.create({ data: { userId, kind, amount: BigInt(amount), periodStart, idempotencyKey: `seed${++n}` } });
    },
    auditActions: async () => (await client.auditLog.findMany()).map((r) => r["action"]), revisionCount: async () => client.captionRevision.count(),
  };
}

const renderJob = (overrides: Partial<RenderJobRecord> = {}): RenderJobRecord => ({
  id: "r1", ownerId: "alice", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: "m1", progressPercent: 0, attempts: 0,
  idempotencyKey: "render:alice:one", lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: new Date("2026-11-07T00:00:00Z"),
  finishedAt: null, settingsHash: "hash", payload: { aspect: "9:16" }, pendingOutputId: "out1", outputDerivativeId: null,
  lockToken: null, ffmpegPid: null, ffmpegStartedAt: null, ...overrides,
});

async function verifyRenderJobRepository(label: string, repo: Repository, seedOwner: (ownerId: string) => Promise<void>): Promise<void> {
  test(`${label}: durable render job create, lookup, owner isolation, idempotency and lock-checked updates`, async () => {
    const first = renderJob();
    assert.equal((await repo.createRenderJob(first)).status, "created");
    assert.deepEqual(await repo.getRenderJobForOwner("r1", "alice"), first);
    assert.equal(await repo.getRenderJobForOwner("r1", "mallory"), null);
    assert.deepEqual(await repo.getRenderJobByIdempotencyKey(first.idempotencyKey, "alice"), first);
    assert.equal(await repo.getRenderJobByIdempotencyKey(first.idempotencyKey, "mallory"), null);
    assert.deepEqual(await repo.createRenderJob(renderJob({ id: "r2" })), { status: "existing", job: first });
    assert.deepEqual(await repo.createRenderJob(renderJob({ id: "r3", ownerId: "mallory" })), { status: "conflict" });
    await repo.createRenderJob(renderJob({ id: "r4", ownerId: "bob", idempotencyKey: "render:bob:one", createdAt: new Date("2026-11-07T00:02:00Z") }));
    await repo.createRenderJob(renderJob({ id: "r5", ownerId: "alice", idempotencyKey: "render:alice:two", createdAt: new Date("2026-11-07T00:01:00Z") }));
    assert.deepEqual((await repo.listRenderJobsForOwner("alice")).map((job) => job.id), ["r5", "r1"]);
    assert.deepEqual((await repo.listRenderJobsForOwner("bob")).map((job) => job.id), ["r4"]);
    await seedOwner("alice"); await seedOwner("bob");
    const claimed = await repo.claimNextRenderJob({ workerId: "worker-a", now: new Date("2026-11-07T01:00:00Z"), leaseSeconds: 60 });
    assert.ok(claimed); assert.equal(claimed.id, "r1"); assert.equal(claimed.status, "running"); assert.equal(claimed.attempts, 1);
    assert.ok(claimed.lockToken); assert.equal(claimed.lockedBy, "worker-a"); assert.equal(claimed.lockExpiresAt?.toISOString(), "2026-11-07T01:01:00.000Z");
    const token = claimed.lockToken!;
    assert.equal(await repo.heartbeatRenderJob("r1", "alice", "wrong", new Date("2026-11-07T01:00:30Z"), 60), false);
    assert.equal(await repo.heartbeatRenderJob("r1", "alice", token, new Date("2026-11-07T01:00:30Z"), 90), true);
    assert.equal((await repo.getRenderJobForOwner("r1", "alice"))?.lockExpiresAt?.toISOString(), "2026-11-07T01:02:00.000Z");
    assert.equal(await repo.updateRenderJobProgress("r1", "alice", "stale", 45), false);
    assert.equal(await repo.updateRenderJobProgress("r1", "alice", token, 45), true);
    assert.equal(await repo.updateRenderJobProgress("r1", "alice", token, 101), false);
    assert.equal(await repo.completeRenderJob("r1", "alice", "stale", new Date(), "derivative-1"), false);
    assert.equal(await repo.completeRenderJob("r1", "alice", token, new Date("2026-11-07T01:03:00Z"), "derivative-1"), true);
    assert.equal((await repo.getRenderJobForOwner("r1", "alice"))?.status, "succeeded");
    assert.equal(await repo.heartbeatRenderJob("r1", "alice", token, new Date(), 60), false);
    const second = await repo.claimNextRenderJob({ workerId: "worker-b", now: new Date("2026-11-07T01:04:00Z"), leaseSeconds: 60 });
    assert.ok(second); assert.equal(second.id, "r5");
    assert.equal(await repo.failRenderJob(second.id, "alice", second.lockToken!, new Date("2026-11-07T01:05:00Z"), "safe failure"), true);
    const bobJob = await repo.claimNextRenderJob({ workerId: "worker-c", now: new Date("2026-11-07T01:06:00Z"), leaseSeconds: 60 });
    assert.ok(bobJob); assert.equal(bobJob.ownerId, "bob");
    assert.equal(await repo.cancelRenderJob(bobJob.id, "bob", bobJob.lockToken!, new Date("2026-11-07T01:07:00Z")), true);
  });
}

verifyRenderJobRepository("MemoryRepository", new MemoryRepository(), async () => {});
const renderClient = new FakePrismaClient();
verifyRenderJobRepository("PrismaRepository over FAKE client", new PrismaRepository(renderClient), async (ownerId) => {
  await renderClient.user.create({ data: { id: ownerId, email: `${ownerId}@example.test` } });
});

const renderConcurrencyCases: { label: string; setup: () => { repo: Repository; seedOwner(ownerId: string): Promise<void> } }[] = [
  { label: "MemoryRepository (simulated concurrency)", setup: () => { const repo = new MemoryRepository(); return { repo, seedOwner: async () => {} }; } },
  { label: "PrismaRepository over FAKE client (simulated transaction serialization)", setup: () => {
    const client = new FakePrismaClient(); const repo = new PrismaRepository(client);
    return { repo, seedOwner: async (ownerId: string) => { await client.user.create({ data: { id: ownerId, email: `${ownerId}@example.test` } }); } };
  } },
];
for (const { label, setup } of renderConcurrencyCases) {
  test(`${label}: two workers cannot claim the same queued job`, async () => {
    const { repo, seedOwner } = setup(); await seedOwner("alice");
    await repo.createRenderJob(renderJob({ id: `${label}-single`, ownerId: "alice", idempotencyKey: `${label}:single` }));
    const outcomes = await Promise.all(["worker-one", "worker-two"].map((workerId) => repo.claimNextRenderJob({ workerId, now: new Date("2026-11-07T02:30:00Z"), leaseSeconds: 45 })));
    assert.equal(outcomes.filter((job) => job !== null).length, 1);
    const stored = await repo.getRenderJobForOwner(`${label}-single`, "alice");
    assert.equal(stored?.status, "running"); assert.equal(stored?.attempts, 1);
  });
  test(`${label}: claims are exclusive and plan concurrency limits are enforced per user`, async () => {
    const { repo, seedOwner } = setup();
    await seedOwner("alice"); await seedOwner("bob");
    await repo.createRenderJob(renderJob({ id: `${label}-a1`, ownerId: "alice", idempotencyKey: `${label}:a1` }));
    await repo.createRenderJob(renderJob({ id: `${label}-a2`, ownerId: "alice", idempotencyKey: `${label}:a2`, createdAt: new Date("2026-11-07T00:01:00Z") }));
    await repo.createRenderJob(renderJob({ id: `${label}-b1`, ownerId: "bob", idempotencyKey: `${label}:b1`, createdAt: new Date("2026-11-07T00:02:00Z") }));
    const claims = await Promise.all(["w1", "w2", "w3"].map((workerId) => repo.claimNextRenderJob({ workerId, now: new Date("2026-11-07T02:00:00Z"), leaseSeconds: 60 })));
    const claimed = claims.filter((job): job is NonNullable<typeof job> => job !== null);
    assert.equal(claimed.filter((job) => job.ownerId === "alice").length, 1, "free plan permits one running render");
    assert.equal(claimed.filter((job) => job.ownerId === "bob").length, 1, "another account can claim independently");
    assert.equal(claimed.length, 2);
    assert.equal(new Set(claimed.map((job) => job.id)).size, claimed.length);
    assert.equal(new Set(claimed.map((job) => job.lockToken)).size, claimed.length);
    assert.equal(await repo.claimNextRenderJob({ workerId: "w4", now: new Date("2026-11-07T02:00:59Z"), leaseSeconds: 60 }), null);
  });
  test(`${label}: abandoned running jobs are reclaimed after lease expiry with a new fencing token`, async () => {
    const { repo, seedOwner } = setup(); await seedOwner("alice");
    await repo.createRenderJob(renderJob({ id: `${label}-stuck`, ownerId: "alice", status: "running", lockToken: "old-token", lockedBy: "lost-worker", lockExpiresAt: new Date("2020-01-01T00:00:00Z"), idempotencyKey: `${label}:stuck` }));
    const recovered = await repo.claimNextRenderJob({ workerId: "new-worker", now: new Date("2026-11-07T02:00:00Z"), leaseSeconds: 60 });
    assert.equal(recovered?.id, `${label}-stuck`);
    assert.equal(recovered?.status, "running");
    assert.notEqual(recovered?.lockToken, "old-token");
    assert.equal(recovered?.attempts, 1);
    assert.ok(recovered?.pendingOutputId);
  });
}

test("Prisma claim locks the owner before counting and uses a conditional queued-to-running increment", async () => {
  const client = new FakePrismaClient(); const calls: string[] = [];
  const originalRaw = client.$queryRaw.bind(client);
  client.$queryRaw = async (strings, ...values) => { calls.push(`lock:${strings.join("?").includes("FOR UPDATE")}`); return originalRaw(strings, ...values); };
  const originalCount = client.processingJob.count.bind(client.processingJob);
  client.processingJob.count = async (args) => { calls.push("count-running"); return originalCount(args); };
  const seenUpdates: { where: unknown; data: unknown }[] = [];
  const originalUpdateMany = client.processingJob.updateMany.bind(client.processingJob);
  client.processingJob.updateMany = async (args) => { calls.push("claim-update"); seenUpdates.push({ where: args.where, data: args.data }); return originalUpdateMany(args); };
  await client.user.create({ data: { id: "alice", email: "alice@example.test" } });
  const repo = new PrismaRepository(client);
  await repo.createRenderJob(renderJob());
  assert.ok(await repo.claimNextRenderJob({ workerId: "worker", now: new Date("2026-11-07T03:00:00Z"), leaseSeconds: 30 }));
  assert.deepEqual(calls, ["lock:true", "lock:true", "count-running", "claim-update"]);
  assert.deepEqual(seenUpdates[0]?.where, { id: "r1", ownerId: "alice", kind: "render", status: "queued" });
  assert.deepEqual(seenUpdates[0]?.data && (seenUpdates[0].data as Record<string, unknown>)["attempts"], { increment: 1 });
});

runRepositoryContract("MemoryRepository", memoryHarness);
runRepositoryContract("PrismaRepository over FAKE client", prismaHarness);
runAuthRepositoryContract("PrismaAuthRepository over FAKE client", () => new PrismaAuthRepository(new FakePrismaClient()));

// ---------- behaviours specific to the Prisma implementation ----------
test("subscription entitlement preserves the original effectivePlanId status rules for legacy and current rows", async () => {
  const client = new FakePrismaClient(); const T = Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000);
  const repo = new PrismaRepository(client, () => new Date("2026-06-01T12:00:00Z"));
  const sub = (userId: string, status: string, trialEndsAt: number | null, providerSubscriptionId?: string) => client.subscription.create({ data: { userId, planId: "pro", interval: "weekly", status, ...(providerSubscriptionId ? { razorpaySubscriptionId: providerSubscriptionId, currentPeriodEnd: new Date((T + 100) * 1000) } : {}), lastEventAt: 0n, trialEndsAt: trialEndsAt === null ? null : BigInt(trialEndsAt) } });
  await sub("trial", "authenticated", T + 100); await sub("trialOver", "authenticated", T - 1);
  // Previous effectivePlanId only inspected status/trial expiry: these legacy rows have no
  // PaymentRecord and no currentPeriodEnd, but active/pending have always been entitled.
  await sub("activeLegacy", "active", null); await sub("pendingLegacy", "pending", null);
  await sub("activeNoPayment", "active", null, "sub_no_payment");
  await sub("halted", "halted", null); await sub("cancelled", "cancelled", null, "sub_cancelled"); await sub("expired", "expired", null, "sub_expired"); await sub("created", "created", T + 100);
  await client.paymentRecord.create({ data: { userId: "cancelled", providerPaymentId: "pay_cancelled", providerSubscriptionId: "sub_cancelled", amountPaise: 1, currency: "INR", status: "captured" } });
  const plans = Object.fromEntries(await Promise.all(["trial", "trialOver", "activeLegacy", "pendingLegacy", "activeNoPayment", "halted", "cancelled", "expired", "created", "none"].map(async (u) => [u, await repo.getPlanIdForUser(u)])));
  assert.deepEqual(plans, { trial: "pro", trialOver: "free", activeLegacy: "pro", pendingLegacy: "pro", activeNoPayment: "pro", halted: "free", cancelled: "free", expired: "free", created: "free", none: "free" });
});

test("fake-Prisma plan lookup preserves active and pending entitlements with failed payment and no captured payment", async () => {
  const client = new FakePrismaClient();
  const now = new Date("2026-06-01T12:00:00Z");
  const repo = new PrismaRepository(client, () => now);

  for (const status of ["active", "pending"] as const) {
    const userId = `failed-${status}`;
    const providerSubscriptionId = `sub-failed-${status}`;
    await client.subscription.create({ data: {
      userId, planId: "pro", interval: "weekly", status, razorpaySubscriptionId: providerSubscriptionId,
      lastEventAt: 0n, trialEndsAt: null, currentPeriodEnd: null,
    } });
    await client.paymentRecord.create({ data: {
      userId, providerSubscriptionId, providerPaymentId: `pay-failed-${status}`, amountPaise: 1,
      currency: "INR", status: "failed",
    } });

    const expected = resolveEffectiveEntitlement({
      now,
      subscription: {
        planId: "pro", status, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
        hasCapturedPayment: false, hasFailedPayment: true,
      },
    }).planId;
    assert.equal(expected, "pro");
    assert.equal(await repo.getPlanIdForUser(userId, now), expected, `${status} must retain the central resolver's legacy entitlement`);
  }
});

test("the quota insert takes a lock inside ONE transaction before it counts (so concurrent uploads are serialised)", async () => {
  const client = new FakePrismaClient(); const calls: string[] = [];
  const wrapped = Object.create(client) as FakePrismaClient;
  wrapped.$transaction = async (work) => { calls.push("begin"); const r = await client.$transaction(async (tx) => work(Object.assign(Object.create(tx), { $queryRaw: async (s: TemplateStringsArray) => { calls.push(`lock:${s.join("?").includes("FOR UPDATE")}`); return []; } }))); calls.push("end"); return r; };
  const repo = new PrismaRepository(wrapped);
  assert.equal(await repo.addMediaIfStorageWithin(makeMedia({ id: "m1", ownerId: "bob", sizeBytes: 10 }), { storageKey: "k", thumbnailKey: null }, 100), true);
  assert.deepEqual(calls, ["begin", "lock:true", "end"]);
});

test("the template-limit insert also takes the user-row lock inside ONE transaction before it counts", async () => {
  const client = new FakePrismaClient(); const calls: string[] = [];
  const wrapped = Object.create(client) as FakePrismaClient;
  wrapped.$transaction = async (work) => { calls.push("begin"); const r = await client.$transaction(async (tx) => work(Object.assign(Object.create(tx), { $queryRaw: async (s: TemplateStringsArray) => { calls.push(`lock:${s.join("?").includes("FOR UPDATE")}`); return []; } }))); calls.push("end"); return r; };
  const repo = new PrismaRepository(wrapped);
  assert.equal(await repo.createTemplateIfWithinLimit({ id: "t1", ownerId: "bob", name: "N", settings: DEFAULT_EDITING_SETTINGS, createdAt: new Date() }, 3), true);
  assert.deepEqual(calls, ["begin", "lock:true", "end"]);
});

test("every version-checked save is a single conditional UPDATE keyed by id AND version (never a read-then-write)", async () => {
  const client = new FakePrismaClient(); const seen: unknown[] = [];
  const original = client.cycleItem.updateMany.bind(client.cycleItem);
  client.cycleItem.updateMany = async (args) => { seen.push(args.where); return original(args); };
  client.cycleItem.update = async () => { throw new Error("must not use plain update for versioned saves"); };
  const repo = new PrismaRepository(client); await client.cycleItem.create({ data: itemToRow(makeItem({ id: "i1", version: 4 })) });
  await repo.saveCycleItemsIfVersionMatches([{ item: makeItem({ id: "i1", version: 5, captionText: "x" }), expectedVersion: 4 }]);
  assert.deepEqual(seen, [{ id: "i1", version: 4 }]);
});

test("mappers: media, grants, collections and items round-trip; bigint sizes become numbers; missing display fields get safe defaults", () => {
  const m = makeMedia({ id: "m", ownerId: "o", sizeBytes: 5_000_000_000, title: "T", kind: "image", validation: "verified", width: 3, height: 4 });
  const row = mediaToRow(m, { storageKey: "k", thumbnailKey: "t" });
  assert.equal(typeof row["sizeBytes"], "bigint");
  const back = rowToMedia(row); assert.deepEqual([back.sizeBytes, back.title, back.kind, back.validation, back.hasThumbnail, back.width], [5_000_000_000, "T", "image", "verified", true, 3]);
  assert.equal(rowToMedia(mediaToRow(makeMedia({ id: "x" }), { storageKey: "k", thumbnailKey: null })).validation, "incomplete");   // unknown never becomes "verified"
  assert.equal(mediaToRow(makeMedia({ id: "x" }), { storageKey: "k", thumbnailKey: null })["mimeType"], "application/octet-stream");
  const g = { collectionId: "c", granteeId: "u", capabilities: ["view" as const], status: "revoked" as const, expiresAt: null };
  assert.deepEqual(rowToGrant(grantToRow(g)), g);
  assert.deepEqual(rowToCollection({ id: "c", ownerId: "o", visibility: "link", archived: false, name: "N", description: null }, ["a"]), { id: "c", ownerId: "o", visibility: "link", archived: false, mediaIds: ["a"], name: "N", captionMode: "individual", sharedCaptionText: null, coverMode: "individual", sharedCoverMediaId: null, settingsVersion: 1, items: [] });
  const i = makeItem({ id: "i", captionText: "hi", coverState: "saved_internally", coverMediaId: "c" }); assert.deepEqual(rowToItem(itemToRow(i)), i);
  assert.ok(!("id" in itemToMutableData(i)) && !("cycleId" in itemToMutableData(i)) && !("cycleOwnerId" in itemToMutableData(i)));
});

test("a UNIQUE violation is reported as 'email taken', but unrelated database errors are NOT swallowed", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaAuthRepository(client);
  const u = { id: "u1", email: "a@example.com", emailVerifiedAt: null, passwordHash: "h", name: null, role: "user" as const, createdAt: new Date() };
  assert.equal(await repo.createUser(u), true); assert.equal(await repo.createUser({ ...u, id: "u2" }), false);
  client.user.create = async () => { throw new Error("connection lost"); };
  await assert.rejects(() => repo.createUser({ ...u, id: "u3", email: "z@example.com" }), /connection lost/);
});

test("public password and Google user inserts omit caller-supplied role and use the normal-user database default", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaAuthRepository(client);
  const inserts: Record<string, unknown>[] = [];
  const originalCreate = client.user.create.bind(client.user);
  client.user.create = async ({ data }) => {
    inserts.push(structuredClone(data));
    // Model the PostgreSQL DEFAULT for User.role in this fake-Prisma test.
    return originalCreate({ data: { role: "user", ...data } });
  };
  const now = new Date("2026-11-11T00:00:00Z");
  const passwordUser = { id: "public-password", email: "password@example.test", emailVerifiedAt: null, passwordHash: "hash", name: null, role: "admin" as const, createdAt: now };
  assert.equal(await repo.createUser(passwordUser), true);
  assert.equal(inserts[0]?.["role"], undefined);
  assert.equal(client.user.rows.find((row) => row["id"] === passwordUser.id)?.["role"], "user");

  const googleUser = { id: "public-google", email: "google@example.test", emailVerifiedAt: now, passwordHash: null, name: null, role: "admin" as const, createdAt: now };
  assert.equal(await repo.createGoogleUser(googleUser, { id: "google-identity", userId: googleUser.id, googleSub: "google-sub-public", createdAt: now }), "created");
  assert.equal(inserts[1]?.["role"], undefined);
  assert.equal(client.user.rows.find((row) => row["id"] === googleUser.id)?.["role"], "user");
});

test("duplicate Google subject rolls back the new user insert and never deletes an existing user", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaAuthRepository(client);
  const now = new Date("2026-11-11T00:00:00Z");
  await client.user.create({ data: { id: "google-owner", email: "owner@example.test", role: "user" } });
  await client.googleIdentity.create({ data: { id: "existing-identity", userId: "google-owner", googleSub: "already-linked", createdAt: now } });

  let rollbacks = 0;
  client.afterTransactionRollback = () => { rollbacks++; };
  let deleteCalls = 0;
  client.user.deleteMany = async () => { deleteCalls++; return { count: 0 }; };
  const candidate = { id: "new-google-user", email: "new@example.test", emailVerifiedAt: now, passwordHash: null, name: null, role: "admin" as const, createdAt: now };
  const result = await repo.createGoogleUser(candidate, { id: "new-identity", userId: candidate.id, googleSub: "already-linked", createdAt: now });

  assert.equal(result, "sub_taken");
  assert.equal(rollbacks, 1);
  assert.equal(client.user.rows.some((row) => row["id"] === candidate.id), false);
  assert.deepEqual(client.user.rows.map((row) => row["id"]), ["google-owner"]);
  assert.equal(client.googleIdentity.rows.length, 1);
  assert.equal(deleteCalls, 0);

  // A collision on user email/id must not make the duplicate-subject handler
  // delete that pre-existing row while reporting sub_taken.
  await client.user.create({ data: { id: "preexisting-candidate", email: "preexisting@example.test", role: "user" } });
  const existing = client.user.rows.find((row) => row["id"] === "preexisting-candidate");
  assert.ok(existing);
  const collision = await repo.createGoogleUser(
    { id: "preexisting-candidate", email: "preexisting@example.test", emailVerifiedAt: null, passwordHash: null, name: null, role: "admin", createdAt: now },
    { id: "collision-identity", userId: "preexisting-candidate", googleSub: "already-linked", createdAt: now },
  );
  assert.equal(collision, "sub_taken");
  assert.equal(client.user.rows.some((row) => row["id"] === "preexisting-candidate"), true);
  assert.equal(client.user.rows.find((row) => row["id"] === "preexisting-candidate")?.["email"], "preexisting@example.test");
  assert.equal(deleteCalls, 0);
});

test("password reset rolls back the new password and the used token when session revocation fails", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaAuthRepository(client);
  const now = new Date("2026-06-01T12:00:00Z");
  await repo.createUser({ id: "u1", email: "a@example.com", emailVerifiedAt: now, passwordHash: "old", name: null, role: "user", createdAt: now });
  await repo.createSession({ id: "s1", userId: "u1", tokenHash: "th", createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + 60_000), revokedAt: null });
  await repo.createAuthToken({ id: "t1", userId: "u1", kind: "password_reset", tokenHash: "reset", expiresAt: new Date(now.getTime() + 60_000), usedAt: null, createdAt: now });
  client.session.updateMany = async () => { throw new Error("revocation failed"); };
  await assert.rejects(() => repo.completePasswordReset({ tokenHash: "reset", now, passwordHash: "new", passwordProblems: () => [] }), /revocation failed/);
  assert.equal((await repo.getUserById("u1"))!.passwordHash, "old");
  assert.equal((await repo.getSessionByTokenHash("th"))!.revokedAt, null);
  assert.equal((await client.authToken.findUnique({ where: { tokenHash: "reset" } }))!["usedAt"], null);
});
