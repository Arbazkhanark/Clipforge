import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { Runtime } from "../src/server/runtime.ts";
import { createSubscriptionCheckout } from "../src/server/billing/subscription-checkout.ts";
import { cancelOwnedSubscription } from "../src/server/billing/subscription-cancellation.ts";
import { verifyOwnedSubscriptionPayment } from "../src/server/billing/subscription-payment-verification.ts";
import { RazorpayTestClient, type RazorpayTestConfig } from "../src/server/billing/razorpay-client.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const config: RazorpayTestConfig = { keyId: "rzp_test_fake", keySecret: "fake-secret-123", webhookSecret: "fake-webhook-secret", subscriptionPlanIds: { creator: { weekly: "plan_creator_week", monthly: "plan_creator_month" } }, subscriptionTotalCount: 120 };
function rt(userId: string | null, repo = new MemoryRepository()): Runtime {
  return { mode: "database", repo, currentUserId: async () => userId, newId: () => "intent_1234567890123456", now: () => new Date("2026-11-07T00:00:00Z") } as Runtime;
}
function request(planId = "creator", interval = "weekly", key = "request_key_1234567890"): Request {
  return new Request("https://clipforge.test/api/payments/razorpay/subscriptions", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ planId, interval, amount: 1, autoRenewConsent: true }) });
}
const subscriptionClient = (call: () => Response | Promise<Response>) => new RazorpayTestClient(config, async (input) => String(input).includes("/plans/")
  ? Response.json({ id: "plan_creator_week", period: "weekly", interval: 1, item: { amount: 49900, currency: "INR" } })
  : call());

test("subscription checkout requires authentication and durable database mode", async () => {
  const response = await createSubscriptionCheckout(request(), rt(null), subscriptionClient(() => Response.json({})), config);
  assert.equal(response.status, 401);
});

test("recurring checkout requires explicit auto-renew consent", async () => {
  let calls = 0;
  const noConsent = new Request("https://clipforge.test/api/payments/razorpay/subscriptions", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json", "idempotency-key": "request_key_123456789" }, body: JSON.stringify({ planId: "creator", interval: "weekly" }) });
  const response = await createSubscriptionCheckout(noConsent, rt("user_no_consent"), subscriptionClient(() => { calls++; return Response.json({}); }), config);
  assert.equal(response.status, 400); assert.equal(calls, 0);
});

test("subscription checkout derives catalog plan and amount, ignores supplied client amount, and reuses idempotency result", async () => {
  let calls = 0;
  const client = subscriptionClient(async () => { calls++; return Response.json({ id: "sub_fake_1", plan_id: "plan_creator_week", status: "created", short_url: "https://rzp.io/i/test" }); });
  // The configured server plan is asserted by the client request path, while the client amount is ignored.
  const repo = new MemoryRepository(); const runtime = rt("user_fake", repo);
  const first = await createSubscriptionCheckout(request(), runtime, client, config);
  assert.equal(first.status, 201);
  assert.equal((await first.json() as { checkoutUrl: string }).checkoutUrl, "https://rzp.io/i/test");
  const second = await createSubscriptionCheckout(request(), runtime, client, config);
  assert.equal(second.status, 200);
  assert.equal(calls, 1);
  const intent = await repo.getRazorpaySubscriptionIntent("user_fake", "request_key_1234567890");
  assert.equal(intent?.amountPaise, 49900);
  assert.equal(intent?.planId, "creator");
  assert.equal(intent?.status, "created");
  assert.ok(intent?.autoRenewConsentAt instanceof Date);
  assert.equal(intent?.autoRenewConsentVersion, "auto-renew-v1");
});

test("provider ambiguity is persisted for manual review and is never automatically retried", async () => {
  let calls = 0;
  const client = new RazorpayTestClient(config, async (input) => { if (String(input).includes("/plans/")) return Response.json({ id: "plan_creator_week", period: "weekly", interval: 1, item: { amount: 49900, currency: "INR" } }); calls++; throw new Error("network lost after request"); });
  const runtime = rt("user_fake");
  assert.equal((await createSubscriptionCheckout(request(), runtime, client, config)).status, 503);
  assert.equal((await createSubscriptionCheckout(request(), runtime, client, config)).status, 409);
  assert.equal(calls, 1);
  assert.equal((await runtime.repo.getRazorpaySubscriptionIntent("user_fake", "request_key_1234567890"))?.status, "manual_review");
});

test("idempotency key cannot be reused for another plan or interval", async () => {
  const runtime = rt("user_fake");
  const client = subscriptionClient(() => Response.json({ id: "sub_fake_1", plan_id: "plan_creator_week", status: "created", short_url: "https://rzp.io/i/test" }));
  await createSubscriptionCheckout(request(), runtime, client, config);
  const mismatch = await createSubscriptionCheckout(request("creator", "monthly"), runtime, client, config);
  assert.equal(mismatch.status, 409);
});

test("fake-Prisma reservation serializes owner intents and binds the created Subscription to the same plan and owner", async () => {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "user_fake", email: "user@example.invalid" } });
  const repo = new PrismaRepository(db, () => new Date("2026-11-07T00:00:00Z"));
  const input = { id: "intent_a", userId: "user_fake", idempotencyKey: "request_key_1234567890", autoRenewConsentAt: new Date("2026-11-07T00:00:00Z"), autoRenewConsentVersion: "auto-renew-v1", providerPlanId: "plan_creator_week", planId: "creator" as const, interval: "weekly" as const, amountPaise: 49900, now: new Date("2026-11-07T00:00:00Z") };
  assert.equal((await repo.reserveRazorpaySubscriptionIntent(input)).status, "created");
  assert.equal((await repo.reserveRazorpaySubscriptionIntent({ ...input, id: "intent_b" })).status, "existing");
  assert.equal((await repo.reserveRazorpaySubscriptionIntent({ ...input, id: "intent_c", idempotencyKey: "different_key_123456" })).status, "conflict");
  assert.equal(await repo.finishRazorpaySubscriptionIntent({ id: "intent_a", userId: "another_user", status: "created", providerSubscriptionId: "sub_fake", checkoutUrl: "https://rzp.io/i/test", now: input.now }), false);
  assert.equal(await repo.finishRazorpaySubscriptionIntent({ id: "intent_a", userId: "user_fake", status: "created", providerSubscriptionId: "sub_fake", checkoutUrl: "https://rzp.io/i/test", now: input.now }), true);
  const subscription = await db.subscription.findUnique({ where: { userId: "user_fake" } });
  assert.equal(subscription?.["planId"], "creator");
  assert.equal(subscription?.["razorpaySubscriptionId"], "sub_fake");
});

