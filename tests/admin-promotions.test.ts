import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { createAdminPromotionDetailRoute, createAdminPromotionLifecycleHistoryRoute, createAdminPromotionRedemptionHistoryRoute, createAdminPromotionStatusRoute, createAdminPromotionUpdateRoute, createAdminPromotionsRoute } from "../src/server/admin/promotion-routes.ts";
import type { Runtime } from "../src/server/runtime.ts";

const now = new Date("2026-11-08T12:00:00.000Z");

function setup(role: "admin" | "user" | null = "admin") {
  const repo = new MemoryRepository();
  repo.setUserRole("admin-1", "admin");
  repo.setUserRole("user-1", "user");
  let nextId = 0;
  const runtime: Runtime = {
    mode: "local", repo,
    currentUserId: async () => role ? (role === "admin" ? "admin-1" : "user-1") : null,
    currentPrincipal: async () => role ? { userId: role === "admin" ? "admin-1" : "user-1", role } : null,
    newId: () => `promotion-${++nextId}`, now: () => now,
  };
  return { repo, route: createAdminPromotionsRoute(() => runtime), detailRoute: createAdminPromotionDetailRoute(() => runtime), redemptionHistoryRoute: createAdminPromotionRedemptionHistoryRoute(() => runtime), lifecycleHistoryRoute: createAdminPromotionLifecycleHistoryRoute(() => runtime), updateRoute: createAdminPromotionUpdateRoute(() => runtime), statusRoute: createAdminPromotionStatusRoute(() => runtime) };
}

