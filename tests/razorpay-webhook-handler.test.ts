import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { handleRazorpayWebhook } from "../src/server/billing/razorpay-webhook-handler.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const secret = "fake-test-webhook-secret";
function request(event: string, eventId: string, subscriptionId = "sub_test", createdAt = 1_800_000_000, signatureSecret = secret, paymentAmount = 199900, paymentId = `pay_${eventId}`): Request {
  const payload: Record<string, unknown> = { subscription: { entity: { id: subscriptionId, current_end: 1_900_000_000 } } };
  if (event === "subscription.charged") payload["payment"] = { entity: { id: paymentId, subscription_id: subscriptionId, amount: paymentAmount, currency: "INR", status: "captured" } };
  if (event === "payment.failed") payload["payment"] = { entity: { id: paymentId, subscription_id: subscriptionId, amount: paymentAmount, currency: "INR", status: "failed" } };
  const body = JSON.stringify({ event, created_at: createdAt, payload });
  const signature = createHmac("sha256", signatureSecret).update(body).digest("hex");
  return new Request("https://clipforge.test/api/payments/razorpay/webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId }, body });
}

async function configuredRepo() {
  const repo = new MemoryRepository();
  repo.razorpaySubscriptions.set("sub_test", { userId: "user_test", planId: "creator", interval: "monthly", status: "created", lastEventAt: 0 });
  repo.razorpaySubscriptionIntents.set("intent_test", { id: "intent_test", userId: "user_test", idempotencyKey: "key_test", providerSubscriptionId: "sub_test", providerPlanId: "plan_test", checkoutUrl: "https://rzp.io/test", planId: "creator", interval: "monthly", amountPaise: 199900, currency: "INR", status: "created", errorCategory: null, createdAt: new Date(0), updatedAt: new Date(0) });
  return repo;
}

test("webhook rejects missing or invalid signatures before persistence", async () => {
  const repo = await configuredRepo();
  const bad = await handleRazorpayWebhook(request("subscription.activated", "evt_bad", "sub_test", 1_800_000_000, "wrong-secret"), { repo, webhookSecret: secret });
  assert.equal(bad.status, 401);
  assert.equal(repo.razorpayWebhookEvents.size, 0);
});

test("activation alone grants no entitlement; a captured catalog-priced charge activates once", async () => {
  const repo = await configuredRepo();
  const first = await handleRazorpayWebhook(request("subscription.activated", "evt_activate"), { repo, webhookSecret: secret });
  assert.equal(first.status, 200);
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "authenticated");
  assert.equal(await repo.getPlanIdForUser("user_test"), "free");
  const charged = await handleRazorpayWebhook(request("subscription.charged", "evt_charge"), { repo, webhookSecret: secret });
  assert.equal(charged.status, 200);
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "active");
  assert.equal(await repo.getPlanIdForUser("user_test"), "creator");
  const duplicate = await handleRazorpayWebhook(request("subscription.charged", "evt_charge"), { repo, webhookSecret: secret });
  assert.equal(duplicate.status, 200);
  assert.equal(repo.razorpayWebhookEvents.size, 2);
  assert.equal(repo.razorpayPayments.size, 1);
});