test("fake-Prisma manual payment intent is durable, owner-bound, and grants a one-time period once", async () => {
  const now = new Date("2026-11-08T10:00:00.000Z");
  const db = new FakePrismaClient(); const repo = new PrismaRepository(db, () => now);
  await db.user.create({ data: { id: "owner_manual", role: "user" } });
  const input = { id: "manual_fake_intent", userId: "owner_manual", idempotencyKey: "manual_fake_key_123456789", planId: "creator" as const, interval: "weekly" as const, amountPaise: 49900, now };
  assert.equal((await repo.reserveManualPaymentIntent(input)).status, "created");
  assert.equal((await repo.reserveManualPaymentIntent({ ...input, id: "ignored_id" })).status, "existing");
  assert.equal(await repo.finishManualPaymentIntent({ id: input.id, userId: "someone_else", status: "created", providerPaymentLinkId: "plink_fake", checkoutUrl: "https://rzp.io/i/fake", now }), false);
  assert.equal(await repo.finishManualPaymentIntent({ id: input.id, userId: input.userId, status: "created", providerPaymentLinkId: "plink_fake", checkoutUrl: "https://rzp.io/i/fake", now }), true);
  assert.equal(await repo.settleManualPayment({ userId: "wrong_owner", intentId: input.id, providerPaymentLinkId: "plink_fake", providerPaymentId: "pay_fake", amountPaise: 49900, currency: "INR", status: "captured", paidAt: now, now }), "invalid");
  const settled = { userId: input.userId, intentId: input.id, providerPaymentLinkId: "plink_fake", providerPaymentId: "pay_fake", amountPaise: 49900, currency: "INR", status: "captured", paidAt: now, now };
  assert.equal(await repo.settleManualPayment(settled), "applied");
  assert.equal(await repo.settleManualPayment(settled), "duplicate");
  assert.equal(await repo.getPlanIdForUser(input.userId), "creator");
});

test("checkout rejects unsafe provider checkout URLs and stores manual review", async () => {
  const runtime = rt("user_fake");
  const client = subscriptionClient(() => Response.json({ id: "sub_fake_1", plan_id: "plan_creator_week", status: "created", short_url: "https://attacker.invalid/pay" }));
  assert.equal((await createSubscriptionCheckout(request(), runtime, client, config)).status, 503);
  assert.equal((await runtime.repo.getRazorpaySubscriptionIntent("user_fake", "request_key_1234567890"))?.status, "manual_review");
});