function post(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(new Request("http://localhost/api/admin/promotions", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function put(route: (request: Request) => Promise<Response>, id: string, body: unknown, etag?: string, origin = "http://localhost") {
  return route(new Request(`http://localhost/api/admin/promotions/${id}`, {
    method: "PUT", headers: { origin, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify(body),
  }));
}

function patchStatus(route: (request: Request) => Promise<Response>, id: string, action: string, etag?: string, origin = "http://localhost") {
  return route(new Request(`http://localhost/api/admin/promotions/${id}`, {
    method: "PATCH", headers: { origin, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify({ action }),
  }));
}

const discountCoupon = (over: Record<string, unknown> = {}) => ({
  type: "discount_coupon", code: " save50 ", discountType: "percentage", discountValue: 50,
  eligiblePlanIds: ["creator"], startsAt: now.toISOString(), expiresAt: null, usageLimit: 25,
  targetUserId: null, reason: "Support promotion", ...over,
});

test("Admin coupon creation creates a normalized draft and repository audit event", async () => {
  const { repo, route } = setup();
  const response = await post(route, discountCoupon());
  assert.equal(response.status, 201);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.equal(body.data.code, "SAVE50");
  assert.equal(body.data.status, "draft", "creation must not activate a coupon");
  assert.equal(body.data.createdByAdminId, "admin-1", "actor is taken from the persisted principal");
  assert.equal(body.data.createdAt, now.toISOString());
  assert.deepEqual((await repo.listPromotionLifecycleEvents("promotion-1")).map((event) => event.eventType), ["promotion_created"]);
});

test("coupon creation rejects ordinary and unauthenticated callers before repository writes", async () => {
  for (const role of ["user", null] as const) {
    const { repo, route } = setup(role);
    const response = await post(route, discountCoupon());
    assert.equal(response.status, role === "user" ? 403 : 401);
    assert.equal((await repo.listPromotions({ skip: 0, take: 10 })).total, 0);
  }
});

test("promotion listing rejects ordinary and anonymous callers", async () => {
  for (const [role, status] of [["user", 403], [null, 401]] as const) {
    const { route } = setup(role);
    const response = await route(new Request("http://localhost/api/admin/promotions"));
    assert.equal(response.status, status);
  }
});

test("coupon detail is Admin-only, returns an allowlisted definition, and documents fixed discounts in paise", async () => {
  const { repo, route, detailRoute } = setup();
  const created = await post(route, discountCoupon({ discountType: "fixed_amount", discountValue: 1000 }));
  assert.equal(created.status, 201);
  const response = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  assert.equal(response.status, 200);
  const body = await response.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, "draft");
  assert.equal(body.data.discountValue, 1000);
  assert.equal(body.data.discountValueUnit, "paise");
  assert.equal("redemptions" in body.data, false);
  assert.equal("accessGrants" in body.data, false);
  assert.equal("lifecycleEvents" in body.data, false);
  assert.equal((await repo.listPromotionLifecycleEvents("promotion-1")).length, 1);
});

test("percentage coupon detail identifies whole percentage-point values", async () => {
  const { route, detailRoute } = setup();
  assert.equal((await post(route, discountCoupon({ discountType: "percentage", discountValue: 15 }))).status, 201);
  const response = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: Record<string, unknown> };
  assert.equal(data.discountValue, 15);
  assert.equal(data.discountValueUnit, "percentage_points");
});

test("coupon detail represents nullable fields as explicit nulls and dates as ISO strings", async () => {
  const { route, detailRoute } = setup();
  const body = { type: "free_access_coupon", code: "THREEDAY", accessPlanId: "pro", durationDays: 3, startsAt: now.toISOString(), expiresAt: null };
  assert.equal((await post(route, body)).status, 201);
  const response = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: Record<string, unknown> };
  assert.equal(data.discountType, null);
  assert.equal(data.discountValue, null);
  assert.equal(data.discountValueUnit, null);
  assert.equal(data.targetUserId, null);
  assert.equal(data.expiresAt, null);
  assert.equal(data.usageLimit, null);
  assert.equal(data.reason, null);
  assert.equal(data.startsAt, now.toISOString());
  assert.equal(data.createdAt, now.toISOString());
  assert.equal(data.updatedAt, now.toISOString());
});

test("GET coupon detail leaves promotion, redemption, grant, lifecycle, and audit snapshots unchanged", async () => {
  const { repo, detailRoute } = setup();
  const promotion = {
    id: "promotion-1", type: "free_access_coupon" as const, status: "active" as const, code: "THREEDAY", discountType: null, discountValue: null,
    accessPlanId: "pro" as const, durationDays: 3, eligiblePlanIds: [], targetUserId: null, startsAt: new Date(now.getTime() - 60_000),
    expiresAt: null, usageLimit: 5, createdByAdminId: "admin-1", reason: "test grant", createdAt: now, updatedAt: now,
  };
  assert.equal(await repo.createPromotion(promotion), true);
  const redemption = await repo.redeemFreeAccessCoupon({ redemptionId: "redemption-1", grantId: "grant-1", userId: "user-1", code: promotion.code!, idempotencyKey: "admin-detail-redemption", now });
  assert.equal(redemption.status, "created");

  const before = {
    promotion: await repo.getPromotion(promotion.id), redemptions: structuredClone([...repo.promotionRedemptions.entries()]),
    grants: structuredClone([...repo.promotionalAccessGrants.entries()]), lifecycle: structuredClone([...repo.promotionLifecycleEvents.entries()]), audit: structuredClone(repo.audit),
  };
  const response = await detailRoute(new Request(`http://localhost/api/admin/promotions/${promotion.id}`));
  assert.equal(response.status, 200);
  const after = {
    promotion: await repo.getPromotion(promotion.id), redemptions: structuredClone([...repo.promotionRedemptions.entries()]),
    grants: structuredClone([...repo.promotionalAccessGrants.entries()]), lifecycle: structuredClone([...repo.promotionLifecycleEvents.entries()]), audit: structuredClone(repo.audit),
  };
  assert.deepEqual(after, before);
});

test("coupon detail rejects anonymous and ordinary users and validates coupon identifiers", async () => {
  for (const [role, status] of [["user", 403], [null, 401]] as const) {
    const { detailRoute } = setup(role);
    assert.equal((await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).status, status);
  }
  const { detailRoute } = setup();
  assert.equal((await detailRoute(new Request("http://localhost/api/admin/promotions/missing"))).status, 404);
  assert.equal((await detailRoute(new Request("http://localhost/api/admin/promotions/%2F"))).status, 400);
});

test("coupon codes are case-insensitive and duplicate normalized codes conflict", async () => {
  const { route, repo } = setup();
  assert.equal((await post(route, discountCoupon({ code: "SAVE50" }))).status, 201);
  const duplicate = await post(route, discountCoupon({ code: "save50" }));
  assert.equal(duplicate.status, 409);
  assert.equal((await repo.listPromotions({ skip: 0, take: 10 })).total, 1);
});

test("coupon creation rejects forged status/actor fields and invalid or excessive discounts", async () => {
  const { repo, route } = setup();
  for (const body of [
    discountCoupon({ status: "active" }),
    discountCoupon({ createdByAdminId: "user-1" }),
    discountCoupon({ discountValue: 51 }),
    discountCoupon({ discountValue: 0 }),
    discountCoupon({ discountValue: -1 }),
    discountCoupon({ type: "discount_coupon", discountType: "fixed_amount", discountValue: 24_951 }),
    discountCoupon({ accessPlanId: "pro", durationDays: 3 }),
    discountCoupon({ eligiblePlanIds: ["free"] }),
    discountCoupon({ expiresAt: now.toISOString() }),
    (() => { const body = discountCoupon() as Record<string, unknown>; delete body.startsAt; return body; })(),
  ]) assert.equal((await post(route, body)).status, 400);
  assert.equal((await repo.listPromotions({ skip: 0, take: 10 })).total, 0);
});

test("free-access coupon creation requires a paid tier and a duration no longer than 30 days", async () => {
  const { repo, route } = setup();
  const body = { type: "free_access_coupon", code: "THREEDAY", accessPlanId: "pro", durationDays: 3, startsAt: now.toISOString(), expiresAt: null };
  const response = await post(route, body);
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { data: Record<string, unknown> }).data.status, "draft");
  assert.equal((await post(route, { ...body, code: "TOOLONG", durationDays: 31 })).status, 400);
  assert.equal((await post(route, { ...body, code: "HASDISC", discountValue: 100 })).status, 400);
  assert.equal((await repo.listPromotions({ skip: 0, take: 10 })).total, 1);
});

