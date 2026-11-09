import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import type { ManualPaymentIntentRecord, PromotionRecord } from "../src/server/repository.ts";

const T0 = new Date("2026-11-08T10:00:00.000Z");
const day = 86_400_000;

function promotion(id: string, over: Partial<PromotionRecord> = {}): PromotionRecord {
  return { id, type: "tier_access", status: "active", code: null, discountType: null, discountValue: null, accessPlanId: "creator", durationDays: 3,
    eligiblePlanIds: [], targetUserId: "user-a", startsAt: new Date(T0.getTime() - day), expiresAt: null, usageLimit: null, createdByAdminId: "admin-a", reason: "support courtesy",
    createdAt: T0, updatedAt: T0, ...over };
}
async function memory(): Promise<MemoryRepository> {
  const repo = new MemoryRepository(); repo.setUserRole("admin-a", "admin"); repo.setUserRole("user-a", "user"); repo.setUserRole("user-b", "user"); return repo;
}
async function prisma(): Promise<{ repo: PrismaRepository; db: FakePrismaClient }> {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "admin-a", role: "admin" } });
  await db.user.create({ data: { id: "user-a", role: "user" } });
  await db.user.create({ data: { id: "user-b", role: "user" } });
  return { repo: new PrismaRepository(db), db };
}
async function promotionRepository(kind: "memory" | "fake Prisma") {
  if (kind === "memory") {
    const repo = await memory();
    return {
      repo,
      failAudit: () => { repo.beforePromotionEventInsert = (event) => event.eventType !== "promotion_updated"; },
      failStatusAudit: (eventType: "promotion_updated" | "promotion_paused") => { repo.beforePromotionEventInsert = (event) => event.eventType !== eventType; },
      snapshotHistory: async (promotionId: string) => structuredClone({
        redemptions: [...repo.promotionRedemptions.values()].filter((row) => row.promotionId === promotionId),
        grants: [...repo.promotionalAccessGrants.values()].filter((row) => row.promotionId === promotionId),
      }),
      snapshotAudit: () => structuredClone(repo.audit),
      setStatus: async (id: string, status: "draft" | "active" | "paused") => { const row = repo.promotions.get(id); if (row) repo.promotions.set(id, { ...row, status }); },
      seedHistory: async (promotionId: string) => { repo.promotionRedemptions.set("history", { id: "history", promotionId, userId: "user-a", status: "released", idempotencyKey: "history", planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null, manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: T0, redeemedAt: null, releasedAt: T0, createdAt: T0, updatedAt: T0 }); },
      seedGrantHistory: async (promotionId: string) => { repo.promotionalAccessGrants.set("history-grant", { id: "history-grant", promotionId, userId: "user-a", redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status: "revoked", planId: "creator", durationDays: 3, queueSequence: 1n, startsAt: T0, expiresAt: T0, activatedAt: T0, revokedAt: T0, grantedByAdminId: "admin-a", reason: null, createdAt: T0, updatedAt: T0 }); },
    };
  }
  const { repo, db } = await prisma();
  return {
    repo,
    failAudit: () => { db.auditLog.beforeCreate = () => { throw new Error("injected audit failure"); }; },
    failStatusAudit: () => { db.auditLog.beforeCreate = () => { throw new Error("injected audit failure"); }; },
    snapshotHistory: async (promotionId: string) => structuredClone({
      redemptions: await db.promotionRedemption.findMany({ where: { promotionId } }),
      grants: await db.promotionalAccessGrant.findMany({ where: { promotionId } }),
    }),
    snapshotAudit: async () => structuredClone(await db.auditLog.findMany()),
    setStatus: async (id: string, status: "draft" | "active" | "paused") => { await db.promotion.update({ where: { id }, data: { status } }); },
    seedHistory: async (promotionId: string) => { await db.promotionRedemption.create({ data: { id: "history", promotionId, userId: "user-a" } }); },
    seedGrantHistory: async (promotionId: string) => { await db.promotionalAccessGrant.create({ data: { id: "history-grant", promotionId, userId: "user-a" } }); },
  };
}
async function seedDiscountIntent(repo: MemoryRepository | PrismaRepository, id: string): Promise<void> {
  const intent = { id, userId: "user-a", idempotencyKey: `intent-${id}`, providerPaymentLinkId: null, checkoutUrl: null, planId: "creator", interval: "weekly", amountPaise: 24_950, currency: "INR", status: "creating", accessStartsAt: null, accessEndsAt: null, errorCategory: null, createdAt: T0, updatedAt: T0 };
  if (repo instanceof MemoryRepository) repo.manualPaymentIntents.set(id, intent as ManualPaymentIntentRecord);
  else await (repo as unknown as { db: FakePrismaClient }).db.manualPaymentIntent.create({ data: intent });
}
const coupon = (id: string, over: Partial<PromotionRecord> = {}) => promotion(id, {
  type: "discount_coupon", code: "SAVE50", accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"],
  discountType: "percentage", discountValue: 50, targetUserId: null, usageLimit: 1, ...over,
});
const discountInput = (id: string, userId = "user-a", over: Record<string, unknown> = {}) => ({
  id, promotionId: "coupon", userId, idempotencyKey: `idem-${id}`, planId: "creator" as const, interval: "weekly" as const,
  listPricePaise: 49_900, discountPaise: 24_950, payablePaise: 24_950, now: T0, ...over,
});

