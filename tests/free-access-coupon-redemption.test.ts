import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { PromotionRecord } from "../src/server/repository.ts";
import { createFreeAccessCouponRedemptionRoute } from "../src/server/promotions/free-access-redemption.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 86_400_000;
const IDEM = "redeem-request-00000001";

function freeCoupon(id = "free-coupon", over: Partial<PromotionRecord> = {}): PromotionRecord {
  return {
    id, type: "free_access_coupon", status: "active", code: "THREEDAYS", discountType: null, discountValue: null,
    accessPlanId: "pro", durationDays: 3, eligiblePlanIds: [], targetUserId: null,
    startsAt: new Date(NOW.getTime() - DAY), expiresAt: null, usageLimit: 10, createdByAdminId: "admin-a", reason: null,
    createdAt: new Date(NOW.getTime() - DAY), updatedAt: new Date(NOW.getTime() - DAY), ...over,
  };
}

async function repositoryFixture(kind: "memory" | "fake Prisma") {
  if (kind === "memory") {
    const repo = new MemoryRepository();
    for (const id of ["admin-a", "user-a", "user-b"]) repo.setUserRole(id, id === "admin-a" ? "admin" : "user");
    return { repo, db: null as FakePrismaClient | null };
  }
  const db = new FakePrismaClient();
  for (const [id, role] of [["admin-a", "admin"], ["user-a", "user"], ["user-b", "user"]] as const) await db.user.create({ data: { id, role } });
  return { repo: new PrismaRepository(db), db };
}

async function snapshot(f: Awaited<ReturnType<typeof repositoryFixture>>, promotionId: string) {
  const events = await f.repo.listPromotionLifecycleEvents(promotionId);
  if (f.repo instanceof MemoryRepository) {
    return structuredClone({
      redemptions: [...f.repo.promotionRedemptions.values()].filter((row) => row.promotionId === promotionId),
      grants: [...f.repo.promotionalAccessGrants.values()].filter((row) => row.promotionId === promotionId),
      events,
      audit: f.repo.audit,
      payments: [...f.repo.manualPayments], manualAccess: [...f.repo.manualPlanAccesses], subscriptions: [...f.repo.razorpaySubscriptions],
    });
  }
  const db = f.db!;
  return structuredClone({
    redemptions: await db.promotionRedemption.findMany({ where: { promotionId } }),
    grants: await db.promotionalAccessGrant.findMany({ where: { promotionId } }),
    events,
    audit: await db.auditLog.findMany(),
    payments: await db.paymentRecord.findMany(), manualAccess: await db.manualPlanAccess.findMany(), subscriptions: await db.subscription.findMany(),
  });
}

async function seedPaidAccess(f: Awaited<ReturnType<typeof repositoryFixture>>, end: Date): Promise<void> {
  if (f.repo instanceof MemoryRepository) {
    f.repo.manualPlanAccesses.set("paid-access", { id: "paid-access", userId: "user-a", intentId: "paid-intent", providerPaymentId: "paid-provider-payment", planId: "creator", startsAt: new Date(NOW.getTime() - DAY), expiresAt: end });
  } else {
    await f.db!.manualPlanAccess.create({ data: { id: "paid-access", userId: "user-a", intentId: "paid-intent", providerPaymentId: "paid-provider-payment", planId: "creator", startsAt: new Date(NOW.getTime() - DAY), expiresAt: end } });
  }
}