test("coupon listing has bounded pagination and no-store responses", async () => {
  const { route } = setup();
  const response = await route(new Request("http://localhost/api/admin/promotions?page=1&pageSize=5"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { data: [], page: 1, pageSize: 5, total: 0 });
  assert.equal((await route(new Request("http://localhost/api/admin/promotions?pageSize=101"))).status, 400);
  assert.equal((await route(new Request("http://localhost/api/admin/promotions?page=1000001&pageSize=1"))).status, 400);
  assert.equal((await route(new Request("http://localhost/api/admin/promotions?page=102&pageSize=100"))).status, 400, "offsets above 10,000 are rejected");
  assert.equal((await route(new Request("http://localhost/api/admin/promotions?page=101&pageSize=100"))).status, 200, "maximum supported offset remains available");
  assert.equal((await route(new Request("http://localhost/api/admin/promotions?unknown=x"))).status, 400);
});

test("Admin coupon listing supports code search, coupon type and status filters", async () => {
  const { repo, route } = setup();
  const discount = await post(route, discountCoupon());
  assert.equal(discount.status, 201);
  const free = await post(route, { type: "free_access_coupon", code: "SAVEFREE", accessPlanId: "pro", durationDays: 3, startsAt: now.toISOString(), expiresAt: null });
  assert.equal(free.status, 201);
  const all = await route(new Request("http://localhost/api/admin/promotions?search=save&type=discount_coupon&status=draft"));
  assert.equal(all.status, 200);
  assert.deepEqual((await all.json() as { data: Array<{ code: string }>; total: number }).data.map((item) => item.code), ["SAVE50"]);
  const freeOnly = await route(new Request("http://localhost/api/admin/promotions?type=free_access_coupon"));
  assert.deepEqual((await freeOnly.json() as { data: Array<{ code: string }> }).data.map((item) => item.code), ["SAVEFREE"]);
  for (const query of ["?type=bonus_days", "?status=unknown", "?search=bad%20code", "?search=" + "a".repeat(65)]) {
    assert.equal((await route(new Request(`http://localhost/api/admin/promotions${query}`))).status, 400, query);
  }
});

test("coupon list and detail return status-separated usage counts using limit semantics", async () => {
  const { repo, route, detailRoute } = setup();
  assert.equal((await post(route, discountCoupon({ usageLimit: 5 }))).status, 201);
  for (const [index, status] of (["reserved", "redeemed", "released", "manual_review"] as const).entries()) {
    repo.promotionRedemptions.set(`redemption-${index}`, { id: `redemption-${index}`, promotionId: "promotion-1", userId: `user-${index}`, status, idempotencyKey: `key-${index}`, planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR", manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: now, redeemedAt: null, releasedAt: null, createdAt: now, updatedAt: now });
  }
  const list = await route(new Request("http://localhost/api/admin/promotions"));
  const listed = await list.json() as { data: Array<{ usage: Record<string, number | null> }> };
  assert.deepEqual(listed.data[0]!.usage, { reserved: 1, redeemed: 1, released: 1, manualReview: 1, countsTowardUsageLimit: 3, usageLimit: 5, remainingSlots: 2 });
  const detail = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  const detailed = await detail.json() as { data: { usage: unknown } };
  assert.deepEqual(detailed.data.usage, listed.data[0]!.usage);
});

test("redemption and lifecycle history APIs are Admin-only, bounded, paginated, and allowlist DTO fields", async () => {
  for (const [role, expected] of [[null, 401], ["user", 403]] as const) {
    const { redemptionHistoryRoute, lifecycleHistoryRoute } = setup(role);
    assert.equal((await redemptionHistoryRoute(new Request("http://localhost/api/admin/promotions/coupon/redemptions"))).status, expected);
    assert.equal((await lifecycleHistoryRoute(new Request("http://localhost/api/admin/promotions/coupon/lifecycle"))).status, expected);
  }
  const { repo, route, redemptionHistoryRoute, lifecycleHistoryRoute } = setup();
  await post(route, discountCoupon());
  repo.promotionLifecycleEvents.clear(); repo.audit.length = 0; // Legacy coupon with no recorded history.
  const emptyRedemptions = await redemptionHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/redemptions"));
  const emptyEvents = await lifecycleHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/lifecycle"));
  assert.deepEqual(await emptyRedemptions.json(), { data: [], page: 1, pageSize: 25, total: 0 });
  assert.deepEqual(await emptyEvents.json(), { data: [], page: 1, pageSize: 25, total: 0 });
  repo.promotionRedemptions.set("history-redemption", { id: "history-redemption", promotionId: "promotion-1", userId: "user-1", status: "reserved", idempotencyKey: "do-not-return-this", planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR", manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: now, redeemedAt: null, releasedAt: null, createdAt: now, updatedAt: now });
  repo.promotionLifecycleEvents.set("internal:event:key", { id: "event-1", eventKey: "internal:event:key", eventType: "coupon_reserved", promotionId: "promotion-1", subjectUserId: "user-1", actorUserId: null, redemptionId: "history-redemption", accessGrantId: null, occurredAt: now, outcome: "held", metadata: { privatePayload: "do-not-return" } });
  const redemptions = await redemptionHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/redemptions?page=1&pageSize=1"));
  assert.equal(redemptions.status, 200);
  const redBody = await redemptions.json() as { data: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
  assert.deepEqual(Object.keys(redBody.data[0]!).sort(), ["createdAt", "currency", "discountPaise", "id", "interval", "listPricePaise", "payablePaise", "planId", "status", "updatedAt", "userDisplayIdentifier"].sort());
  assert.equal(redBody.data[0]?.userDisplayIdentifier, "user-1");
  assert.equal("idempotencyKey" in redBody.data[0]!, false);
  assert.deepEqual([redBody.page, redBody.pageSize, redBody.total], [1, 1, 1]);
  const events = await lifecycleHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/lifecycle"));
  const eventBody = await events.json() as { data: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(eventBody.data[0]!).sort(), ["accessGrantId", "actorUserId", "auditUrl", "eventType", "id", "occurredAt", "outcome", "redemptionId", "subjectUserId"].sort());
  assert.equal("metadata" in eventBody.data[0]!, false);
  assert.equal("eventKey" in eventBody.data[0]!, false);
  assert.equal((await redemptionHistoryRoute(new Request("http://localhost/api/admin/promotions/missing/redemptions"))).status, 404);
  assert.equal((await lifecycleHistoryRoute(new Request("http://localhost/api/admin/promotions/missing/lifecycle"))).status, 404);
  assert.equal((await redemptionHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/redemptions?page=1000001&pageSize=1"))).status, 400);
  assert.equal((await lifecycleHistoryRoute(new Request("http://localhost/api/admin/promotions/promotion-1/lifecycle?unexpected=x"))).status, 400);
});

test("malformed coupon JSON receives a safe validation response", async () => {
  const { route } = setup();
  const response = await route(new Request("http://localhost/api/admin/promotions", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{not-json",
  }));
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /invalid_request/);
  assert.doesNotMatch(text, /SyntaxError|Unexpected token|not-json/);
});

test("coupon creation rejects cross-origin requests", async () => {
  const { route } = setup();
  const response = await route(new Request("http://localhost/api/admin/promotions", {
    method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify(discountCoupon()),
  }));
  assert.equal(response.status, 403);
});

test("coupon edit denies anonymous and ordinary users", async () => {
  for (const role of ["user", null] as const) {
    const { updateRoute } = setup(role);
    const response = await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }));
    assert.equal(response.status, role === "user" ? 403 : 401);
  }
});

test("Admin can edit draft terms with the detail ETag and gets atomic lifecycle/audit records", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const detail = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  assert.equal(detail.status, 200);
  const before = (await detail.json() as { data: Record<string, unknown> }).data;
  const response = await put(updateRoute, "promotion-1", discountCoupon({ code: "SAVE25", discountValue: 25 }), detail.headers.get("etag") ?? undefined);
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get("etag"), detail.headers.get("etag"));
  const { data } = await response.json() as { data: Record<string, unknown> };
  assert.equal(data.code, "SAVE25");
  assert.equal(data.discountValue, 25);
  assert.equal(data.discountValueUnit, "percentage_points");
  assert.equal(data.status, "draft");
  assert.equal(data.createdByAdminId, "admin-1");
  assert.equal(data.createdAt, before.createdAt);
  assert.deepEqual((await repo.listPromotionLifecycleEvents("promotion-1")).map((event) => event.eventType), ["promotion_created", "promotion_updated"]);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["promotion.promotion_created", "promotion.promotion_updated"]);
});

test("coupon edit rejects active and inactive coupons, missing coupons, and stale versions", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const detail = await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"));
  const etag = detail.headers.get("etag")!;
  repo.promotions.set("promotion-1", { ...repo.promotions.get("promotion-1")!, status: "active" });
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }), etag)).status, 409);
  repo.promotions.set("promotion-1", { ...repo.promotions.get("promotion-1")!, status: "paused" });
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }), etag)).status, 409);
  assert.equal((await put(updateRoute, "missing", discountCoupon(), etag)).status, 404);
  repo.promotions.set("promotion-1", { ...repo.promotions.get("promotion-1")!, status: "draft" });
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }), '"2026-11-08T12:00:00.010Z"')).status, 409);
});