for (const [label, setup] of [["memory", memory], ["fake Prisma", async () => (await prisma()).repo]] as const) {
  test(`${label}: promotion usage counts and paginated history are coupon-scoped and status-accurate`, async () => {
    const repo = await setup();
    assert.equal(await repo.createPromotion(coupon("coupon")), true);
    assert.deepEqual(await repo.getPromotionUsageCounts(["coupon", "missing"]), {
      coupon: { reserved: 0, redeemed: 0, released: 0, manualReview: 0 },
      missing: { reserved: 0, redeemed: 0, released: 0, manualReview: 0 },
    });
    const statuses = ["reserved", "redeemed", "released", "manual_review"] as const;
    for (let index = 0; index < statuses.length; index += 1) {
      const row = { id: `redemption-${index}`, promotionId: "coupon", userId: `user-${index}`, status: statuses[index]!, idempotencyKey: `secret-key-${index}`, planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR", manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: T0, redeemedAt: null, releasedAt: null, createdAt: new Date(T0.getTime() + index), updatedAt: new Date(T0.getTime() + index) };
      if (repo instanceof MemoryRepository) repo.promotionRedemptions.set(row.id, row as import("../src/server/repository.ts").PromotionRedemptionRecord);
      else await (repo as unknown as { db: FakePrismaClient }).db.promotionRedemption.create({ data: row });
    }
    assert.deepEqual(await repo.getPromotionUsageCounts(["coupon"]), { coupon: { reserved: 1, redeemed: 1, released: 1, manualReview: 1 } });
    const first = await repo.listPromotionRedemptionHistory("coupon", { skip: 0, take: 2 });
    assert.deepEqual(first.items.map((row) => row.id), ["redemption-3", "redemption-2"]);
    assert.equal(first.total, 4);
    assert.equal("idempotencyKey" in first.items[0]!, false);
    assert.deepEqual(await repo.listPromotionRedemptionHistory("coupon", { skip: -1, take: 2 }), { items: [], total: 0 });

    assert.equal(await repo.createPromotionLifecycleEvent({ id: "event-1", eventKey: "promotion:coupon:updated", eventType: "promotion_updated", promotionId: "coupon", actorUserId: "admin-a", occurredAt: T0, metadata: { status: "draft" } }), "created");
    const events = await repo.listPromotionLifecycleHistory("coupon", { skip: 0, take: 10 });
    assert.equal(events.total, 2, "the existing creation event is preserved alongside the added update event");
    const updatedEvent = events.items.find((event) => event.eventType === "promotion_updated");
    assert.ok(updatedEvent);
    assert.equal(updatedEvent.auditId === null, repo instanceof MemoryRepository, "memory has no durable audit IDs; fake Prisma links the matching audit row");
    assert.equal("eventKey" in updatedEvent, false);
    assert.equal("metadata" in updatedEvent, false);
    assert.deepEqual(await repo.listPromotionLifecycleHistory("coupon", { skip: 0, take: 0 }), { items: [], total: 0 });
  });

  test(`${label}: coupon listing search, filters, and stable ordering match`, async () => {
    const repo = await setup();
    await repo.createPromotion(coupon("coupon-b", { code: "SAVE50", status: "draft", updatedAt: T0 }));
    await repo.createPromotion(coupon("coupon-a", { code: "SAVE25", status: "active", updatedAt: T0 }));
    await repo.createPromotion(coupon("free-code", { type: "free_access_coupon", code: "SAVEFREE", discountType: null, discountValue: null, eligiblePlanIds: [], accessPlanId: "pro", durationDays: 3, status: "active", updatedAt: T0 }));
    await repo.createPromotion(promotion("internal-grant", { status: "active", updatedAt: T0 }));

    const all = await repo.listPromotions({ skip: 0, take: 10 });
    assert.deepEqual(all.items.map((item) => item.id), ["coupon-a", "coupon-b", "free-code"]);
    assert.equal(all.total, 3, "non-coupon promotions are not in the Offers collection");
    const found = await repo.listPromotions({ skip: 0, take: 10, search: "save" });
    assert.deepEqual(found.items.map((item) => item.id), ["coupon-a", "coupon-b", "free-code"]);
    assert.equal((await repo.listPromotions({ skip: 0, take: 10, type: "discount_coupon" })).total, 2);
    assert.equal((await repo.listPromotions({ skip: 0, take: 10, status: "draft" })).total, 1);
    assert.deepEqual((await repo.listPromotions({ skip: 1, take: 1 })).items.map((item) => item.id), ["coupon-b"]);
  });

  test(`${label}: getPromotion returns consistent PromotionRecord fields and null when missing`, async () => {
    const repo = await setup();
    const record = coupon("coupon");
    assert.equal(await repo.createPromotion(record), true);
    assert.deepEqual(await repo.getPromotion("coupon"), record);
    assert.equal(await repo.getPromotion("missing"), null);
  });

  test(`${label}: promotion listing rejects invalid pagination consistently`, async () => {
    const repo = await setup();
    for (const query of [
      { skip: -1, take: 10 }, { skip: Number.NaN, take: 10 }, { skip: 0, take: 0 }, { skip: 0, take: 101 },
    ]) assert.deepEqual(await repo.listPromotions(query), { items: [], total: 0 });
  });

  test(`${label}: admin-only promotion creation, canonical code lookup, and atomic creation event`, async () => {
    const repo = await setup();
    const record = coupon("coupon");
    assert.equal(await repo.createPromotion(record), true);
    assert.equal(await repo.createPromotion(record), true);
    assert.equal((await repo.getPromotionByCode("  save50 "))?.id, "coupon");
    assert.equal(await repo.createPromotion({ ...coupon("bad-code", { createdByAdminId: "user-a" }) }), false);
    const events = await repo.listPromotionLifecycleEvents("coupon");
    assert.deepEqual(events.map((event) => event.eventKey), ["promotion:coupon:created"]);
  });

  test(`${label}: coupon reservation is idempotent, owner-bound, price-checked, and single use`, async () => {
    const repo = await setup(); await repo.createPromotion(coupon("coupon"));
    assert.equal((await repo.createOrGetPromotionRedemption(discountInput("r1"))).status, "created");
    assert.equal((await repo.createOrGetPromotionRedemption(discountInput("r1"))).status, "existing");
    assert.equal((await repo.createOrGetPromotionRedemption(discountInput("r-other-user", "user-b"))).status, "conflict");
    assert.equal((await repo.createOrGetPromotionRedemption(discountInput("r-wrong-amount", "user-a", { discountPaise: 49_900, payablePaise: 0 }))).status, "conflict");
    assert.deepEqual((await repo.listPromotionLifecycleEvents("coupon")).map((event) => event.eventType), ["promotion_created", "coupon_reserved"]);
  });

  test(`${label}: released reservation may be retried, manual review keeps the slot held`, async () => {
    const repo = await setup(); await repo.createPromotion(coupon("coupon"));
    await seedDiscountIntent(repo, "intent-1");
    await repo.createOrGetPromotionRedemption(discountInput("r1", "user-a", { manualPaymentIntentId: "intent-1" }));
    assert.equal(await repo.transitionPromotionRedemption({ id: "r1", userId: "user-a", expectedStatus: "reserved", nextStatus: "redeemed", now: T0 }), false);
    assert.equal(await repo.transitionPromotionRedemption({ id: "r1", userId: "user-a", expectedStatus: "reserved", nextStatus: "manual_review", now: T0 }), true);
    assert.equal((await repo.createOrGetPromotionRedemption(discountInput("r2"))).status, "conflict");
    assert.equal(await repo.transitionPromotionRedemption({ id: "r1", userId: "user-a", expectedStatus: "manual_review", nextStatus: "released", now: T0 }), false);
    assert.equal(await repo.finishManualPaymentIntent({ id: "intent-1", userId: "user-a", status: "failed", now: T0 }), true);
    assert.equal(await repo.transitionPromotionRedemption({ id: "r1", userId: "user-a", expectedStatus: "manual_review", nextStatus: "released", now: T0 }), true);
    const retry = await repo.reserveDiscountedManualPaymentIntent({ id: "intent-2", userId: "user-a", idempotencyKey: "intent-2-retry-key-12345", planId: "creator", interval: "weekly", couponCode: "SAVE50", now: T0 });
    assert.equal(retry.status, "created"); if (retry.status !== "created") return;
    assert.equal(await repo.finishManualPaymentIntent({ id: "intent-2", userId: "user-a", status: "created", providerPaymentLinkId: "link-2", checkoutUrl: "https://example.invalid/checkout", now: T0 }), true);
    assert.equal(await repo.settleManualPayment({ userId: "user-a", intentId: "intent-2", providerPaymentLinkId: "link-2", providerPaymentId: "payment-2", amountPaise: 24_950, currency: "INR", status: "captured", paidAt: T0, now: T0 }), "applied");
    assert.equal((await repo.listPromotionLifecycleEvents("coupon")).filter((event) => event.redemptionId === retry.redemption.id && event.eventType === "coupon_redeemed").length, 1);
    assert.equal(await repo.transitionPromotionRedemption({ id: "r1", userId: "user-b", expectedStatus: "manual_review", nextStatus: "redeemed", now: T0 }), false);
  });
}

for (const label of ["memory", "fake Prisma"] as const) {
  test(`${label}: draft coupon update is version-checked, immutable, and audited atomically`, async () => {
    const { repo } = await promotionRepository(label);
    const current = coupon("coupon", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    const changed = { ...current, code: "SAVE25", discountValue: 25, updatedAt: new Date(T0.getTime()) };
    const result = await repo.updateDraftPromotion({ record: changed, expectedUpdatedAt: T0, actorUserId: "admin-a" });
    assert.equal(result.status, "updated");
    if (result.status !== "updated") return;
    assert.equal(result.promotion.code, "SAVE25");
    assert.ok(result.promotion.updatedAt.getTime() > T0.getTime());
    assert.equal(result.promotion.createdByAdminId, current.createdByAdminId);
    assert.equal(result.promotion.createdAt.getTime(), current.createdAt.getTime());
    assert.equal(result.promotion.status, "draft");
    assert.deepEqual((await repo.listPromotionLifecycleEvents("coupon")).map((event) => event.eventType), ["promotion_created", "promotion_updated"]);
  });

  test(`${label}: simultaneous draft edits allow one winner and reject the stale writer`, async () => {
    const { repo } = await promotionRepository(label);
    const current = coupon("coupon", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    const edit = (code: string) => repo.updateDraftPromotion({ record: { ...current, code, updatedAt: T0 }, expectedUpdatedAt: T0, actorUserId: "admin-a" });
    const results = await Promise.all([edit("SAVE20"), edit("SAVE30")]);
    assert.equal(results.filter((result) => result.status === "updated").length, 1);
    assert.equal(results.filter((result) => result.status === "stale").length, 1);
    const stored = await repo.getPromotion("coupon");
    assert.ok(stored?.code === "SAVE20" || stored?.code === "SAVE30");
    assert.equal((await repo.listPromotionLifecycleEvents("coupon")).filter((event) => event.eventType === "promotion_updated").length, 1);
  });

  test(`${label}: draft coupon updates reject non-draft, missing, history-bearing and non-admin changes`, async () => {
    const { repo, seedHistory, seedGrantHistory, setStatus } = await promotionRepository(label);
    const current = coupon("coupon", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "user-a" })).status, "conflict");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, code: "SAVE20" }, expectedUpdatedAt: new Date(T0.getTime() + 1), actorUserId: "admin-a" })).status, "stale");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, status: "active", code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "conflict");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, id: "missing", code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "missing");
    await seedHistory("coupon");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "history");
    const grantCase = await promotionRepository(label);
    const grantRecord = coupon("grant-history", { status: "draft" });
    assert.equal(await grantCase.repo.createPromotion(grantRecord), true);
    await grantCase.seedGrantHistory(grantRecord.id);
    assert.equal((await grantCase.repo.updateDraftPromotion({ record: { ...grantRecord, code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "history");
    await setStatus("coupon", "active");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "not_draft");
  });

  test(`${label}: draft coupon update validates optional target-user existence consistently`, async () => {
    const { repo } = await promotionRepository(label);
    const current = coupon("target-check", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, targetUserId: "missing-user" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "target_user_missing");
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, targetUserId: null }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "updated", "null target remains valid");
  });

  test(`${label}: update audit failure leaves draft coupon unchanged`, async () => {
    const { repo, failAudit } = await promotionRepository(label);
    const current = coupon("coupon", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    failAudit();
    assert.equal((await repo.updateDraftPromotion({ record: { ...current, code: "SAVE20" }, expectedUpdatedAt: T0, actorUserId: "admin-a" })).status, "conflict");
    assert.deepEqual(await repo.getPromotion("coupon"), current);
    assert.deepEqual((await repo.listPromotionLifecycleEvents("coupon")).map((event) => event.eventType), ["promotion_created"]);
  });
}