function runtimeFor(repo: MemoryRepository, userId: string | null): Runtime {
  let next = 0;
  return { mode: "local", repo, currentUserId: async () => userId, newId: () => `redeem-id-${++next}`, now: () => NOW };
}
function request(body: unknown, key = IDEM): Request {
  return new Request("http://localhost/api/promotions/redeem", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}

test("free coupon redemption requires authentication and cannot accept a user ID override", async () => {
  const repo = new MemoryRepository(); repo.setUserRole("user-a", "user"); repo.setUserRole("user-b", "user"); repo.setUserRole("admin-a", "admin");
  await repo.createPromotion(freeCoupon("targeted", { code: "TARGET3", targetUserId: "user-a" }));
  const anonymous = createFreeAccessCouponRedemptionRoute(() => runtimeFor(repo, null));
  assert.equal((await anonymous(request({ code: "TARGET3" }))).status, 401);
  const ordinary = createFreeAccessCouponRedemptionRoute(() => runtimeFor(repo, "user-b"));
  assert.equal((await ordinary(request({ code: "TARGET3", userId: "user-a" }))).status, 400, "unexpected userId body field is rejected");
  assert.equal((await ordinary(request({ code: "TARGET3" }, "redeem-request-00000002"))).status, 409, "eligibility uses the authenticated user, not a body-supplied ID");
  assert.equal(repo.promotionRedemptions.size, 0);
});

test("coupon code is trimmed and case-normalized; idempotent retry creates only one redemption and grant", async () => {
  const repo = new MemoryRepository(); repo.setUserRole("admin-a", "admin"); repo.setUserRole("user-a", "user");
  await repo.createPromotion(freeCoupon());
  const route = createFreeAccessCouponRedemptionRoute(() => runtimeFor(repo, "user-a"));
  const first = await route(request({ code: "  threeDays  " }));
  assert.equal(first.status, 201);
  const firstBody = await first.json() as { data: { redemption: { id: string }; grant: { id: string; status: string; planId: string; durationDays: number; activationPolicy: string; startsAt: null; expiresAt: null } }; idempotentReplay: boolean };
  assert.equal(firstBody.data.grant.status, "queued");
  assert.equal(firstBody.data.grant.planId, "pro");
  assert.equal(firstBody.data.grant.durationDays, 3);
  assert.equal(firstBody.data.grant.activationPolicy, "after_current_access");
  assert.equal(firstBody.data.grant.startsAt, null);
  assert.equal(firstBody.data.grant.expiresAt, null);
  const retry = await route(request({ code: "THREEDAYS" }));
  assert.equal(retry.status, 200);
  const retryBody = await retry.json() as typeof firstBody;
  assert.equal(retryBody.idempotentReplay, true);
  assert.equal(retryBody.data.redemption.id, firstBody.data.redemption.id);
  assert.equal(retryBody.data.grant.id, firstBody.data.grant.id);
  assert.equal(await route(request({ code: "THREEDAYS" }, "redeem-request-00000002")).then((response) => response.status), 409, "a second key cannot redeem the same coupon twice");
  assert.equal(repo.promotionRedemptions.size, 1);
  assert.equal(repo.promotionalAccessGrants.size, 1);
});

test("missing, malformed, and unsupported body fields receive safe validation responses", async () => {
  const repo = new MemoryRepository(); repo.setUserRole("user-a", "user");
  const route = createFreeAccessCouponRedemptionRoute(() => runtimeFor(repo, "user-a"));
  assert.equal((await route(request({}))).status, 400);
  assert.equal((await route(request({ code: "###" }, "redeem-request-00000002"))).status, 400);
  assert.equal((await route(request({ code: 42 }, "redeem-request-00000003"))).status, 400);
  assert.equal((await route(new Request("http://localhost/api/promotions/redeem", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": IDEM }, body: "{" }))).status, 400);
  assert.equal(repo.promotionRedemptions.size, 0);
});

test("draft, paused, expired, not-yet-started, discount, and missing coupons are unavailable", async () => {
  const cases: Array<[string, PromotionRecord | null]> = [
    ["draft", freeCoupon("draft", { status: "draft" })],
    ["paused", freeCoupon("paused", { status: "paused" })],
    ["expired", freeCoupon("expired", { startsAt: new Date(NOW.getTime() - 2 * DAY), expiresAt: new Date(NOW.getTime() - 1) })],
    ["future", freeCoupon("future", { startsAt: new Date(NOW.getTime() + 1), expiresAt: new Date(NOW.getTime() + DAY) })],
    ["discount", freeCoupon("discount", { type: "discount_coupon", accessPlanId: null, durationDays: null, discountType: "percentage", discountValue: 10, eligiblePlanIds: ["creator"] })],
    ["missing", null],
  ];
  for (const [index, [label, coupon]] of cases.entries()) {
    const repo = new MemoryRepository(); repo.setUserRole("admin-a", "admin"); repo.setUserRole("user-a", "user");
    if (coupon) await repo.createPromotion(coupon);
    const route = createFreeAccessCouponRedemptionRoute(() => runtimeFor(repo, "user-a"));
    const response = await route(request({ code: coupon?.code ?? "MISSING3" }, `redeem-request-${String(index).padStart(8, "0")}`));
    assert.equal(response.status, 409, label);
    assert.equal((await response.json() as { error: string }).error, "coupon_unavailable");
    assert.equal(repo.promotionRedemptions.size, 0);
    assert.equal(repo.promotionalAccessGrants.size, 0);
  }
});

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: generic coupon reservation rejects free-access coupons without writing a redemption or grant`, async () => {
    const f = await repositoryFixture(kind);
    await f.repo.createPromotion(freeCoupon());
    const before = await snapshot(f, "free-coupon");
    const result = await f.repo.createOrGetPromotionRedemption({
      id: "legacy-free-redemption", promotionId: "free-coupon", userId: "user-a", idempotencyKey: "legacy-free-redemption-key", now: NOW,
    });
    assert.equal(result.status, "conflict");
    const after = await snapshot(f, "free-coupon");
    assert.deepEqual(after.redemptions, before.redemptions);
    assert.deepEqual(after.grants, before.grants);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.audit, before.audit);
  });
}

test("target-user and total usage limits are enforced", async () => {
  const targetRepo = new MemoryRepository(); targetRepo.setUserRole("admin-a", "admin"); targetRepo.setUserRole("user-a", "user"); targetRepo.setUserRole("user-b", "user");
  await targetRepo.createPromotion(freeCoupon("targeted", { targetUserId: "user-b" }));
  assert.equal(await createFreeAccessCouponRedemptionRoute(() => runtimeFor(targetRepo, "user-a"))(request({ code: "THREEDAYS" })).then((response) => response.status), 409);

  for (const kind of ["memory", "fake Prisma"] as const) {
    const f = await repositoryFixture(kind);
    await f.repo.createPromotion(freeCoupon("limited", { code: "LIMITED3", usageLimit: 1 }));
    if (f.repo instanceof MemoryRepository) {
      f.repo.promotionRedemptions.set("prior", { id: "prior", promotionId: "limited", userId: "user-b", status: "redeemed", idempotencyKey: "prior-redemption-key", planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null, manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: NOW, redeemedAt: NOW, releasedAt: null, createdAt: NOW, updatedAt: NOW });
    } else {
      await f.db!.promotionRedemption.create({ data: { id: "prior", promotionId: "limited", userId: "user-b", status: "redeemed", idempotencyKey: "prior-redemption-key", planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null, manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: NOW, redeemedAt: NOW, releasedAt: null, createdAt: NOW, updatedAt: NOW } });
    }
    const result = await f.repo.redeemFreeAccessCoupon({ redemptionId: `new-${kind.replaceAll(" ", "-")}`, grantId: `new-grant-${kind.replaceAll(" ", "-")}`, userId: "user-a", code: "LIMITED3", idempotencyKey: "limit-request-0000001", now: NOW });
    assert.equal(result.status, "unavailable", kind);
  }
});

for (const kind of ["memory", "fake Prisma"] as const) {
  test(`${kind}: free coupon redemption atomically creates a queued redemption/grant and correct lifecycle/audit events`, async () => {
    const f = await repositoryFixture(kind);
    await f.repo.createPromotion(freeCoupon());
    const before = await snapshot(f, "free-coupon");
    const result = await f.repo.redeemFreeAccessCoupon({ redemptionId: "redeem-one", grantId: "grant-one", userId: "user-a", code: " threedays ", idempotencyKey: IDEM, now: NOW });
    assert.equal(result.status, "created");
    if (result.status !== "created") return;
    assert.equal(result.redemption.status, "redeemed");
    assert.equal(result.redemption.payablePaise, null);
    assert.equal(result.redemption.manualPaymentIntentId, null);
    assert.equal(result.grant.status, "queued");
    assert.equal(result.grant.activationPolicy, "after_current_access");
    assert.equal(result.grant.planId, "pro");
    assert.equal(result.grant.durationDays, 3);
    assert.equal(result.grant.startsAt, null);
    assert.equal(result.grant.expiresAt, null);
    assert.deepEqual((await f.repo.listPromotionLifecycleEvents("free-coupon")).slice(before.events.length).map((event) => event.eventType), ["coupon_redeemed", "grant_created"]);
    const state = await snapshot(f, "free-coupon");
    assert.equal(state.redemptions.length, 1);
    assert.equal(state.grants.length, 1);
    assert.equal(state.audit.length - before.audit.length, 2);
    assert.equal(state.payments.length, 0);
    assert.equal(state.manualAccess.length, 0);
    assert.equal(state.subscriptions.length, 0);
  });

  test(`${kind}: paid access is unchanged and blocks the queued coupon grant until exact expiry`, async () => {
    const f = await repositoryFixture(kind);
    await f.repo.createPromotion(freeCoupon());
    const paidEnd = new Date(NOW.getTime() + 2 * DAY);
    await seedPaidAccess(f, paidEnd);
    const paidBefore = await snapshot(f, "free-coupon");
    const slug = kind.replaceAll(" ", "-");
    const redeemed = await f.repo.redeemFreeAccessCoupon({ redemptionId: `paid-redemption-${slug}`, grantId: `paid-grant-${slug}`, userId: "user-a", code: "THREEDAYS", idempotencyKey: "paid-access-request-01", now: NOW });
    assert.equal(redeemed.status, "created");
    assert.equal(await f.repo.getPlanIdForUser("user-a", NOW), "creator");
    assert.equal((await f.repo.listPromotionalAccessGrantsForUser("user-a"))[0]?.status, "queued");
    const whilePaid = await snapshot(f, "free-coupon");
    assert.deepEqual(whilePaid.manualAccess, paidBefore.manualAccess, "existing manual paid access remains byte-for-byte unchanged");
    assert.deepEqual(whilePaid.payments, paidBefore.payments);
    assert.deepEqual(whilePaid.subscriptions, paidBefore.subscriptions);
    assert.equal(await f.repo.getPlanIdForUser("user-a", paidEnd), "pro", "at the exact paid expiry the central resolver activates the queued grant");
    const grants = await f.repo.listPromotionalAccessGrantsForUser("user-a");
    assert.equal(grants[0]?.status, "active");
    assert.equal(grants[0]?.startsAt?.getTime(), paidEnd.getTime());
    assert.equal(grants[0]?.expiresAt?.getTime(), paidEnd.getTime() + 3 * DAY);
    const after = await snapshot(f, "free-coupon");
    assert.deepEqual(after.manualAccess, paidBefore.manualAccess);
    assert.deepEqual(after.payments, paidBefore.payments);
  });

  test(`${kind}: no-paid-access coupon grants activate through the existing entitlement resolver`, async () => {
    const f = await repositoryFixture(kind);
    await f.repo.createPromotion(freeCoupon());
    const slug = kind.replaceAll(" ", "-");
    const redeemed = await f.repo.redeemFreeAccessCoupon({ redemptionId: `free-redemption-${slug}`, grantId: `free-grant-${slug}`, userId: "user-a", code: "THREEDAYS", idempotencyKey: "no-paid-access-01", now: NOW });
    assert.equal(redeemed.status, "created");
    assert.equal(redeemed.status === "created" ? redeemed.grant.status : "missing", "queued", "redemption persists a queued grant; resolver owns activation");
    assert.equal(await f.repo.getPlanIdForUser("user-a", NOW), "pro");
    const grant = (await f.repo.listPromotionalAccessGrantsForUser("user-a"))[0]!;
    assert.equal(grant.status, "active");
    assert.equal(grant.startsAt?.getTime(), NOW.getTime());
    assert.equal(grant.expiresAt?.getTime(), NOW.getTime() + 3 * DAY);
  });

  test(`${kind}: concurrent duplicate redemptions create one redemption and one grant`, async () => {
    const f = await repositoryFixture(kind); await f.repo.createPromotion(freeCoupon());
    const before = await snapshot(f, "free-coupon");
    let attemptId = 0;
    const attempt = () => { const id = ++attemptId; return f.repo.redeemFreeAccessCoupon({ redemptionId: `concurrent-${kind.replaceAll(" ", "-")}-${id}`, grantId: `grant-concurrent-${id}`, userId: "user-a", code: "THREEDAYS", idempotencyKey: IDEM, now: NOW }); };
    const results = await Promise.all([attempt(), attempt()]);
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "existing").length, 1);
    const state = await snapshot(f, "free-coupon");
    assert.equal(state.redemptions.length, 1);
    assert.equal(state.grants.length, 1);
    assert.equal(state.events.length - before.events.length, 2);
    assert.equal(state.audit.length - before.audit.length, 2);
  });

  test(`${kind}: grant creation failure rolls back redemption and all events`, async () => {
    const f = await repositoryFixture(kind); await f.repo.createPromotion(freeCoupon());
    const before = await snapshot(f, "free-coupon");
    if (f.repo instanceof MemoryRepository) f.repo.beforePromotionalGrantInsert = () => false;
    else f.db!.promotionalAccessGrant.beforeCreate = () => { throw new Error("injected grant failure"); };
    const result = await f.repo.redeemFreeAccessCoupon({ redemptionId: "grant-fail-redemption", grantId: "grant-fail", userId: "user-a", code: "THREEDAYS", idempotencyKey: "grant-failure-000001", now: NOW });
    assert.equal(result.status, "conflict");
    const state = await snapshot(f, "free-coupon");
    assert.equal(state.redemptions.length, 0);
    assert.equal(state.grants.length, 0);
    assert.deepEqual(state.events, before.events);
    assert.deepEqual(state.audit, before.audit);
  });

  test(`${kind}: lifecycle or audit event failure rolls back redemption and grant`, async () => {
    for (const failure of ["grant_event", "grant_audit"] as const) {
      const f = await repositoryFixture(kind); await f.repo.createPromotion(freeCoupon());
      const before = await snapshot(f, "free-coupon");
      if (f.repo instanceof MemoryRepository) {
        if (failure === "grant_event") f.repo.beforePromotionEventInsert = (event) => event.eventType !== "grant_created";
        else f.repo.beforePromotionAuditInsert = (event) => event.eventType !== "grant_created";
      } else if (failure === "grant_event") {
        f.db!.promotionLifecycleEvent.beforeCreate = (data) => { if (data["eventType"] === "grant_created") throw new Error("injected lifecycle event failure"); };
      } else {
        f.db!.auditLog.beforeCreate = (data) => { if (data["action"] === "promotion.grant_created") throw new Error("injected audit failure"); };
      }
      const result = await f.repo.redeemFreeAccessCoupon({ redemptionId: `event-fail-redemption-${failure}`, grantId: `event-fail-${failure}`, userId: "user-a", code: "THREEDAYS", idempotencyKey: `event-failure-${failure}-0001`, now: NOW });
      assert.equal(result.status, "conflict", `${kind} ${failure}`);
      const state = await snapshot(f, "free-coupon");
      assert.equal(state.redemptions.length, 0, `${kind} ${failure}`);
      assert.equal(state.grants.length, 0, `${kind} ${failure}`);
      assert.deepEqual(state.events, before.events, `${kind} ${failure} lifecycle events roll back`);
      assert.deepEqual(state.audit, before.audit, `${kind} ${failure} audit entries roll back`);
    }
  });
}
