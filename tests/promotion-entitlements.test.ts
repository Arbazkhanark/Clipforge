import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { PromotionalAccessGrantRecord } from "../src/server/repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const now = new Date("2026-11-08T12:00:00.000Z");
const day = 86_400_000;
const activeGrant = (planId: PromotionalAccessGrantRecord["planId"], status: PromotionalAccessGrantRecord["status"] = "active"): PromotionalAccessGrantRecord => ({
  id: "grant", promotionId: "promo", userId: "owner", redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status, planId, durationDays: 3, queueSequence: 1n,
  startsAt: status === "active" ? new Date(now.getTime() - 1) : null, expiresAt: status === "active" ? new Date(now.getTime() + day) : null,
  activatedAt: status === "active" ? new Date(now.getTime() - 1) : null, revokedAt: null, grantedByAdminId: "admin", reason: null, createdAt: now, updatedAt: now,
});

for (const [label, setup] of [
  ["memory", async () => {
    const repo = new MemoryRepository(); repo.setUserRole("owner", "user");
    repo.razorpaySubscriptions.set("sub", { userId: "owner", planId: "creator", interval: "monthly", status: "active", lastEventAt: 0, currentPeriodEnd: new Date(now.getTime() + day) });
    repo.razorpayPayments.set("pay", { userId: "owner", intentId: "intent", amountPaise: 1, currency: "INR", status: "captured", providerSubscriptionId: "sub" });
    repo.promotionalAccessGrants.set("grant", activeGrant("pro"));
    return { repo, grant: (value: PromotionalAccessGrantRecord) => repo.promotionalAccessGrants.set(value.id, value), stored: () => repo.promotionalAccessGrants.get("grant") };
  }],
  ["fake Prisma", async () => {
    const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } });
    await db.subscription.create({ data: { id: "sub-row", userId: "owner", planId: "creator", interval: "monthly", status: "active", currentPeriodEnd: new Date(now.getTime() + day), cancelAtPeriodEnd: false, razorpaySubscriptionId: "sub", trialEndsAt: null } });
    await db.paymentRecord.create({ data: { userId: "owner", providerSubscriptionId: "sub", providerPaymentId: "pay", amountPaise: 1, currency: "INR", status: "captured" } });
    await db.promotionalAccessGrant.create({ data: { ...activeGrant("pro"), queueSequence: 1n } });
    return { repo: new PrismaRepository(db), grant: async (value: PromotionalAccessGrantRecord) => db.promotionalAccessGrant.update({ where: { id: value.id }, data: value }), stored: async () => db.promotionalAccessGrant.findUnique({ where: { id: "grant" } }) };
  }],
] as const) {
  test(`${label}: effective plan uses the highest valid tier and promotion expiry returns the paid plan`, async () => {
    const state = await setup();
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "pro");
    const ended = activeGrant("agency"); ended.expiresAt = now;
    await state.grant(ended);
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "creator");
  });
}

for (const [label, setup] of [
  ["memory", async () => { const repo = new MemoryRepository(); repo.setUserRole("owner", "user"); return { repo, setSub: (status: "active" | "halted" | "cancelled") => repo.razorpaySubscriptions.set("sub", { userId: "owner", planId: "creator", interval: "weekly", status, lastEventAt: 1 }), setGrant: (grant: PromotionalAccessGrantRecord) => repo.promotionalAccessGrants.set(grant.id, grant) }; }],
  ["fake Prisma", async () => { const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } }); await db.subscription.create({ data: { id: "sub-row", userId: "owner", planId: "creator", interval: "weekly", status: "active", lastEventAt: 1n, currentPeriodEnd: null, razorpaySubscriptionId: null, cancelAtPeriodEnd: false, trialEndsAt: null } }); return { repo: new PrismaRepository(db), setSub: (status: "active" | "halted" | "cancelled") => db.subscription.update({ where: { id: "sub-row" }, data: { status } }), setGrant: (grant: PromotionalAccessGrantRecord) => db.promotionalAccessGrant.create({ data: grant }) }; }],
] as const) {
  test(`${label}: inconsistent active deferred grant cannot override active or unresolved subscription state`, async () => {
    const state = await setup();
    const deferred = activeGrant("agency"); deferred.activationPolicy = "after_current_access";
    await state.setGrant(deferred);
    // The previous effectivePlanId contract treats active/pending as entitled without a
    // PaymentRecord or currentPeriodEnd; malformed/missing period metadata cannot end access.
    await state.setSub("active");
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "creator");
    await state.setSub("halted");
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "free", "unresolved provider state fails closed for the promotion");
    await state.setSub("cancelled");
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "agency", "a terminal cancelled state permits the valid deferred grant");
  });

  test(`${label}: deferred grant with inconsistent activation fields is ignored`, async () => {
    const state = await setup(); await state.setSub("cancelled");
    const deferred = activeGrant("agency"); deferred.activationPolicy = "after_current_access"; deferred.activatedAt = null;
    await state.setGrant(deferred);
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "free");
  });
}