for (const label of ["memory", "fake Prisma"] as const) {
  test(`${label}: coupon status transitions are atomic, CAS-protected, and preserve coupon terms`, async () => {
    const { repo, snapshotAudit } = await promotionRepository(label);
    const current = coupon("status-coupon", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    const activated = await repo.transitionCouponStatus({ id: current.id, expectedStatus: "draft", nextStatus: "active", expectedUpdatedAt: T0, actorUserId: "admin-a", now: T0 });
    assert.equal(activated.status, "updated");
    if (activated.status !== "updated") return;
    assert.ok(activated.promotion.updatedAt.getTime() > T0.getTime());
    for (const key of ["id", "type", "code", "discountType", "discountValue", "eligiblePlanIds", "createdByAdminId", "createdAt"] as const) assert.deepEqual(activated.promotion[key], current[key]);
    assert.equal((await repo.transitionCouponStatus({ id: current.id, expectedStatus: "draft", nextStatus: "active", expectedUpdatedAt: T0, actorUserId: "admin-a", now: T0 })).status, "invalid_status");

    const expectedUpdatedAt = activated.promotion.updatedAt;
    const deactivate = () => repo.transitionCouponStatus({ id: current.id, expectedStatus: "active", nextStatus: "paused", expectedUpdatedAt, actorUserId: "admin-a", now: T0 });
    const results = await Promise.all([deactivate(), deactivate()]);
    assert.equal(results.filter((result) => result.status === "updated").length, 1);
    assert.equal(results.filter((result) => result.status === "invalid_status").length, 1);
    const stored = await repo.getPromotion(current.id);
    assert.equal(stored?.status, "paused");
    assert.deepEqual((await repo.listPromotionLifecycleEvents(current.id)).map((event) => event.eventType), ["promotion_created", "promotion_updated", "promotion_paused"]);
    const eventsBeforeReactivation = await repo.listPromotionLifecycleEvents(current.id);
    const auditBeforeReactivation = await snapshotAudit();
    assert.equal(await repo.transitionCouponStatus({ id: current.id, expectedStatus: "draft", nextStatus: "active", expectedUpdatedAt: stored!.updatedAt, actorUserId: "admin-a", now: T0 }).then((result) => result.status), "invalid_status");
    assert.equal((await repo.getPromotion(current.id))?.status, "paused");
    assert.deepEqual(await repo.listPromotionLifecycleEvents(current.id), eventsBeforeReactivation);
    assert.deepEqual(await snapshotAudit(), auditBeforeReactivation);
  });

  test(`${label}: status transition preserves existing redemption and grant histories`, async () => {
    const { repo, seedHistory, seedGrantHistory, snapshotHistory } = await promotionRepository(label);
    const current = coupon("history-preservation", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    await seedHistory(current.id);
    await seedGrantHistory(current.id);
    const before = await snapshotHistory(current.id);

    const result = await repo.transitionCouponStatus({ id: current.id, expectedStatus: "draft", nextStatus: "active", expectedUpdatedAt: T0, actorUserId: "admin-a", now: T0 });
    assert.equal(result.status, "updated");
    assert.deepEqual(await snapshotHistory(current.id), before);
  });

  test(`${label}: coupon activation audit failure rolls back status, lifecycle, and audit`, async () => {
    const { repo, failStatusAudit } = await promotionRepository(label);
    const current = coupon("status-audit", { status: "draft" });
    assert.equal(await repo.createPromotion(current), true);
    failStatusAudit("promotion_updated");
    assert.equal((await repo.transitionCouponStatus({ id: current.id, expectedStatus: "draft", nextStatus: "active", expectedUpdatedAt: T0, actorUserId: "admin-a", now: T0 })).status, "conflict");
    assert.equal((await repo.getPromotion(current.id))?.status, "draft");
    assert.deepEqual((await repo.listPromotionLifecycleEvents(current.id)).map((event) => event.eventType), ["promotion_created"]);
    if (repo instanceof MemoryRepository) assert.deepEqual(repo.audit.map((entry) => entry.action), ["promotion.promotion_created"]);
  });
}

for (const [label, setup] of [["memory", memory], ["fake Prisma", async () => (await prisma()).repo]] as const) {
  test(`${label}: idempotent grant lookup still revalidates the current admin role`, async () => {
    const repo = await setup(); await repo.createPromotion(promotion("access"));
    const input = { id: "grant-auth", promotionId: "access", userId: "user-a", kind: "tier_access" as const, activationPolicy: "immediate" as const, planId: "creator" as const, durationDays: 3, grantedByAdminId: "admin-a", now: T0 };
    assert.equal((await repo.createPromotionalAccessGrant(input)).status, "created");
    if (repo instanceof MemoryRepository) repo.setUserRole("admin-a", "user");
    else await (repo as unknown as { db: { user: { update(args: { where: { id: string }; data: { role: string } }): Promise<unknown> } } }).db.user.update({ where: { id: "admin-a" }, data: { role: "user" } });
    assert.equal((await repo.createPromotionalAccessGrant(input)).status, "conflict");
  });
}

test("memory: global coupon usage limit serializes concurrent users", async () => {
  const repo = await memory(); await repo.createPromotion(coupon("coupon", { usageLimit: 1 }));
  const results = await Promise.all([repo.createOrGetPromotionRedemption(discountInput("r-a", "user-a")), repo.createOrGetPromotionRedemption(discountInput("r-b", "user-b"))]);
  assert.equal(results.filter((result) => result.status === "created").length, 1);
});

test("fake Prisma: transaction serializes concurrent reservations under promotion lock", async () => {
  const { repo } = await prisma(); await repo.createPromotion(coupon("coupon", { usageLimit: 1 }));
  const results = await Promise.all([repo.createOrGetPromotionRedemption(discountInput("r-a", "user-a")), repo.createOrGetPromotionRedemption(discountInput("r-b", "user-b"))]);
  assert.equal(results.filter((result) => result.status === "created").length, 1);
  assert.equal(results.filter((result) => result.status === "conflict").length, 1);
});

test("memory: immediate grants serialize without overlap and keep permanent queue order", async () => {
  const repo = await memory(); await repo.createPromotion(promotion("access"));
  const first = await repo.createPromotionalAccessGrant({ id: "g1", promotionId: "access", userId: "user-a", kind: "tier_access", activationPolicy: "immediate", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  const second = await repo.createPromotionalAccessGrant({ id: "g2", promotionId: "access", userId: "user-a", kind: "tier_access", activationPolicy: "immediate", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  assert.equal(first.status, "created", "first queued grant should persist"); assert.equal(second.status, "created", "second queued grant should persist");
  assert.equal((await repo.createPromotionalAccessGrant({ id: "g1", promotionId: "access", userId: "user-a", kind: "tier_access", activationPolicy: "immediate", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 })).status, "existing");
  assert.ok(first.grant!.queueSequence < second.grant!.queueSequence);
  const active1 = await repo.activateNextPromotionalAccessGrant("user-a", T0);
  assert.equal(active1?.id, "g1"); assert.equal(active1?.expiresAt?.getTime(), T0.getTime() + 3 * day);
  assert.equal(await repo.activateNextPromotionalAccessGrant("user-a", T0), null);
  const active2 = await repo.activateNextPromotionalAccessGrant("user-a", active1!.expiresAt!);
  assert.equal(active2?.id, "g2"); assert.equal(active2?.startsAt?.getTime(), active1!.expiresAt!.getTime());
  const list = await repo.listPromotionalAccessGrantsForUser("user-a");
  assert.deepEqual(list.map((g) => g.id), ["g1", "g2"]);
  assert.deepEqual((await repo.listPromotionLifecycleEvents("access")).map((event) => event.eventKey).filter((key) => key.includes("activated")), ["grant:g1:activated", "grant:g2:activated"]);
});

test("fake Prisma: grant queue uses database-assigned order and activates sequentially", async () => {
  const { repo } = await prisma(); await repo.createPromotion(promotion("access"));
  const input = (id: string) => ({ id, promotionId: "access", userId: "user-a", kind: "tier_access" as const, activationPolicy: "immediate" as const, planId: "creator" as const, durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  const first = await repo.createPromotionalAccessGrant(input("pg-1"));
  const second = await repo.createPromotionalAccessGrant(input("pg-2"));
  assert.equal(first.status, "created", "first queued grant should persist"); assert.equal(second.status, "created", "second queued grant should persist");
  assert.ok(first.grant!.queueSequence < second.grant!.queueSequence);
  const activatedFirst = await repo.activateNextPromotionalAccessGrant("user-a", T0);
  assert.equal(activatedFirst?.id, "pg-1");
  assert.equal(await repo.activateNextPromotionalAccessGrant("user-a", T0), null);
  const activatedSecond = await repo.activateNextPromotionalAccessGrant("user-a", activatedFirst!.expiresAt!);
  assert.equal(activatedSecond?.id, "pg-2");
  assert.equal(activatedSecond?.startsAt?.getTime(), activatedFirst!.expiresAt!.getTime());
});

test("memory: deferred grant waits through paid-period extension without consuming days", async () => {
  const repo = await memory(); await repo.createPromotion(promotion("bonus", { type: "bonus_days", targetUserId: "user-a" }));
  const paidEnd = new Date(T0.getTime() + 2 * day);
  repo.manualPlanAccesses.set("paid", { id: "paid", userId: "user-a", intentId: "paid-intent", providerPaymentId: "pay", planId: "creator", startsAt: new Date(T0.getTime() - day), expiresAt: new Date(paidEnd.getTime() + day) });
  const created = await repo.createPromotionalAccessGrant({ id: "bonus-1", promotionId: "bonus", userId: "user-a", kind: "bonus_days", activationPolicy: "after_current_access", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  assert.equal(created.status, "created");
  assert.equal(await repo.activateNextPromotionalAccessGrant("user-a", paidEnd), null); // unresolved/current paid term: fail closed
  repo.manualPlanAccesses.set("paid", { ...repo.manualPlanAccesses.get("paid")!, expiresAt: new Date(paidEnd.getTime() + day) });
  assert.equal(await repo.activateNextPromotionalAccessGrant("user-a", paidEnd), null);
  repo.manualPlanAccesses.delete("paid");
  const active = await repo.activateNextPromotionalAccessGrant("user-a", paidEnd);
  assert.equal(active?.startsAt?.getTime(), paidEnd.getTime()); assert.equal(active?.expiresAt?.getTime(), paidEnd.getTime() + 3 * day);
});

for (const [label, setup] of [["memory", memory], ["fake Prisma", prisma]] as const) {
  test(`${label}: atomic free coupon redemption creates the owner-matched grant without payment records`, async () => {
    const result = await setup();
    const repo = result instanceof MemoryRepository ? result : result.repo;
    await repo.createPromotion(promotion("free", { type: "free_access_coupon", code: "THREEDAYS", targetUserId: null, usageLimit: 10 }));
    const redemption = await repo.redeemFreeAccessCoupon({ redemptionId: "free-redemption", grantId: "free-grant", userId: "user-a", code: "THREEDAYS", idempotencyKey: "free-redemption-key", now: T0 });
    assert.equal(redemption.status, "created");
    if (redemption.status !== "created") return;
    assert.equal(redemption.redemption.status, "redeemed"); assert.equal(redemption.redemption.payablePaise, null);
    assert.equal(redemption.grant.status, "queued"); assert.equal(redemption.grant.activationPolicy, "after_current_access");
    assert.equal(redemption.grant.redemptionId, "free-redemption");
    assert.equal(await repo.getPromotionalAccessGrant("user-b", "free-grant"), null);
    if (repo instanceof MemoryRepository) {
      assert.equal(repo.manualPayments.size, 0); assert.equal(repo.manualPlanAccesses.size, 0); assert.equal(repo.razorpaySubscriptions.size, 0);
    } else {
      const db = (result as { repo: PrismaRepository; db: FakePrismaClient }).db;
      assert.equal((await db.paymentRecord.findMany()).length, 0); assert.equal((await db.manualPlanAccess.findMany()).length, 0); assert.equal((await db.subscription.findMany()).length, 0);
    }
  });
}

test("fake Prisma: lifecycle idempotency rejects a key reused for another promotion relationship", async () => {
  const { repo } = await prisma(); await repo.createPromotion(promotion("access"));
  const event = { id: "evt", eventKey: "grant:one:manual-review", eventType: "manual_review_required" as const, promotionId: "access", subjectUserId: "user-a", occurredAt: T0, metadata: { status: "manual_review" } };
  assert.equal(await repo.createPromotionLifecycleEvent(event), "created");
  assert.equal(await repo.createPromotionLifecycleEvent(event), "duplicate");
  assert.equal(await repo.createPromotionLifecycleEvent({ ...event, subjectUserId: "user-b" }), "conflict");
});

test("fake Prisma: duplicate lifecycle event still requires a currently authorized actor", async () => {
  const { repo, db } = await prisma(); await repo.createPromotion(promotion("access"));
  const event = { id: "evt-auth", eventKey: "grant:auth:manual-review", eventType: "manual_review_required" as const, promotionId: "access", subjectUserId: "user-a", actorUserId: "admin-a", occurredAt: T0, metadata: { status: "manual_review" } };
  assert.equal(await repo.createPromotionLifecycleEvent(event), "created");
  await db.user.update({ where: { id: "admin-a" }, data: { role: "user" } });
  assert.equal(await repo.createPromotionLifecycleEvent(event), "conflict");
});

test("memory: renewal and deferred grant activation serialize on the user lock", async () => {
  const repo = await memory();
  await repo.createPromotion(promotion("renewal-promo", { type: "bonus_days", accessPlanId: "creator", targetUserId: "user-a" }));
  const grant = await repo.createPromotionalAccessGrant({ id: "renewal-grant", promotionId: "renewal-promo", userId: "user-a", kind: "bonus_days", activationPolicy: "after_current_access", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  assert.equal(grant.status, "created");
  repo.razorpaySubscriptions.set("sub-renewal", { userId: "user-a", planId: "creator", interval: "weekly", status: "active", lastEventAt: 1, currentPeriodEnd: new Date(T0.getTime() - 1) });
  repo.razorpaySubscriptionIntents.set("intent-renewal", { id: "intent-renewal", userId: "user-a", idempotencyKey: "renewal", autoRenewConsentAt: T0, autoRenewConsentVersion: "v1", providerSubscriptionId: "sub-renewal", checkoutUrl: null, providerPlanId: "provider-plan", planId: "creator", interval: "weekly", amountPaise: 49_900, currency: "INR", status: "active", errorCategory: null, createdAt: T0, updatedAt: T0 });
  const newPeriodEnd = new Date(T0.getTime() + 7 * day);
  const [activation, renewal] = await Promise.all([
    repo.activateNextPromotionalAccessGrant("user-a", T0),
    repo.processRazorpaySubscriptionEvent({ providerEventId: "renewal-event", eventType: "subscription.charged", subscriptionId: "sub-renewal", newStatus: "active", createdAt: Math.floor(T0.getTime() / 1000) + 1, currentPeriodEnd: Math.floor(newPeriodEnd.getTime() / 1000), payment: { id: "renewal-payment", amount: 49_900, currency: "INR", status: "captured" } }),
  ]);
  assert.equal(renewal, "applied");
  assert.equal(activation, null, "the deferred grant cannot activate while the subscription is active or renewal state is unresolved");
  assert.equal(repo.promotionalAccessGrants.get("renewal-grant")?.status, "queued");
  assert.equal(repo.razorpaySubscriptions.get("sub-renewal")?.currentPeriodEnd?.getTime(), newPeriodEnd.getTime());
});

test("fake Prisma: renewal and deferred grant activation share the per-user row lock", async () => {
  const { repo, db } = await prisma();
  await repo.createPromotion(promotion("renewal-promo", { type: "bonus_days", accessPlanId: "creator", targetUserId: "user-a" }));
  await repo.createPromotionalAccessGrant({ id: "renewal-grant", promotionId: "renewal-promo", userId: "user-a", kind: "bonus_days", activationPolicy: "after_current_access", planId: "creator", durationDays: 3, grantedByAdminId: "admin-a", now: T0 });
  await db.subscription.create({ data: { id: "sub-row", userId: "user-a", planId: "creator", interval: "weekly", status: "active", razorpaySubscriptionId: "sub-renewal", lastEventAt: 1n, currentPeriodEnd: new Date(T0.getTime() - 1), cancelAtPeriodEnd: false, trialEndsAt: null } });
  await db.razorpaySubscriptionIntent.create({ data: { id: "intent-renewal", userId: "user-a", idempotencyKey: "renewal", autoRenewConsentAt: T0, autoRenewConsentVersion: "v1", providerSubscriptionId: "sub-renewal", checkoutUrl: null, providerPlanId: "provider-plan", planId: "creator", interval: "weekly", amountPaise: 49_900, currency: "INR", status: "active", errorCategory: null, createdAt: T0, updatedAt: T0 } });
  const newPeriodEnd = new Date(T0.getTime() + 7 * day);
  const [activation, renewal] = await Promise.all([
    repo.activateNextPromotionalAccessGrant("user-a", T0),
    repo.processRazorpaySubscriptionEvent({ providerEventId: "renewal-event", eventType: "subscription.charged", subscriptionId: "sub-renewal", newStatus: "active", createdAt: Math.floor(T0.getTime() / 1000) + 1, currentPeriodEnd: Math.floor(newPeriodEnd.getTime() / 1000), payment: { id: "renewal-payment", amount: 49_900, currency: "INR", status: "captured" } }),
  ]);
  assert.equal(renewal, "applied");
  assert.equal(activation, null);
  assert.equal(db.promotionalAccessGrant.rows.find((row) => row["id"] === "renewal-grant")?.["status"], "queued");
  assert.ok(db.lockLog.length >= 2);
  assert.ok(db.lockLog.every((lock) => lock === "user:user-a"), "both operations acquire the same user's lock before paid-period/grant changes");
});

test("memory: activation rolls back every expired grant and audit/event when a later expiry event fails", async () => {
  const repo = await memory(); await repo.createPromotion(promotion("expiry-promo"));
  const activeGrant = (id: string): import("../src/server/repository.ts").PromotionalAccessGrantRecord => ({
    id, promotionId: "expiry-promo", userId: "user-a", redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status: "active", planId: "creator", durationDays: 3, queueSequence: id === "expire-first" ? 1n : 2n,
    startsAt: new Date(T0.getTime() - 4 * day), expiresAt: new Date(T0.getTime() - day), activatedAt: new Date(T0.getTime() - 4 * day), revokedAt: null, grantedByAdminId: "admin-a", reason: null, createdAt: T0, updatedAt: T0,
  });
  repo.promotionalAccessGrants.set("expire-first", activeGrant("expire-first"));
  repo.promotionalAccessGrants.set("expire-second", activeGrant("expire-second"));
  const initialAudit = repo.audit.length;
  repo.beforePromotionEventInsert = (event) => !(event.eventType === "grant_expired" && event.accessGrantId === "expire-second");
  assert.equal(await repo.activateNextPromotionalAccessGrant("user-a", T0), null);
  assert.equal(repo.promotionalAccessGrants.get("expire-first")?.status, "active");
  assert.equal(repo.promotionalAccessGrants.get("expire-second")?.status, "active");
  assert.equal(repo.promotionLifecycleEvents.has("grant:expire-first:expired"), false);
  assert.equal(repo.promotionLifecycleEvents.has("grant:expire-second:expired"), false);
  assert.equal(repo.audit.length, initialAudit);
});

for (const [label, differs, expected] of [["matching", false, "duplicate"], ["mismatching", true, "conflict"]] as const) {
  test(`fake Prisma: concurrent unique-key ${label} lifecycle event is reconciled after rollback`, async () => {
    const { repo, db } = await prisma(); await repo.createPromotion(promotion("access"));
    const event = { id: `input-${label}`, eventKey: `concurrent:${label}`, eventType: "manual_review_required" as const, promotionId: "access", subjectUserId: "user-a", actorUserId: "admin-a", occurredAt: T0, metadata: { status: "manual_review" } };
    const existing = { id: `committed-${label}`, eventKey: event.eventKey, eventType: event.eventType, promotionId: event.promotionId, subjectUserId: event.subjectUserId, actorUserId: event.actorUserId, redemptionId: null, redemptionUserId: null, redemptionPromotionId: null, accessGrantId: null, accessGrantUserId: null, accessGrantPromotionId: null, occurredAt: new Date(T0.getTime() + (differs ? 1 : 0)), outcome: null, metadata: differs ? { status: "different" } : event.metadata, createdAt: T0 };
    db.promotionLifecycleEvent.beforeCreate = () => {
      db.promotionLifecycleEvent.beforeCreate = null;
      throw Object.assign(new Error("simulated concurrent unique-key winner"), { code: "P2002" });
    };
    db.afterTransactionRollback = (error) => {
      if ((error as { code?: string }).code === "P2002") {
        db.afterTransactionRollback = null;
        db.promotionLifecycleEvent.rows.push(existing);
      }
    };
    assert.equal(await repo.createPromotionLifecycleEvent(event), expected);
  });
}

function discountCoupon(id: string, over: Partial<PromotionRecord> = {}): PromotionRecord {
  return coupon(id, { code: "SAVE10", discountType: "percentage", discountValue: 10, usageLimit: 5, ...over });
}

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: discounted manual reservation derives catalog amounts and replays only an identical snapshot`, async () => {
    const repo = kind === "memory" ? await memory() : (await prisma()).repo;
    await repo.createPromotion(discountCoupon("discount"));
    const input = { id: "discount-intent-1", userId: "user-a", idempotencyKey: "discount-request-12345", planId: "creator" as const, interval: "weekly" as const, couponCode: " save10 ", now: T0 };
    const first = await repo.reserveDiscountedManualPaymentIntent(input);
    assert.equal(first.status, "created");
    if (first.status !== "created") return;
    assert.equal(first.intent.amountPaise, 44_910);
    assert.equal(first.redemption.status, "reserved");
    assert.deepEqual([first.redemption.listPricePaise, first.redemption.discountPaise, first.redemption.payablePaise], [49_900, 4_990, 44_910]);
    assert.equal(first.redemption.manualPaymentIntentId, first.intent.id);
    assert.equal(first.redemption.manualPaymentIntentUserId, "user-a");
    const replay = await repo.reserveDiscountedManualPaymentIntent({ ...input, id: "a-new-generated-id" });
    assert.equal(replay.status, "existing");
    if (replay.status === "existing") assert.equal(replay.intent.id, first.intent.id);
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ ...input, planId: "pro" })).status, "conflict");
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ ...input, interval: "monthly" })).status, "conflict");
    await repo.createPromotion(discountCoupon("other-discount", { code: "OTHER10" }));
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ ...input, couponCode: "OTHER10" })).status, "conflict");
    const otherOwnerReplayKey = await repo.reserveDiscountedManualPaymentIntent({ ...input, id: "other-owner-intent", userId: "user-b", couponCode: "SAVE10" });
    assert.equal(otherOwnerReplayKey.status, "created", "the same raw idempotency key is independent for another user");
  });

  test(`${kind}: replay conflicts when stored coupon terms change even if the payable amount stays the same`, async () => {
    const repo = kind === "memory" ? await memory() : (await prisma()).repo;
    await repo.createPromotion(discountCoupon("discount-terms", { code: "TERMS10", discountType: "percentage", discountValue: 10 }));
    const input = { id: "terms-intent", userId: "user-a", idempotencyKey: "terms-request-12345678", planId: "creator" as const, interval: "weekly" as const, couponCode: "TERMS10", now: T0 };
    const first = await repo.reserveDiscountedManualPaymentIntent(input);
    assert.equal(first.status, "created");
    if (kind === "fake Prisma") {
      const db = (repo as PrismaRepository as unknown as { db: FakePrismaClient }).db;
      assert.equal((await db.paymentRecord.findMany()).length, 0);
      assert.equal((await db.manualPlanAccess.findMany()).length, 0);
      assert.equal((await db.subscription.findMany()).length, 0);
    }

    // A 10% weekly discount and a fixed 4,990-paise discount happen to produce
    // the same amount, but represent different stored coupon terms.
    if (repo instanceof MemoryRepository) {
      const stored = repo.promotions.get("discount-terms");
      assert.ok(stored);
      repo.promotions.set("discount-terms", { ...stored, discountType: "fixed_amount", discountValue: 4_990 });
    } else {
      const db = (repo as unknown as { db: FakePrismaClient }).db;
      await db.promotion.update({ where: { id: "discount-terms" }, data: { discountType: "fixed_amount", discountValue: 4_990 } });
    }

    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ ...input, id: "terms-replay-new-id" })).status, "conflict");
  });

  test(`${kind}: discounted reservation rejects unusable coupon states and non-positive payable amounts`, async () => {
    const repo = kind === "memory" ? await memory() : (await prisma()).repo;
    const cases: Array<[string, Partial<PromotionRecord>, "unavailable" | "conflict"]> = [
      ["expired", { expiresAt: new Date(T0.getTime()) }, "unavailable"],
      ["inactive", { status: "paused" }, "unavailable"],
      ["not-yet-valid", { startsAt: new Date(T0.getTime() + day) }, "unavailable"],
      ["ineligible", { eligiblePlanIds: ["pro"] }, "unavailable"],
      ["targeted", { targetUserId: "user-b" }, "unavailable"],
      ["zero-payable", { discountType: "fixed_amount", discountValue: 100_000 }, "unavailable"],
    ];
    for (const [id, overrides, expected] of cases) {
      const code = id.replaceAll("-", "").toUpperCase();
      await repo.createPromotion(discountCoupon(id, { ...overrides, code }));
      assert.equal((await repo.reserveDiscountedManualPaymentIntent({ id: `intent-${id}`, userId: "user-a", idempotencyKey: `request-${id}-0000000001`, planId: "creator", interval: "weekly", couponCode: code, now: T0 })).status, expected, id);
    }
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ id: "bad-code-intent", userId: "user-a", idempotencyKey: "bad-code-request-0001", planId: "creator", interval: "weekly", couponCode: "%%", now: T0 })).status, "conflict");
    const tiny = discountCoupon("zero-percent", { code: "ZERO1", discountValue: 1 });
    await repo.createPromotion(tiny);
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ id: "zero-percent-intent", userId: "user-a", idempotencyKey: "zero-percent-request-1", planId: "creator", interval: "weekly", couponCode: "ZERO1", now: T0 })).status, "created");
  });

  test(`${kind}: fixed-amount discount is stored in paise and exhausted coupons reject another owner`, async () => {
    const repo = kind === "memory" ? await memory() : (await prisma()).repo;
    await repo.createPromotion(discountCoupon("fixed", { code: "FIXED5000", discountType: "fixed_amount", discountValue: 5_000, usageLimit: 1 }));
    const created = await repo.reserveDiscountedManualPaymentIntent({ id: "fixed-intent", userId: "user-a", idempotencyKey: "fixed-request-0000001", planId: "creator", interval: "monthly", couponCode: "FIXED5000", now: T0 });
    assert.equal(created.status, "created");
    if (created.status === "created") {
      assert.equal(created.redemption.listPricePaise, 199_900);
      assert.equal(created.redemption.discountPaise, 5_000);
      assert.equal(created.redemption.payablePaise, 194_900);
      assert.equal(created.intent.amountPaise, 194_900);
    }
    assert.equal((await repo.reserveDiscountedManualPaymentIntent({ id: "fixed-intent-b", userId: "user-b", idempotencyKey: "fixed-request-owner-b-1", planId: "creator", interval: "monthly", couponCode: "FIXED5000", now: T0 })).status, "unavailable");
  });
}

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: discounted usage-limit concurrency is serialized in the repository test model`, async () => {
    const repo = kind === "memory" ? await memory() : (await prisma()).repo;
    await repo.createPromotion(discountCoupon("limited-discount", { code: "ONCE10", usageLimit: 1 }));
    const reserve = (userId: string, id: string) => repo.reserveDiscountedManualPaymentIntent({ id, userId, idempotencyKey: `${id}-request-00000001`, planId: "creator", interval: "weekly", couponCode: "ONCE10", now: T0 });
    const outcomes = await Promise.all([reserve("user-a", "discount-a"), reserve("user-b", "discount-b")]);
    assert.equal(outcomes.filter((result) => result.status === "created").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "unavailable").length, 1);
  });
}

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: discounted settlement consumes the reservation and creates paid records atomically; exact retry is duplicate`, async () => {
    const fixture = kind === "memory" ? { repo: await memory(), db: null } : await prisma();
    const repo = fixture.repo;
    await repo.createPromotion(discountCoupon("settle-coupon", { code: "SETTLE10", usageLimit: 5 }));
    const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: "settle-intent", userId: "user-a", idempotencyKey: "settle-request-12345678", planId: "creator", interval: "weekly", couponCode: "SETTLE10", now: T0 });
    assert.equal(reserved.status, "created");
    if (reserved.status !== "created") return;
    await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: "settle-link", checkoutUrl: "https://rzp.io/i/settle", now: T0 });
    const input = { userId: "user-a", intentId: reserved.intent.id, providerPaymentLinkId: "settle-link", providerPaymentId: "settle-payment", amountPaise: 44_910, currency: "INR", status: "captured", paidAt: T0, now: T0 };
    assert.equal(await repo.settleManualPayment(input), "applied");
    assert.equal((await repo.getManualPaymentIntent("user-a", reserved.intent.id))?.status, "paid");
    const redemptionStatus = repo instanceof MemoryRepository ? repo.promotionRedemptions.get(reserved.redemption.id)?.status : fixture.db ? (await fixture.db.promotionRedemption.findUnique({ where: { id: reserved.redemption.id } }))?.["status"] : null;
    assert.equal(redemptionStatus, "redeemed");
    assert.equal(await repo.settleManualPayment(input), "duplicate");
    if (fixture.db) {
      assert.equal((await fixture.db.paymentRecord.findMany()).length, 1);
      assert.equal((await fixture.db.manualPlanAccess.findMany()).length, 1);
      assert.equal((await fixture.db.subscription.findMany()).length, 0);
      assert.equal((await fixture.db.promotionRedemption.findUnique({ where: { id: reserved.redemption.id } }))?.["status"], "redeemed");
      assert.equal((await fixture.db.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${reserved.redemption.id}:redeemed` } }))?.["eventType"], "coupon_redeemed");
      assert.equal((await fixture.db.auditLog.findMany({ where: { entityId: reserved.redemption.id, action: "promotion.coupon_redeemed" } })).length, 1);
    } else if (repo instanceof MemoryRepository) {
      assert.equal(repo.manualPayments.size, 1); assert.equal(repo.manualPlanAccesses.size, 1); assert.equal(repo.razorpaySubscriptions.size, 0);
      assert.equal([...repo.promotionLifecycleEvents.values()].filter((event) => event.eventType === "coupon_redeemed").length, 1);
      assert.equal(repo.audit.filter((entry) => entry.action === "promotion.coupon_redeemed").length, 1);
    }
  });

  test(`${kind}: mismatched owner, intent, link, amount, or redemption never reports a duplicate`, async () => {
    const fixture = kind === "memory" ? { repo: await memory(), db: null } : await prisma();
    const repo = fixture.repo;
    await repo.createPromotion(discountCoupon("settle-conflicts", { code: "CONFLICT10", usageLimit: 10 }));
    const first = await repo.reserveDiscountedManualPaymentIntent({ id: "conflict-intent-1", userId: "user-a", idempotencyKey: "conflict-request-1234567", planId: "creator", interval: "weekly", couponCode: "CONFLICT10", now: T0 });
    assert.equal(first.status, "created"); if (first.status !== "created") return;
    await repo.finishManualPaymentIntent({ id: first.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: "conflict-link-1", checkoutUrl: "https://rzp.io/i/1", now: T0 });
    const settled = { userId: "user-a", intentId: first.intent.id, providerPaymentLinkId: "conflict-link-1", providerPaymentId: "conflict-payment", amountPaise: 44_910, currency: "INR", status: "captured", paidAt: T0, now: T0 };
    assert.equal(await repo.settleManualPayment(settled), "applied");
    assert.equal(await repo.settleManualPayment({ ...settled, userId: "user-b" }), "conflict");
    assert.equal(await repo.settleManualPayment({ ...settled, intentId: "missing-intent" }), "conflict");
    assert.equal(await repo.settleManualPayment({ ...settled, providerPaymentLinkId: "other-link" }), "conflict");
    assert.equal(await repo.settleManualPayment({ ...settled, amountPaise: 44_909 }), "conflict");
    assert.equal(await repo.settleManualPayment({ ...settled, currency: "USD" }), "conflict");
    assert.equal(await repo.settleManualPayment({ ...settled, status: "failed" }), "conflict");
    if (repo instanceof MemoryRepository) repo.promotionRedemptions.set(first.redemption.id, { ...first.redemption, status: "manual_review" });
    else if (fixture.db) await fixture.db.promotionRedemption.update({ where: { id: first.redemption.id }, data: { status: "manual_review" } });
    assert.equal(await repo.settleManualPayment(settled), "conflict");
  });
}