test("coupon edit rejects unsupported immutable fields and invalid coupon values", async () => {
  const { route, detailRoute, updateRoute, repo } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  for (const body of [
    discountCoupon({ id: "other" }), discountCoupon({ status: "active" }), discountCoupon({ createdByAdminId: "user-1" }),
    { type: "free_access_coupon", code: "SAVE50", accessPlanId: "pro", durationDays: 3, startsAt: now.toISOString(), expiresAt: null },
    discountCoupon({ discountValue: 0 }), discountCoupon({ discountValue: -1 }), discountCoupon({ discountValue: 51 }),
    discountCoupon({ startsAt: "bad-date" }), discountCoupon({ expiresAt: now.toISOString() }),
  ]) assert.equal((await put(updateRoute, "promotion-1", body, etag)).status, 400);
  assert.equal((await repo.getPromotion("promotion-1"))?.discountValue, 50);
  assert.equal((await repo.listPromotionLifecycleEvents("promotion-1")).length, 1);
});

test("Admin coupon PUT requires If-Match and rejects cross-origin requests", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }))).status, 428);
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }), etag, "https://attacker.invalid")).status, 403);
  assert.equal((await repo.getPromotion("promotion-1"))?.discountValue, 50);
});

test("draft coupon edit rejects a well-formed but nonexistent target user and accepts a real target", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  const missing = await put(updateRoute, "promotion-1", discountCoupon({ targetUserId: "unknown-user" }), etag);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /invalid_target_user/);
  assert.equal((await repo.getPromotion("promotion-1"))?.targetUserId, null);
  const valid = await put(updateRoute, "promotion-1", discountCoupon({ targetUserId: "user-1" }), etag);
  assert.equal(valid.status, 200, "a failed validation does not advance the coupon version");
  assert.equal((await repo.getPromotion("promotion-1"))?.targetUserId, "user-1");
});

