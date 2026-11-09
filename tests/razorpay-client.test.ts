import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { RazorpayTestClient, readRazorpayTestConfig } from "../src/server/billing/razorpay-client.ts";
import { getPricePaise } from "../src/lib/billing/catalog.ts";

const config = {
  keyId: "rzp_test_fake",
  keySecret: "fake-secret-only",
  webhookSecret: "fake-webhook",
  subscriptionPlanIds: { creator: { weekly: "plan_fake_weekly", monthly: "plan_fake_monthly" } },
  subscriptionTotalCount: 12,
};
const json = (value: unknown) => Response.json(value);

test("checkout configuration fails closed without credentials, test keys, recurring plan IDs, or an explicit cycle count", () => {
  assert.equal(readRazorpayTestConfig({}), null);
  assert.equal(readRazorpayTestConfig({ RAZORPAY_KEY_ID: "rzp_live_secret", RAZORPAY_KEY_SECRET: "secret" }), null);
  const parsed = readRazorpayTestConfig({ RAZORPAY_KEY_ID: "rzp_test_fake", RAZORPAY_KEY_SECRET: "fake-secret", RAZORPAY_PLAN_CREATOR_WEEKLY: "plan_fake", RAZORPAY_SUBSCRIPTION_TOTAL_COUNT: "12" });
  assert.ok(parsed);
  assert.equal(parsed.subscriptionTotalCount, 12);
});

test("order creation derives amount from catalog and uses fixed sandbox API origin", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const client = new RazorpayTestClient(config, async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return json({ id: "order_fake", amount: getPricePaise("creator", "weekly"), currency: "INR", status: "created" });
  }, () => "receipt-id");
  const result = await client.createOrder({ ownerId: "user_fake", planId: "creator", interval: "weekly" });
  assert.equal(result.ok, true);
  assert.equal(requests[0]?.url, "https://api.razorpay.com/v1/orders");
  assert.equal(requests[0]?.body["amount"], getPricePaise("creator", "weekly"));
  assert.deepEqual(requests[0]?.body["notes"], { owner_id: "user_fake", plan_id: "creator", interval: "weekly" });
});

test("subscription creation only uses server configured plan id and explicitly configured cycle count", async () => {
  let body: Record<string, unknown> | null = null;
  const client = new RazorpayTestClient(config, async (input, init) => {
    if (String(input).endsWith("/plan_fake_monthly")) return json({ id: "plan_fake_monthly", period: "monthly", interval: 1, item: { amount: getPricePaise("creator", "monthly"), currency: "INR" } });
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return json({ id: "sub_fake", plan_id: "plan_fake_monthly", status: "created", short_url: "https://rzp.io/test" });
  });
  const result = await client.createSubscription({ ownerId: "user_fake", planId: "creator", interval: "monthly" });
  assert.equal(result.ok, true);
  assert.equal(body?.["plan_id"], "plan_fake_monthly");
  assert.equal(body?.["total_count"], 12);
  assert.equal(await new RazorpayTestClient({ ...config, subscriptionPlanIds: {}, subscriptionTotalCount: undefined }).createSubscription({ ownerId: "user_fake", planId: "creator", interval: "weekly" }).then((r) => r.ok ? "ok" : r.reason), "invalid_request");
});

test("subscription creation refuses configured provider plans whose amount or cadence differs from catalog", async () => {
  let created = false;
  const client = new RazorpayTestClient(config, async (input) => {
    if (String(input).endsWith("/plan_fake_monthly")) return json({ id: "plan_fake_monthly", period: "weekly", interval: 1, item: { amount: 100, currency: "INR" } });
    created = true; return json({ id: "sub_fake", plan_id: "plan_fake_monthly", status: "created" });
  });
  assert.deepEqual(await client.createSubscription({ ownerId: "user_fake", planId: "creator", interval: "monthly" }), { ok: false, reason: "invalid_provider_response" });
  assert.equal(created, false);
});

test("manual payment links accept the catalog full price and reject zero or above-catalog amounts", async () => {
  const requestedAmounts: number[] = [];
  const client = new RazorpayTestClient(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { amount: number; reference_id: string };
    requestedAmounts.push(body.amount);
    return json({ id: "plink_fake", amount: body.amount, currency: "INR", status: "created", short_url: "https://rzp.io/i/fake", reference_id: body.reference_id });
  });
  const valid = { ownerId: "user_fake", intentId: "intent_fake", planId: "creator", interval: "weekly" };
  const fullPrice = getPricePaise("creator", "weekly");
  assert.equal((await client.createManualPaymentLink({ ...valid, amountPaise: fullPrice })).ok, true);
  assert.deepEqual(requestedAmounts, [fullPrice]);
  assert.deepEqual(await client.createManualPaymentLink({ ...valid, intentId: "intent_zero", amountPaise: 0 }), { ok: false, reason: "invalid_request" });
  assert.deepEqual(await client.createManualPaymentLink({ ...valid, intentId: "intent_over", amountPaise: fullPrice + 1 }), { ok: false, reason: "invalid_request" });
  assert.deepEqual(requestedAmounts, [fullPrice], "invalid amounts are rejected before any provider request");
});

test("order payment verification requires signature, matching order notes and captured payment from provider", async () => {
  let calls = 0;
  const secret = config.keySecret;
  const signature = createHmac("sha256", secret).update("order_fake|payment_fake").digest("hex");
  const client = new RazorpayTestClient(config, async (input) => {
    calls += 1;
    if (String(input).endsWith("/orders/order_fake")) return json({ id: "order_fake", amount: getPricePaise("creator", "monthly"), currency: "INR", status: "paid", notes: { owner_id: "user_fake", plan_id: "creator", interval: "monthly" } });
    return json({ id: "payment_fake", order_id: "order_fake", amount: getPricePaise("creator", "monthly"), currency: "INR", status: "captured" });
  });
  const input = { ownerId: "user_fake", orderId: "order_fake", paymentId: "payment_fake", signature, planId: "creator", interval: "monthly" };
  assert.equal((await client.verifyOrderPayment(input)).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(await client.verifyOrderPayment({ ...input, signature: "bad" }), { ok: false, reason: "invalid_request" });
});

test("provider failures are sanitized and never return response bodies", async () => {
  const client = new RazorpayTestClient(config, async () => new Response(JSON.stringify({ error: { description: "secret-bearing provider detail" } }), { status: 401 }));
  const result = await client.createOrder({ ownerId: "user_fake", planId: "creator", interval: "weekly" });
  assert.deepEqual(result, { ok: false, reason: "provider_error" });
  assert.equal(JSON.stringify(result).includes("secret-bearing"), false);
});
