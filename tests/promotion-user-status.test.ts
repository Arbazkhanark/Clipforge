import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { Runtime } from "../src/server/runtime.ts";
import type { PromotionRecord } from "../src/server/repository.ts";
import { createFreeAccessCouponRedemptionRoute } from "../src/server/promotions/free-access-redemption.ts";
import { createPromotionRedemptionStatusRoute } from "../src/server/promotions/redemption-status.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const now = new Date("2026-11-08T12:00:00.000Z");
const coupon = (id: string, code: string, type: "discount_coupon" | "free_access_coupon"): PromotionRecord => ({
  id, type, status: "active", code, discountType: type === "discount_coupon" ? "percentage" : null, discountValue: type === "discount_coupon" ? 10 : null,
  accessPlanId: type === "free_access_coupon" ? "pro" : null, durationDays: type === "free_access_coupon" ? 3 : null, eligiblePlanIds: type === "discount_coupon" ? ["creator"] : [],
  targetUserId: null, startsAt: new Date(now.getTime() - 1_000), expiresAt: null, usageLimit: 5, createdByAdminId: "admin-a", reason: null, createdAt: now, updatedAt: now,
});
const runtime = (repo: MemoryRepository | PrismaRepository, owner: string | null): Runtime => ({ mode: "local", repo, currentUserId: async () => owner, newId: (() => { let id = 0; return () => `id_${++id}`; })(), now: () => now } as Runtime);

async function fixture(kind: "memory" | "fake-prisma") {
  const db = kind === "fake-prisma" ? new FakePrismaClient() : null;
  const repo = db ? new PrismaRepository(db) : new MemoryRepository();
  if (repo instanceof MemoryRepository) { repo.setUserRole("admin-a", "admin"); repo.setUserRole("user-a", "user"); repo.setUserRole("user-b", "user"); }
  else for (const [id, role] of [["admin-a", "admin"], ["user-a", "user"], ["user-b", "user"]] as const) await db!.user.create({ data: { id, role } });
  return { repo, db };
}

for (const kind of ["memory", "fake-prisma"] as const) {
  test(`${kind}: owner-scoped status returns a safe discounted reservation snapshot`, async () => {
    const { repo } = await fixture(kind);
    await repo.createPromotion(coupon("discount", "TENOFF", "discount_coupon"));
    const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: "intent-a", userId: "user-a", idempotencyKey: "discount-status-key-0001", planId: "creator", interval: "weekly", couponCode: "TENOFF", now });
    assert.equal(reserved.status, "created");
    if (reserved.status !== "created") return;
    await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user-a", status: "created", providerPaymentLinkId: "plink-status", checkoutUrl: "https://rzp.io/i/status", now });
    const status = await repo.getUserPromotionRedemptionStatus("user-a", reserved.redemption.id);
    assert.ok(status);
    assert.equal(status.redemption.status, "reserved");
    assert.equal(status.manualPayment?.status, "created");
    assert.equal(status.redemption.listPricePaise, 49_900);
    assert.equal(status.redemption.discountPaise, 4_990);
    assert.equal(status.redemption.payablePaise, 44_910);
    assert.equal(await repo.getUserPromotionRedemptionStatus("user-b", reserved.redemption.id), null);
  });

  test(`${kind}: free-access status returns the persisted grant and rejects mismatched owners`, async () => {
    const { repo } = await fixture(kind);
    await repo.createPromotion(coupon("free", "THREEACCESS", "free_access_coupon"));
    const result = await repo.redeemFreeAccessCoupon({ redemptionId: "redemption-free", grantId: "grant-free", userId: "user-a", code: "THREEACCESS", idempotencyKey: "free-status-key-00001", now });
    assert.equal(result.status, "created");
    if (result.status !== "created") return;
    const status = await repo.getUserPromotionRedemptionStatus("user-a", result.redemption.id);
    assert.ok(status);
    assert.equal(status.redemption.status, "redeemed");
    assert.equal(status.manualPayment, null);
    assert.equal(status.grant?.status, "queued");
    assert.equal(status.grant?.planId, "pro");
    assert.equal(await repo.getUserPromotionRedemptionStatus("user-b", result.redemption.id), null);
  });
}

test("promotion redemption status API requires authentication and conceals other users' redemptions", async () => {
  const { repo } = await fixture("memory");
  await repo.createPromotion(coupon("free", "THREEACCESS", "free_access_coupon"));
  const redeem = createFreeAccessCouponRedemptionRoute(() => runtime(repo, "user-a"));
  const redemptionResponse = await redeem(new Request("http://localhost/api/promotions/redeem", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": "free-status-key-00001" }, body: JSON.stringify({ code: "THREEACCESS" }) }));
  const redemption = (await redemptionResponse.json() as { data: { redemption: { id: string } } }).data.redemption;
  const path = `http://localhost/api/promotions/redemptions/${redemption.id}`;
  assert.equal((await createPromotionRedemptionStatusRoute(() => runtime(repo, null))(new Request(path))).status, 401);
  assert.equal((await createPromotionRedemptionStatusRoute(() => runtime(repo, "user-a"))(new Request(path, { headers: { origin: "https://localhost" } }))).status, 403, "status reads require exact same origin when an Origin header is present");
  assert.equal((await createPromotionRedemptionStatusRoute(() => runtime(repo, "user-b"))(new Request(path))).status, 404);
  const ownerResponse = await createPromotionRedemptionStatusRoute(() => runtime(repo, "user-a"))(new Request(path));
  assert.equal(ownerResponse.status, 200);
  const body = await ownerResponse.json() as { data: Record<string, unknown> };
  const serialized = JSON.stringify(body);
  assert.match(serialized, /queued/);
  assert.doesNotMatch(serialized, /idempotencyKey|eventKey|metadata|token|providerPayload|secret/);
  assert.equal((await createPromotionRedemptionStatusRoute(() => runtime(repo, "user-a"))(new Request("http://localhost/api/promotions/redemptions/missing"))).status, 404);
});