test("coupon status transitions deny anonymous and ordinary users", async () => {
  for (const role of ["user", null] as const) {
    const { statusRoute } = setup(role);
    const response = await patchStatus(statusRoute, "coupon", "activate", '"etag"');
    assert.equal(response.status, role === "user" ? 403 : 401);
  }
});

test("Admin explicitly activates a draft coupon with immutable terms and atomic audit history", async () => {
  const { repo, route, detailRoute, statusRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const before = await repo.getPromotion("promotion-1");
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  const response = await patchStatus(statusRoute, "promotion-1", "activate", etag);
  assert.equal(response.status, 200);
  const { data } = await response.json() as { data: Record<string, unknown> };
  assert.equal(data.status, "active");
  assert.notEqual(response.headers.get("etag"), etag);
  const after = await repo.getPromotion("promotion-1");
  assert.ok(before && after);
  for (const key of ["id", "type", "code", "discountType", "discountValue", "eligiblePlanIds", "createdByAdminId", "createdAt"] as const) assert.deepEqual(after[key], before[key], `${key} remains immutable`);
  assert.deepEqual((await repo.listPromotionLifecycleEvents("promotion-1")).map((event) => event.eventType), ["promotion_created", "promotion_updated"]);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["promotion.promotion_created", "promotion.promotion_updated"]);
});