test("Prisma repository safely preserves paid-only entitlements when promotion tables are not present yet", async () => {
  const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } });
  await db.subscription.create({ data: { id: "sub-row", userId: "owner", planId: "creator", interval: "monthly", status: "active", currentPeriodEnd: new Date(now.getTime() + day), cancelAtPeriodEnd: false, razorpaySubscriptionId: "sub", trialEndsAt: null } });
  await db.paymentRecord.create({ data: { userId: "owner", providerSubscriptionId: "sub", providerPaymentId: "pay", amountPaise: 1, currency: "INR", status: "captured" } });
  db.promotionalAccessGrant.findFirst = async () => { throw Object.assign(new Error("promotion table absent in an older database"), { code: "P2021", meta: { table: "public.PromotionalAccessGrant" } }); };
  const repo = new PrismaRepository(db);
  assert.equal(await repo.getPlanIdForUser("owner", now), "creator");
});

for (const [label, setup] of [
  ["memory", async () => { const repo = new MemoryRepository(); repo.setUserRole("owner", "user"); return repo; }],
  ["fake Prisma", async () => { const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } }); return new PrismaRepository(db); }],
] as const) {
  test(`${label}: Instagram account cap allows reconnecting the same account but blocks an additional one`, async () => {
    const repo = await setup();
    const connection = (id: string, externalAccountId: string) => ({ id, userId: "owner", externalAccountId, username: null, accountType: "BUSINESS" as const, grantedScopes: ["instagram_business_basic"], tokenExpiresAt: new Date(now.getTime() + day), encryptedAccessToken: "ciphertext-only-test-value" });
    assert.deepEqual(await repo.saveInstagramConnectionWithinLimit(connection("account-1", "meta-1"), now), { status: "saved", accountId: "account-1" });
    assert.deepEqual(await repo.saveInstagramConnectionWithinLimit(connection("account-new-id", "meta-1"), now), { status: "saved", accountId: "account-1" });
    assert.deepEqual(await repo.saveInstagramConnectionWithinLimit(connection("account-2", "meta-2"), now), { status: "limit" });
  });
}

const renderJob = (id: string, createdAt: Date): import("../src/server/repository.ts").RenderJobRecord => ({
  id, ownerId: "owner", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: `media-${id}`, progressPercent: 0, attempts: 0,
  idempotencyKey: `render-${id}`, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt, finishedAt: null, settingsHash: null, payload: null,
  pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
});

for (const [label, setup] of [
  ["memory", async () => {
    const repo = new MemoryRepository(); repo.setUserRole("owner", "user"); repo.promotionalAccessGrants.set("grant", activeGrant("creator"));
    return { repo, seed: async () => {}, status: async () => "" };
  }],
  ["fake Prisma", async () => {
    const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } });
    await db.promotionalAccessGrant.create({ data: activeGrant("creator") });
    return { repo: new PrismaRepository(db), seed: async () => {}, status: async () => "" };
  }],
] as const) {
  test(`${label}: promotional plan increases render concurrency using catalog limits`, async () => {
    const state = await setup();
    await state.repo.createRenderJob(renderJob("r1", now));
    await state.repo.createRenderJob(renderJob("r2", new Date(now.getTime() + 1)));
    const first = await state.repo.claimNextRenderJob({ workerId: "w1", now, leaseSeconds: 60 });
    const second = await state.repo.claimNextRenderJob({ workerId: "w2", now: new Date(now.getTime() + 1), leaseSeconds: 60 });
    assert.ok(first); assert.ok(second, "Creator's catalog concurrency cap is 2; Free's is 1");
  });
}

for (const [label, setup] of [
  ["memory", async () => {
    const repo = new MemoryRepository(); repo.setUserRole("owner", "user");
    repo.razorpaySubscriptions.set("sub", { userId: "owner", planId: "pro", interval: "weekly", status: "active", lastEventAt: 1, currentPeriodEnd: new Date(now.getTime() + 7 * day) });
    repo.razorpayPayments.set("pay", { userId: "owner", intentId: "intent", amountPaise: 1, currency: "INR", status: "captured", providerSubscriptionId: "sub" });
    const grant = activeGrant("agency", "queued"); grant.activationPolicy = "after_current_access"; repo.promotionalAccessGrants.set("grant", grant);
    return { repo, status: () => repo.promotionalAccessGrants.get("grant")?.status };
  }],
  ["fake Prisma", async () => {
    const db = new FakePrismaClient(); await db.user.create({ data: { id: "owner", role: "user" } });
    await db.subscription.create({ data: { id: "sub-row", userId: "owner", planId: "pro", interval: "weekly", status: "active", currentPeriodEnd: new Date(now.getTime() + 7 * day), cancelAtPeriodEnd: false, razorpaySubscriptionId: "sub", trialEndsAt: null } });
    await db.paymentRecord.create({ data: { userId: "owner", providerSubscriptionId: "sub", providerPaymentId: "pay", amountPaise: 1, currency: "INR", status: "captured" } });
    const grant = activeGrant("agency", "queued"); grant.activationPolicy = "after_current_access"; await db.promotionalAccessGrant.create({ data: grant });
    return { repo: new PrismaRepository(db), status: async () => (await db.promotionalAccessGrant.findUnique({ where: { id: "grant" } }))?.["status"] };
  }],
] as const) {
  test(`${label}: renewed paid period keeps a deferred promotion queued and does not consume its duration`, async () => {
    const state = await setup();
    assert.equal(await state.repo.getPlanIdForUser("owner", now), "pro");
    assert.equal(await state.status(), "queued");
  });
}