test("renewal remains entitled while halted, cancelled and completed states revoke paid access", async () => {
  const repo = await configuredRepo();
  await handleRazorpayWebhook(request("subscription.activated", "evt_1", "sub_test", 100), { repo, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.charged", "evt_2", "sub_test", 200), { repo, webhookSecret: secret });
  assert.equal(await repo.getPlanIdForUser("user_test"), "creator");
  await handleRazorpayWebhook(request("subscription.halted", "evt_3", "sub_test", 300), { repo, webhookSecret: secret });
  assert.equal(await repo.getPlanIdForUser("user_test"), "free");

  const cancelled = await configuredRepo();
  await handleRazorpayWebhook(request("subscription.activated", "c1", "sub_test", 100), { repo: cancelled, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.cancelled", "c2", "sub_test", 200), { repo: cancelled, webhookSecret: secret });
  assert.equal(await cancelled.getPlanIdForUser("user_test"), "free");

  const completed = await configuredRepo();
  await handleRazorpayWebhook(request("subscription.activated", "x1", "sub_test", 100), { repo: completed, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.charged", "x1_charge", "sub_test", 150), { repo: completed, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.completed", "x2", "sub_test", 200), { repo: completed, webhookSecret: secret });
  assert.equal(completed.razorpaySubscriptions.get("sub_test")?.status, "completed");
  assert.equal(await completed.getPlanIdForUser("user_test"), "free");
});

test("failed renewal retains access only through the verified paid period and expiry removes it", async () => {
  const repo = await configuredRepo();
  await handleRazorpayWebhook(request("subscription.activated", "f1", "sub_test", 100), { repo, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.charged", "f2", "sub_test", 200), { repo, webhookSecret: secret });
  await handleRazorpayWebhook(request("payment.failed", "f3", "sub_test", 300), { repo, webhookSecret: secret });
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "pending");
  assert.equal(await repo.getPlanIdForUser("user_test"), "creator");
  await handleRazorpayWebhook(request("subscription.expired", "f4", "sub_test", 400), { repo, webhookSecret: secret });
  assert.equal(await repo.getPlanIdForUser("user_test"), "free");
});

test("failed first payment does not erase the established pending-status entitlement", async () => {
  const repo = await configuredRepo();
  await handleRazorpayWebhook(request("payment.failed", "first_failure", "sub_test", 100), { repo, webhookSecret: secret });
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "pending");
  assert.equal(await repo.getPlanIdForUser("user_test"), "creator");
});

test("captured event with wrong catalog amount is rejected without entitlement or payment persistence", async () => {
  const repo = await configuredRepo();
  const response = await handleRazorpayWebhook(request("subscription.charged", "evt_wrong_amount", "sub_test", 100, secret, 100), { repo, webhookSecret: secret });
  assert.equal(response.status, 409);
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "created");
  assert.equal(repo.razorpayPayments.size, 0);
});

test("unknown events are durably marked ignored and event timestamps prevent stale regression", async () => {
  const repo = await configuredRepo();
  const unknown = await handleRazorpayWebhook(request("payment.captured", "evt_unknown"), { repo, webhookSecret: secret });
  assert.equal(unknown.status, 200);
  assert.equal(repo.razorpayWebhookEvents.get("evt_unknown")?.status, "ignored");
  await handleRazorpayWebhook(request("subscription.activated", "evt_new", "sub_test", 200), { repo, webhookSecret: secret });
  await handleRazorpayWebhook(request("subscription.charged", "evt_charge_new", "sub_test", 250), { repo, webhookSecret: secret });
  const stale = await handleRazorpayWebhook(request("subscription.halted", "evt_old", "sub_test", 100), { repo, webhookSecret: secret });
  assert.equal(stale.status, 200);
  assert.equal(repo.razorpaySubscriptions.get("sub_test")?.status, "active");
  assert.equal(repo.razorpayWebhookEvents.get("evt_old")?.status, "ignored");
});

test("a webhook for an unknown subscription is not acknowledged as processed", async () => {
  const repo = await configuredRepo();
  const response = await handleRazorpayWebhook(request("subscription.activated", "evt_missing", "sub_missing"), { repo, webhookSecret: secret });
  assert.equal(response.status, 503);
  assert.equal(repo.razorpayWebhookEvents.size, 0);
});

test("fake-Prisma webhook processing commits subscription state and event uniqueness in one simulated transaction", async () => {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "user_test", role: "user" } });
  await db.subscription.create({ data: { id: "sub-row", userId: "user_test", planId: "creator", interval: "monthly", status: "created", razorpaySubscriptionId: "sub_test", lastEventAt: 0n, trialEndsAt: null, currentPeriodEnd: null } });
  await db.razorpaySubscriptionIntent.create({ data: { id: "intent_test", userId: "user_test", idempotencyKey: "key_test", providerSubscriptionId: "sub_test", providerPlanId: "plan_test", checkoutUrl: "https://rzp.io/test", planId: "creator", interval: "monthly", amountPaise: 199900, currency: "INR", status: "created", errorCategory: null, createdAt: new Date(0), updatedAt: new Date(0) } });
  const repo = new PrismaRepository(db, () => new Date(1_800_000_000_000));
  await handleRazorpayWebhook(request("subscription.activated", "evt_db_auth"), { repo, webhookSecret: secret });
  const first = await handleRazorpayWebhook(request("subscription.charged", "evt_db"), { repo, webhookSecret: secret });
  const repeated = await handleRazorpayWebhook(request("subscription.charged", "evt_db"), { repo, webhookSecret: secret });
  assert.equal(first.status, 200);
  assert.equal(repeated.status, 200);
  assert.equal((await db.subscription.findUnique({ where: { id: "sub-row" } }))?.["status"], "active");
  assert.equal(db.webhookEvent.rows.length, 2);
  assert.equal(db.paymentRecord.rows.length, 1);
  assert.equal(db.webhookEvent.rows.find((row) => row["providerEventId"] === "evt_db")?.["status"], "processed");
});
