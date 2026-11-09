import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { accessPeriodEnd } from "../src/lib/billing/access-period.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { createManualPayment, verifyManualPayment } from "../src/server/billing/manual-payment.ts";
import { RazorpayTestClient, type RazorpayTestConfig } from "../src/server/billing/razorpay-client.ts";
import { handleRazorpayWebhook } from "../src/server/billing/razorpay-webhook-handler.ts";

const now = new Date("2026-01-31T12:30:00.000Z");
const config: RazorpayTestConfig = { keyId: "rzp_test_fake", keySecret: "test-secret-fake", webhookSecret: "test-webhook-secret", subscriptionPlanIds: {}, subscriptionTotalCount: 12 };
const request = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function runtime(repo: MemoryRepository, owner: string | null = "user_a", clock = now): Runtime { return { mode: "database", repo, currentUserId: async () => owner, newId: () => "manual_intent_test_12345", now: () => clock } as Runtime; }
function apiClient(fetcher: (url: string) => Response | Promise<Response>) { return new RazorpayTestClient(config, async (input) => fetcher(String(input))); }

test("manual access ends after exactly seven days or one clamped calendar month", () => {
  assert.equal(accessPeriodEnd(new Date("2026-01-31T12:30:00.000Z"), "weekly").toISOString(), "2026-02-07T12:30:00.000Z");
  assert.equal(accessPeriodEnd(new Date("2026-01-31T12:30:00.000Z"), "monthly").toISOString(), "2026-02-28T12:30:00.000Z");
  assert.equal(accessPeriodEnd(new Date("2024-01-31T12:30:00.000Z"), "monthly").toISOString(), "2024-02-29T12:30:00.000Z");
});

test("manual checkout requires auth, takes catalog price, is idempotent, and keeps ambiguous links in review", async () => {
  const repo = new MemoryRepository();
  const unauth = await createManualPayment(request("https://clipforge.test/manual", { planId: "creator", interval: "weekly" }, { "idempotency-key": "request_key_123456789" }), runtime(repo, null), undefined, config);
  assert.equal(unauth.status, 401);
  let creates = 0;
  const client = apiClient(async (url) => { if (url.endsWith("/payment_links")) { creates++; return Response.json({ id: "plink_fake", short_url: "https://rzp.io/i/fake", amount: 49900, currency: "INR", status: "created", reference_id: "manual_intent_test_12345" }); } return Response.json({}); });
  const req = () => request("https://clipforge.test/manual", { planId: "creator", interval: "weekly", amount: 1 }, { "idempotency-key": "request_key_123456789" });
  const first = await createManualPayment(req(), runtime(repo), client, config);
  const second = await createManualPayment(req(), runtime(repo), client, client ? config : null);
  assert.equal(first.status, 201); assert.equal(second.status, 200); assert.equal(creates, 1);
  assert.deepEqual(await first.json(), { intentId: "manual_intent_test_12345", checkoutUrl: "https://rzp.io/i/fake", status: "created", autoRenew: false });
  assert.deepEqual(await second.json(), { intentId: "manual_intent_test_12345", checkoutUrl: "https://rzp.io/i/fake", status: "created" }, "full-price idempotent response remains unchanged");
  assert.equal(repo.manualPaymentIntents.get("manual_intent_test_12345")?.amountPaise, 49900);
  assert.equal(repo.manualPaymentIntents.get("manual_intent_test_12345")?.status, "created");

  const uncertainRepo = new MemoryRepository();
  const uncertain = await createManualPayment(req(), runtime(uncertainRepo), apiClient(() => new Response("provider failure", { status: 500 })), config);
  assert.equal(uncertain.status, 503);
  assert.equal(uncertainRepo.manualPaymentIntents.get("manual_intent_test_12345")?.status, "manual_review");
});