test("coupon activation/deactivation enforce source states, If-Match, and same-origin", async () => {
  const { repo, route, detailRoute, statusRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const draftEtag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  assert.equal((await patchStatus(statusRoute, "promotion-1", "deactivate", draftEtag)).status, 409, "draft cannot be deactivated");
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate")).status, 428);
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", draftEtag, "https://attacker.invalid")).status, 403);
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", '"stale"')).status, 409);
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", draftEtag)).status, 200);
  const activeEtag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", activeEtag)).status, 409, "repeated activation is rejected");
  assert.equal((await patchStatus(statusRoute, "promotion-1", "deactivate", '"stale"')).status, 409);
  assert.equal((await patchStatus(statusRoute, "promotion-1", "deactivate", activeEtag)).status, 200);
  assert.equal((await repo.getPromotion("promotion-1"))?.status, "paused");
  const pausedEtag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  assert.equal((await patchStatus(statusRoute, "promotion-1", "deactivate", pausedEtag)).status, 409, "repeated deactivation is rejected");
  const lifecycleBeforeReactivation = await repo.listPromotionLifecycleEvents("promotion-1");
  const auditBeforeReactivation = structuredClone(repo.audit);
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", pausedEtag)).status, 409, "paused coupons cannot be reactivated");
  assert.equal((await repo.getPromotion("promotion-1"))?.status, "paused");
  assert.deepEqual(await repo.listPromotionLifecycleEvents("promotion-1"), lifecycleBeforeReactivation);
  assert.deepEqual(repo.audit, auditBeforeReactivation);
});

test("coupon status audit failure rolls the status transition back", async () => {
  const { repo, route, detailRoute, statusRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  repo.beforePromotionEventInsert = (event) => event.eventType !== "promotion_updated";
  assert.equal((await patchStatus(statusRoute, "promotion-1", "activate", etag)).status, 409);
  assert.equal((await repo.getPromotion("promotion-1"))?.status, "draft");
  assert.deepEqual((await repo.listPromotionLifecycleEvents("promotion-1")).map((event) => event.eventType), ["promotion_created"]);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["promotion.promotion_created"]);
});

test("audit failure rolls back draft coupon edits and the lifecycle event", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, discountCoupon())).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  const before = await repo.getPromotion("promotion-1");
  repo.beforePromotionEventInsert = (event) => event.eventType !== "promotion_updated";
  assert.equal((await put(updateRoute, "promotion-1", discountCoupon({ discountValue: 20 }), etag)).status, 409);
  assert.deepEqual(await repo.getPromotion("promotion-1"), before);
  assert.deepEqual((await repo.listPromotionLifecycleEvents("promotion-1")).map((event) => event.eventType), ["promotion_created"]);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["promotion.promotion_created"]);
});

test("coupon edit refuses any existing redemption or grant history", async () => {
  const { repo, route, detailRoute, updateRoute } = setup();
  assert.equal((await post(route, { type: "free_access_coupon", code: "FREE3", accessPlanId: "pro", durationDays: 3, startsAt: now.toISOString(), expiresAt: null })).status, 201);
  const etag = (await detailRoute(new Request("http://localhost/api/admin/promotions/promotion-1"))).headers.get("etag")!;
  repo.promotions.set("promotion-1", { ...repo.promotions.get("promotion-1")!, status: "active" });
  const redemption = await repo.redeemFreeAccessCoupon({ redemptionId: "redeem-1", grantId: "grant-1", userId: "user-1", code: "FREE3", idempotencyKey: "admin-edit-free-redemption", now });
  assert.equal(redemption.status, "created");
  repo.promotions.set("promotion-1", { ...repo.promotions.get("promotion-1")!, status: "draft" });
  assert.equal((await put(updateRoute, "promotion-1", { type: "free_access_coupon", code: "FREE3", accessPlanId: "pro", durationDays: 4, startsAt: now.toISOString(), expiresAt: null }, etag)).status, 409);
});