test("cancellation requires owner authorization and records provider-confirmed cycle-end policy", async () => {
  const repo = new MemoryRepository();
  const reserved = await repo.reserveRazorpaySubscriptionIntent({ id: "intent_a", userId: "owner_a", idempotencyKey: "request_key_1234567890", autoRenewConsentAt: new Date(), autoRenewConsentVersion: "auto-renew-v1", providerPlanId: "plan_creator_week", planId: "creator", interval: "weekly", amountPaise: 49900, now: new Date() });
  assert.equal(reserved.status, "created");
  await repo.finishRazorpaySubscriptionIntent({ id: "intent_a", userId: "owner_a", status: "created", providerSubscriptionId: "sub_a", checkoutUrl: "https://rzp.io/i/a", now: new Date() });
  const denied = await cancelOwnedSubscription(new Request("https://clipforge.test/api/payments/razorpay/subscriptions/cancel", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json" }, body: JSON.stringify({ cancelAtCycleEnd: true }) }), rt("owner_b", repo), subscriptionClient(() => Response.json({})), config);
  assert.equal(denied.status, 409);
  const ownerRequest = new Request("https://clipforge.test/api/payments/razorpay/subscriptions/cancel", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json" }, body: JSON.stringify({ cancelAtCycleEnd: true }) });
  const cancelClient = new RazorpayTestClient(config, async () => Response.json({ id: "sub_a", plan_id: "plan_creator_week", status: "active", current_end: 1_900_000_000 }));
  const accepted = await cancelOwnedSubscription(ownerRequest, rt("owner_a", repo), cancelClient, config);
  assert.equal(accepted.status, 200);
  assert.equal((await repo.getRazorpaySubscriptionForOwner("owner_a"))?.cancelAtPeriodEnd, true);
});

test("immediate cancellation uses server policy rather than a client-supplied timing choice", async () => {
  const repo = new MemoryRepository();
  await repo.reserveRazorpaySubscriptionIntent({ id: "intent_i", userId: "owner_i", idempotencyKey: "request_key_immediate_123", autoRenewConsentAt: new Date(), autoRenewConsentVersion: "auto-renew-v1", providerPlanId: "plan_creator_week", planId: "creator", interval: "weekly", amountPaise: 49900, now: new Date() });
  await repo.finishRazorpaySubscriptionIntent({ id: "intent_i", userId: "owner_i", status: "created", providerSubscriptionId: "sub_i", checkoutUrl: "https://rzp.io/i/test", now: new Date() });
  let cancelAtCycleEnd: boolean | undefined;
  const client = new RazorpayTestClient(config, async (_url, init) => { cancelAtCycleEnd = (JSON.parse(String(init?.body)) as { cancel_at_cycle_end: boolean }).cancel_at_cycle_end; return Response.json({ id: "sub_i", plan_id: "plan_creator_week", status: "cancelled", current_end: 1_900_000_000 }); });
  const policy = { ...config, cancellationAtCycleEnd: false };
  const response = await cancelOwnedSubscription(new Request("https://clipforge.test/api/payments/razorpay/subscriptions/cancel", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json" }, body: JSON.stringify({ cancelAtCycleEnd: true }) }), rt("owner_i", repo), client, policy);
  assert.equal(response.status, 200);
  assert.equal(cancelAtCycleEnd, false);
  assert.equal((await repo.getRazorpaySubscriptionForOwner("owner_i"))?.status, "cancelled");
});

test("server verifies payment signature, provider capture and catalog amount but leaves entitlement activation to webhook", async () => {
  const repo = new MemoryRepository();
  await repo.reserveRazorpaySubscriptionIntent({ id: "intent_verify", userId: "owner_a", idempotencyKey: "request_key_verify_123456", autoRenewConsentAt: new Date(), autoRenewConsentVersion: "auto-renew-v1", providerPlanId: "plan_creator_week", planId: "creator", interval: "weekly", amountPaise: 49900, now: new Date() });
  await repo.finishRazorpaySubscriptionIntent({ id: "intent_verify", userId: "owner_a", status: "created", providerSubscriptionId: "sub_verify", checkoutUrl: "https://rzp.io/i/test", now: new Date() });
  const signature = createHmac("sha256", config.keySecret).update("pay_verify|sub_verify").digest("hex");
  const request = (sig: string) => new Request("https://clipforge.test/api/payments/razorpay/verify", { method: "POST", headers: { host: "clipforge.test", origin: "https://clipforge.test", "content-type": "application/json" }, body: JSON.stringify({ razorpay_payment_id: "pay_verify", razorpay_subscription_id: "sub_verify", razorpay_signature: sig }) });
  const runtime = rt("owner_a", repo);
  const goodClient = new RazorpayTestClient(config, async () => Response.json({ id: "pay_verify", subscription_id: "sub_verify", amount: 49900, currency: "INR", status: "captured" }));
  const accepted = await verifyOwnedSubscriptionPayment(request(signature), runtime, goodClient, config);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { entitlementUpdated: boolean }).entitlementUpdated, false);
  assert.equal(await repo.getPlanIdForUser("owner_a"), "free");
  const otherUserRuntime = rt("owner_b", repo);
  assert.equal((await verifyOwnedSubscriptionPayment(request(signature), otherUserRuntime, goodClient, config)).status, 404);
  assert.equal((await verifyOwnedSubscriptionPayment(request("bad"), runtime, goodClient, config)).status, 400);
  const wrongAmount = new RazorpayTestClient(config, async () => Response.json({ id: "pay_verify", subscription_id: "sub_verify", amount: 1, currency: "INR", status: "captured" }));
  assert.equal((await verifyOwnedSubscriptionPayment(request(signature), runtime, wrongAmount, config)).status, 400);
});