test("fake Prisma: a settled coupon without its matching audit event is not accepted as a duplicate", async () => {
  const fixture = await prisma(); const repo = fixture.repo;
  await repo.createPromotion(discountCoupon("settle-audit-integrity", { code: "AUDITINTEGRITY10", usageLimit: 5 }));
  const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: "audit-integrity-intent", userId: "user-a", idempotencyKey: "audit-integrity-key-12345", planId: "creator", interval: "weekly", couponCode: "AUDITINTEGRITY10", now: T0 });
  assert.equal(reserved.status, "created"); if (reserved.status !== "created") return;
  await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: "audit-integrity-link", checkoutUrl: "https://rzp.io/i/audit-integrity", now: T0 });
  const input = { userId: "user-a", intentId: reserved.intent.id, providerPaymentLinkId: "audit-integrity-link", providerPaymentId: "audit-integrity-payment", amountPaise: 44_910, currency: "INR", status: "captured", paidAt: T0, now: T0 };
  assert.equal(await repo.settleManualPayment(input), "applied");
  fixture.db.auditLog.rows = fixture.db.auditLog.rows.filter((row) => row["entityId"] !== reserved.redemption.id || row["action"] !== "promotion.coupon_redeemed");
  assert.equal(await repo.settleManualPayment(input), "conflict");
});