test("discounted manual checkout uses the persisted server-calculated amount for weekly and monthly links", async () => {
  for (const interval of ["weekly", "monthly"] as const) {
    const repo = new MemoryRepository(); repo.setUserRole("admin_a", "admin"); repo.setUserRole("user_a", "user");
    const now = new Date("2026-11-08T10:00:00.000Z");
    await repo.createPromotion({ id: `discount_${interval}`, type: "discount_coupon", status: "active", code: `TEN${interval.toUpperCase()}`, discountType: "percentage", discountValue: 10,
      accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"], targetUserId: null, startsAt: new Date(now.getTime() - 1), expiresAt: null, usageLimit: 5, createdByAdminId: "admin_a", reason: null, createdAt: now, updatedAt: now });
    let providerAmount = 0;
    let providerCalls = 0;
    const client = new RazorpayTestClient(config, async (_input, init) => {
      providerCalls++;
      const body = JSON.parse(String(init?.body)) as { amount: number; reference_id: string };
      providerAmount = body.amount;
      return Response.json({ id: `plink_${interval}`, short_url: "https://rzp.io/i/discount", amount: body.amount, currency: "INR", status: "created", reference_id: body.reference_id });
    });
    const currentRuntime = { ...runtime(repo, "user_a", now), newId: () => `intent_${interval}_123456` } as Runtime;
    const checkoutRequest = () => request("https://clipforge.test/manual", { planId: "creator", interval, couponCode: ` ten${interval} `, amount: 1, discountPaise: 49_899 }, { "idempotency-key": `discount-${interval}-request-0001` });
    const response = await createManualPayment(checkoutRequest(), currentRuntime, client, config);
    const replay = await createManualPayment(checkoutRequest(), currentRuntime, client, config);
    const expectedListPrice = interval === "weekly" ? 49_900 : 199_900;
    const expectedDiscount = Math.floor(expectedListPrice * 10 / 100);
    const intent = repo.manualPaymentIntents.get(`intent_${interval}_123456`);
    assert.equal(response.status, 201, interval);
    assert.equal(replay.status, 200, `${interval} replay returns the existing checkout`);
    const responseBody = await response.json() as { coupon: { redemptionId: string; status: string; listPricePaise: number; discountPaise: number; payablePaise: number; currency: string }; paymentStatus: string };
    const replayBody = await replay.json() as typeof responseBody;
    assert.equal(responseBody.coupon.status, "reserved");
    assert.deepEqual({ list: responseBody.coupon.listPricePaise, discount: responseBody.coupon.discountPaise, payable: responseBody.coupon.payablePaise }, { list: expectedListPrice, discount: expectedDiscount, payable: providerAmount });
    assert.equal(responseBody.paymentStatus, "pending");
    assert.deepEqual(replayBody.coupon, responseBody.coupon, "replay returns the same persisted snapshot");
    assert.equal(replayBody.paymentStatus, "pending");
    assert.equal(providerCalls, 1, `${interval} replay does not create another provider link`);
    assert.equal(providerAmount, expectedListPrice - expectedDiscount, "provider receives the durable intent amount, not request amount fields");
    assert.equal(intent?.amountPaise, providerAmount);
    const redemption = [...repo.promotionRedemptions.values()][0];
    assert.equal(redemption?.status, "reserved");
    assert.equal(redemption?.discountPaise, expectedDiscount);
    assert.equal(repo.manualPayments.size, 0);
    assert.equal(repo.manualPlanAccesses.size, 0);
    assert.equal(repo.razorpaySubscriptions.size, 0);
  }
});

test("ambiguous discounted provider response keeps coupon reservation held for review", async () => {
  const repo = new MemoryRepository(); repo.setUserRole("admin_a", "admin"); repo.setUserRole("user_a", "user");
  await repo.createPromotion({ id: "discount_uncertain", type: "discount_coupon", status: "active", code: "UNCERTAIN10", discountType: "percentage", discountValue: 10,
    accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"], targetUserId: null, startsAt: new Date(now.getTime() - 1), expiresAt: null, usageLimit: 1, createdByAdminId: "admin_a", reason: null, createdAt: now, updatedAt: now });
  const response = await createManualPayment(request("https://clipforge.test/manual", { planId: "creator", interval: "weekly", couponCode: "UNCERTAIN10" }, { "idempotency-key": "uncertain-coupon-request-1" }), runtime(repo), apiClient(() => new Response("provider failure", { status: 500 })), config);
  assert.equal(response.status, 503);
  assert.equal([...repo.manualPaymentIntents.values()][0]?.status, "manual_review");
  assert.equal([...repo.promotionRedemptions.values()][0]?.status, "reserved");
  assert.equal(repo.promotionLifecycleEvents.size, 2, "promotion creation and reservation events only; no release event is fabricated");
  assert.equal(repo.manualPayments.size, 0);
  assert.equal(repo.manualPlanAccesses.size, 0);
});

test("browser verification and paid webhook both use atomic discounted settlement", async () => {
  const now = new Date("2026-11-08T10:00:00.000Z");
  const makeRepo = async (code: string) => {
    const repo = new MemoryRepository(); repo.setUserRole("admin_a", "admin"); repo.setUserRole("user_a", "user");
    await repo.createPromotion({ id: `promotion_${code}`, type: "discount_coupon", status: "active", code, discountType: "percentage", discountValue: 10,
      accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"], targetUserId: null, startsAt: new Date(now.getTime() - 1), expiresAt: null, usageLimit: 5, createdByAdminId: "admin_a", reason: null, createdAt: now, updatedAt: now });
    return repo;
  };
  const recordSettlementCalls = (repo: MemoryRepository) => {
    let calls = 0; const settle = repo.settleManualPayment.bind(repo);
    repo.settleManualPayment = async (input) => { calls++; return settle(input); };
    return () => calls;
  };

  const browserRepo = await makeRepo("BROWSER10"); const browserCalls = recordSettlementCalls(browserRepo);
  const browserClient = new RazorpayTestClient(config, async (input, init) => {
    const url = String(input);
    if (url.endsWith("/payment_links") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { amount: number; reference_id: string };
      return Response.json({ id: "browser_link", short_url: "https://rzp.io/i/browser", amount: body.amount, currency: "INR", status: "created", reference_id: body.reference_id });
    }
    if (url.endsWith("/payment_links/browser_link")) return Response.json({ id: "browser_link", reference_id: "browser_intent_123456", amount: 44_910, amount_paid: 44_910, currency: "INR", status: "paid", payments: [{ payment_id: "browser_payment", amount: 44_910, status: "captured" }] });
    return Response.json({ id: "browser_payment", amount: 44_910, currency: "INR", status: "captured", created_at: Math.floor(now.getTime() / 1000) });
  });
  const browserRuntime = { ...runtime(browserRepo, "user_a", now), newId: () => "browser_intent_123456" } as Runtime;
  const browserRequest = request("https://clipforge.test/manual", { planId: "creator", interval: "weekly", couponCode: "BROWSER10" }, { "idempotency-key": "browser-discount-request-1" });
  assert.equal((await createManualPayment(browserRequest, browserRuntime, browserClient, config)).status, 201);
  assert.equal((await verifyManualPayment(request("https://clipforge.test/verify", { intentId: "browser_intent_123456", paymentId: "browser_payment" }), browserRuntime, browserClient, config)).status, 200);
  assert.equal(browserCalls(), 1);
  assert.equal(browserRepo.manualPaymentIntents.get("browser_intent_123456")?.status, "paid");
  assert.equal([...browserRepo.promotionRedemptions.values()][0]?.status, "redeemed");
  assert.equal(browserRepo.manualPayments.size, 1); assert.equal(browserRepo.manualPlanAccesses.size, 1);

  const webhookRepo = await makeRepo("WEBHOOK10"); const webhookCalls = recordSettlementCalls(webhookRepo);
  const reserved = await webhookRepo.reserveDiscountedManualPaymentIntent({ id: "webhook_intent_12345", userId: "user_a", idempotencyKey: "webhook-discount-request-1", planId: "creator", interval: "weekly", couponCode: "WEBHOOK10", now });
  assert.equal(reserved.status, "created"); if (reserved.status !== "created") return;
  await webhookRepo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user_a", status: "created", providerPaymentLinkId: "webhook_link", checkoutUrl: "https://rzp.io/i/webhook", now });
  const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "webhook_link", reference_id: reserved.intent.id, amount: 44_910, amount_paid: 44_910, currency: "INR", status: "paid", payments: [{ payment_id: "webhook_payment", amount: 44_910, status: "captured" }] } } } });
  const signature = createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
  const webhookClient = apiClient((url) => url.endsWith("/payment_links/webhook_link")
    ? Response.json({ id: "webhook_link", reference_id: reserved.intent.id, amount: 44_910, amount_paid: 44_910, currency: "INR", status: "paid", payments: [{ payment_id: "webhook_payment", amount: 44_910, status: "captured" }] })
    : Response.json({ id: "webhook_payment", amount: 44_910, currency: "INR", status: "captured", created_at: Math.floor(now.getTime() / 1000) }));
  const deliver = () => handleRazorpayWebhook(new Request("https://clipforge.test/webhook", { method: "POST", headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_discounted_settlement", "content-type": "application/json" }, body: raw }), { repo: webhookRepo, webhookSecret: "test-webhook-secret", manualPaymentClient: webhookClient, now: () => now });
  assert.equal((await deliver()).status, 200); assert.equal((await deliver()).status, 200);
  assert.equal(webhookCalls(), 2, "both webhook deliveries use the shared settlement operation");
  assert.equal(webhookRepo.manualPaymentIntents.get(reserved.intent.id)?.status, "paid");
  assert.equal(webhookRepo.promotionRedemptions.get(reserved.redemption.id)?.status, "redeemed");
  assert.equal(webhookRepo.manualPayments.size, 1); assert.equal(webhookRepo.manualPlanAccesses.size, 1);
});

test("unverified browser and webhook outcomes leave discounted reservations held without granting access", async () => {
  const repo = new MemoryRepository(); repo.setUserRole("admin_a", "admin"); repo.setUserRole("user_a", "user");
  await repo.createPromotion({ id: "uncertain-settlement", type: "discount_coupon", status: "active", code: "UNCERTAINSETTLE", discountType: "percentage", discountValue: 10,
    accessPlanId: null, durationDays: null, eligiblePlanIds: ["creator"], targetUserId: null, startsAt: new Date(now.getTime() - 1), expiresAt: null, usageLimit: 5, createdByAdminId: "admin_a", reason: null, createdAt: now, updatedAt: now });
  const reserved = await repo.reserveDiscountedManualPaymentIntent({ id: "uncertain_intent", userId: "user_a", idempotencyKey: "uncertain-settlement-12345", planId: "creator", interval: "weekly", couponCode: "UNCERTAINSETTLE", now });
  assert.equal(reserved.status, "created"); if (reserved.status !== "created") return;
  await repo.finishManualPaymentIntent({ id: reserved.intent.id, userId: "user_a", status: "created", providerPaymentLinkId: "uncertain_link", checkoutUrl: "https://rzp.io/i/uncertain", now });
  const unavailable = apiClient(() => new Response("unavailable", { status: 503 }));
  const browser = await verifyManualPayment(request("https://clipforge.test/verify", { intentId: reserved.intent.id, paymentId: "uncertain_payment" }), runtime(repo, "user_a", now), unavailable, config);
  assert.equal(browser.status, 400);
  const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "uncertain_link", reference_id: reserved.intent.id, amount: 44_910, amount_paid: 44_910, currency: "INR", status: "paid" } } } });
  const webhookSecret = config.webhookSecret ?? "test-webhook-secret";
  const signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  const webhook = await handleRazorpayWebhook(new Request("https://clipforge.test/webhook", { method: "POST", headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_uncertain_discount", "content-type": "application/json" }, body: raw }), { repo, webhookSecret, manualPaymentClient: unavailable, now: () => now });
  assert.equal(webhook.status, 503);
  assert.equal(repo.manualPaymentIntents.get(reserved.intent.id)?.status, "created");
  assert.equal(repo.promotionRedemptions.get(reserved.redemption.id)?.status, "reserved");
  assert.equal(repo.manualPayments.size, 0); assert.equal(repo.manualPlanAccesses.size, 0);
});

test("manual payment verification is owner-bound, checks captured provider records, and activates once", async () => {
  const repo = new MemoryRepository();
  const activeNow = new Date();
  const reserved = await repo.reserveManualPaymentIntent({ id: "manual_intent", userId: "user_a", idempotencyKey: "idempotency_manual_123", planId: "creator", interval: "monthly", amountPaise: 199900, now: activeNow });
  assert.equal(reserved.status, "created");
  await repo.finishManualPaymentIntent({ id: "manual_intent", userId: "user_a", status: "created", providerPaymentLinkId: "plink_1", checkoutUrl: "https://rzp.io/i/1", now: activeNow });
  const wrongOwner = await verifyManualPayment(request("https://clipforge.test/verify", { intentId: "manual_intent", paymentId: "pay_1" }), runtime(repo, "user_b"), apiClient(() => { throw new Error("should not call provider"); }), config);
  assert.equal(wrongOwner.status, 404);
  const client = apiClient((url) => url.includes("payment_links/")
    ? Response.json({ id: "plink_1", reference_id: "manual_intent", amount: 199900, amount_paid: 199900, currency: "INR", status: "paid", payments: [{ payment_id: "pay_1", amount: 199900, status: "captured" }] })
    : Response.json({ id: "pay_1", amount: 199900, currency: "INR", status: "captured", created_at: Math.floor(activeNow.getTime() / 1000) }));
  let settlementCalls = 0;
  const settle = repo.settleManualPayment.bind(repo);
  repo.settleManualPayment = async (input) => { settlementCalls++; return settle(input); };
  const verifyReq = () => request("https://clipforge.test/verify", { intentId: "manual_intent", paymentId: "pay_1" });
  const result = await verifyManualPayment(verifyReq(), runtime(repo, "user_a", activeNow), client, config);
  const replay = await verifyManualPayment(verifyReq(), runtime(repo, "user_a", activeNow), client, config);
  assert.equal(result.status, 200); assert.equal(replay.status, 200);
  assert.equal(settlementCalls, 2, "first verification and already-paid replay both use the shared settlement operation");
  assert.equal(repo.manualPlanAccesses.get("manual_intent")?.expiresAt.toISOString(), accessPeriodEnd(new Date(Math.floor(activeNow.getTime() / 1000) * 1000), "monthly").toISOString());
  assert.equal(await repo.getPlanIdForUser("user_a"), "creator");
  assert.equal(repo.manualPlanAccesses.size, 1);
});

test("invalid or wrong-amount manual provider payment does not grant access; conflicting recurring entitlement blocks mode switch", async () => {
  const repo = new MemoryRepository();
  const intent = await repo.reserveManualPaymentIntent({ id: "m1", userId: "user_a", idempotencyKey: "manual_key_123456789", planId: "pro", interval: "weekly", amountPaise: 99900, now });
  assert.equal(intent.status, "created");
  await repo.finishManualPaymentIntent({ id: "m1", userId: "user_a", status: "created", providerPaymentLinkId: "pl1", checkoutUrl: "https://rzp.io/i/1", now });
  const bad = await verifyManualPayment(request("https://clipforge.test/verify", { intentId: "m1", paymentId: "pay_bad" }), runtime(repo), apiClient((url) => url.includes("payment_links/") ? Response.json({ id: "pl1", reference_id: "m1", amount: 99900, amount_paid: 1, currency: "INR", status: "partially_paid", payments: [] }) : Response.json({})), config);
  assert.equal(bad.status, 400); assert.equal(await repo.getPlanIdForUser("user_a"), "free");
  repo.razorpaySubscriptions.set("sub_current", { userId: "user_a", planId: "pro", interval: "weekly", status: "active", lastEventAt: 1, currentPeriodEnd: new Date(now.getTime() + 86400000) });
  const conflict = await repo.reserveManualPaymentIntent({ id: "m2", userId: "user_a", idempotencyKey: "manual_key_223456789", planId: "creator", interval: "weekly", amountPaise: 49900, now });
  assert.equal(conflict.status, "conflict");
});

test("signed payment_link.paid webhook applies once and replay cannot extend access", async () => {
  const repo = new MemoryRepository();
  await repo.reserveManualPaymentIntent({ id: "intent_webhook", userId: "user_a", idempotencyKey: "webhook_key_123456789", planId: "agency", interval: "weekly", amountPaise: 149900, now });
  await repo.finishManualPaymentIntent({ id: "intent_webhook", userId: "user_a", status: "created", providerPaymentLinkId: "plink_webhook", checkoutUrl: "https://rzp.io/i/1", now });
  const raw = JSON.stringify({ event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_webhook", reference_id: "intent_webhook", amount: 149900, amount_paid: 149900, currency: "INR", status: "paid", paid_at: Math.floor(now.getTime() / 1000), payments: [{ payment_id: "pay_webhook", amount: 149900, status: "captured" }] } } } });
  const signature = createHmac("sha256", "webhook-secret").update(raw).digest("hex");
  const manualPaymentClient = apiClient((url) => url.includes("payment_links/") ? Response.json({ id: "plink_webhook", reference_id: "intent_webhook", amount: 149900, amount_paid: 149900, currency: "INR", status: "paid", payments: [{ payment_id: "pay_webhook", amount: 149900, status: "captured" }] }) : Response.json({ id: "pay_webhook", amount: 149900, currency: "INR", status: "captured", created_at: Math.floor(now.getTime() / 1000) }));
  const deliver = () => handleRazorpayWebhook(new Request("https://clipforge.test/api/payments/razorpay/webhook", { method: "POST", headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_manual_1", "content-type": "application/json" }, body: raw }), { repo, webhookSecret: "webhook-secret", manualPaymentClient, now: () => now });
  assert.equal((await deliver()).status, 200); assert.equal((await deliver()).status, 200);
  assert.equal(repo.manualPlanAccesses.size, 1);
  assert.equal(repo.manualPaymentIntents.get("intent_webhook")?.status, "paid");
});