test("memory: a pre-existing redeemed lifecycle event without its audit entry rolls back first-time settlement", async () => {
  const repo = await memory();
  await repo.createPromotion(discountCoupon("settle-missing-audit", { code: "MISSINGAUDIT10", usageLimit: 5 }));
  const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: "missing-audit-intent", userId: "user-a", idempotencyKey: "missing-audit-key-12345", planId: "creator", interval: "weekly", couponCode: "MISSINGAUDIT10", now: T0 });
  assert.equal(reserved.status, "created"); if (reserved.status !== "created") return;
  await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: "missing-audit-link", checkoutUrl: "https://rzp.io/i/missing-audit", now: T0 });
  const eventKey = `redemption:${reserved.redemption.id}:redeemed`;
  repo.promotionLifecycleEvents.set(eventKey, {
    id: `event-${reserved.redemption.id}-redeemed`, eventKey, eventType: "coupon_redeemed", promotionId: reserved.redemption.promotionId,
    subjectUserId: "user-a", actorUserId: null, redemptionId: reserved.redemption.id, accessGrantId: null, occurredAt: T0, outcome: null,
    metadata: { status: "redeemed", planId: "creator", discountType: "percentage", discountValue: 10, discountPaise: 4_990, payablePaise: 44_910 },
  });
  const before = structuredClone({ payments: [...repo.manualPayments], access: [...repo.manualPlanAccesses], intent: repo.manualPaymentIntents.get(reserved.intent.id), redemption: repo.promotionRedemptions.get(reserved.redemption.id), events: [...repo.promotionLifecycleEvents], audit: repo.audit });
  const result = await repo.settleManualPayment({ userId: "user-a", intentId: reserved.intent.id, providerPaymentLinkId: "missing-audit-link", providerPaymentId: "missing-audit-payment", amountPaise: 44_910, currency: "INR", status: "captured", paidAt: T0, now: T0 });
  assert.equal(result, "conflict");
  assert.deepEqual({ payments: [...repo.manualPayments], access: [...repo.manualPlanAccesses], intent: repo.manualPaymentIntents.get(reserved.intent.id), redemption: repo.promotionRedemptions.get(reserved.redemption.id), events: [...repo.promotionLifecycleEvents], audit: repo.audit }, before);
  assert.equal(repo.manualPayments.size, 0);
  assert.equal(repo.manualPlanAccesses.size, 0);
  assert.equal(repo.manualPaymentIntents.get(reserved.intent.id)?.status, "created");
  assert.equal(repo.promotionRedemptions.get(reserved.redemption.id)?.status, "reserved");
  assert.equal(repo.audit.some((entry) => entry.metadata?.["eventKey"] === eventKey), false);
});

test("memory: every discounted settlement write failure restores payment, access, intent, redemption, lifecycle, and audit state", async () => {
  const stages = ["payment_record", "manual_access", "intent_paid", "redemption_redeemed", "lifecycle", "audit"] as const;
  for (const failure of stages) {
    const repo = await memory(); await repo.createPromotion(discountCoupon(`settle-rollback-${failure}`, { code: `ROLLBACK${failure.replaceAll("_", "").toUpperCase()}`, usageLimit: 5 }));
    const code = `ROLLBACK${failure.replaceAll("_", "").toUpperCase()}`;
    const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: `rollback-${failure}`, userId: "user-a", idempotencyKey: `rollback-${failure}-key-12345`, planId: "creator", interval: "weekly", couponCode: code, now: T0 });
    assert.equal(reserved.status, "created", failure); if (reserved.status !== "created") continue;
    await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: `link-${failure}`, checkoutUrl: "https://rzp.io/i/rollback", now: T0 });
    const before = structuredClone({ payments: [...repo.manualPayments], access: [...repo.manualPlanAccesses], intents: [...repo.manualPaymentIntents], redemptions: [...repo.promotionRedemptions], events: [...repo.promotionLifecycleEvents], audit: repo.audit });
    if (["payment_record", "manual_access", "intent_paid", "redemption_redeemed"].includes(failure)) repo.beforeManualPaymentSettlementWrite = (stage) => stage !== failure;
    if (failure === "lifecycle") repo.beforePromotionEventInsert = (event) => event.eventType !== "coupon_redeemed";
    if (failure === "audit") repo.beforePromotionAuditInsert = (event) => event.eventType !== "coupon_redeemed";
    assert.equal(await repo.settleManualPayment({ userId: "user-a", intentId: reserved.intent.id, providerPaymentLinkId: `link-${failure}`, providerPaymentId: `payment-${failure}`, amountPaise: 44_910, currency: "INR", status: "captured", paidAt: T0, now: T0 }), "conflict", failure);
    assert.deepEqual({ payments: [...repo.manualPayments], access: [...repo.manualPlanAccesses], intents: [...repo.manualPaymentIntents], redemptions: [...repo.promotionRedemptions], events: [...repo.promotionLifecycleEvents], audit: repo.audit }, before, failure);
  }
});

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: discounted reservation rolls back intent, redemption, lifecycle and audit writes on failures`, async () => {
    for (const failure of ["intent", "redemption", "lifecycle", "audit"] as const) {
      const repo = kind === "memory" ? await memory() : (await prisma()).repo;
      await repo.createPromotion(discountCoupon(`rollback-${failure}`, { code: `ROLL${failure.toUpperCase()}` }));
      const db = repo instanceof PrismaRepository ? (repo as unknown as { db: FakePrismaClient }).db : null;
      if (repo instanceof MemoryRepository) {
        if (failure === "intent") repo.beforeDiscountedIntentInsert = () => false;
        if (failure === "redemption") repo.beforeDiscountRedemptionInsert = () => false;
        if (failure === "lifecycle") repo.beforePromotionEventInsert = (event) => event.eventType !== "coupon_reserved";
        if (failure === "audit") repo.beforePromotionAuditInsert = (event) => event.eventType !== "coupon_reserved";
      } else if (db) {
        if (failure === "intent") db.manualPaymentIntent.beforeCreate = () => { throw new Error("injected intent failure"); };
        if (failure === "redemption") db.promotionRedemption.beforeCreate = () => { throw new Error("injected redemption failure"); };
        if (failure === "lifecycle") db.promotionLifecycleEvent.beforeCreate = () => { throw new Error("injected lifecycle failure"); };
        if (failure === "audit") db.auditLog.beforeCreate = () => { throw new Error("injected audit failure"); };
      }
      const input = { id: `rollback-intent-${failure}`, userId: "user-a", idempotencyKey: `rollback-key-${failure}-0001`, planId: "creator" as const, interval: "weekly" as const, couponCode: `ROLL${failure.toUpperCase()}`, now: T0 };
      let result: Awaited<ReturnType<typeof repo.reserveDiscountedManualPaymentIntent>> | null = null;
      try { result = await repo.reserveDiscountedManualPaymentIntent(input); } catch { /* a simulated low-level insert failure is also valid */ }
      assert.notEqual(result?.status, "created", failure);
      if (repo instanceof MemoryRepository) {
        assert.equal(repo.manualPaymentIntents.size, 0, failure);
        assert.equal(repo.promotionRedemptions.size, 0, failure);
        assert.equal(repo.promotionLifecycleEvents.size, 1, failure, "only promotion-created history remains");
        assert.equal(repo.audit.length, 1, failure, "only promotion-created audit remains");
      } else if (db) {
        assert.equal((await db.manualPaymentIntent.findMany()).length, 0, failure);
        assert.equal((await db.promotionRedemption.findMany()).length, 0, failure);
        assert.equal((await db.promotionLifecycleEvent.findMany()).length, 1, failure);
        assert.equal((await db.auditLog.findMany()).length, 1, failure);
      }
    }
  });
}
