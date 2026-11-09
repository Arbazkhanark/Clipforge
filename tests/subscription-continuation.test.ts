import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { RazorpayTestClient, type RazorpayTestConfig } from "../src/server/billing/razorpay-client.ts";
import { continueSubscription, runSubscriptionContinuations } from "../src/server/billing/subscription-continuation.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const config: RazorpayTestConfig = { keyId: "rzp_test_123", keySecret: "test_secret_123", webhookSecret: "test_webhook", subscriptionPlanIds: {}, subscriptionTotalCount: 12 };
function fixture(remaining = 5, paid = 15, status = "active", cancelAtCycleEnd = false) {
  const repo = new MemoryRepository(); const currentPeriodEnd = new Date("2030-01-01T00:00:00.000Z");
  repo.razorpaySubscriptions.set("sub_test_123", { userId: "user_test_123", planId: "creator", interval: "weekly", status: "active", lastEventAt: 0, currentPeriodEnd, cancelAtPeriodEnd: false });
  const candidate = { id: "sub_test_123", userId: "user_test_123", planId: "creator" as const, interval: "weekly" as const, providerSubscriptionId: "sub_test_123", currentPeriodEnd };
  const calls: { method: string; body?: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined; calls.push({ method, body });
    const base = { id: "sub_test_123", plan_id: "plan_test_123", status, current_end: Math.floor(currentPeriodEnd.getTime() / 1000), total_count: paid + remaining, paid_count: paid, remaining_count: remaining, cancel_at_cycle_end: cancelAtCycleEnd };
    if (method === "PATCH") return Response.json({ ...base, remaining_count: body?.["remaining_count"] });
    return Response.json(base);
  };
  return { repo, candidate, calls, client: new RazorpayTestClient(config, fetcher) };
}

test("continuation extends the same active subscription near its finite count, once only", async () => {
  const f = fixture();
  assert.equal(await continueSubscription(f.candidate, f.repo, f.client, new Date("2029-12-01T00:00:00Z")), "extended");
  assert.deepEqual(f.calls.map((c) => c.method), ["GET", "PATCH"]);
  assert.equal(f.calls[1]?.body?.["remaining_count"], 5_202);
  const counts = await runSubscriptionContinuations(f.repo, f.client, new Date("2029-12-01T00:00:00Z"));
  assert.equal(counts.already_handled, 1);
  assert.equal(f.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("not-due, cancelled and max-duration subscriptions do not get an extension", async () => {
  const notDue = fixture(20); assert.equal(await continueSubscription(notDue.candidate, notDue.repo, notDue.client, new Date()), "not_due"); assert.equal(notDue.calls.length, 1);
  const cancelled = fixture(5, 15, "active", true); assert.equal(await continueSubscription(cancelled.candidate, cancelled.repo, cancelled.client, new Date()), "cancelled"); assert.equal(cancelled.calls.length, 1);
  const atLimit = fixture(10, 5_207); assert.equal(await continueSubscription(atLimit.candidate, atLimit.repo, atLimit.client, new Date()), "needs_manual_review"); assert.equal(atLimit.calls.length, 1);
});

test("ambiguous provider extension is manual review and is never blindly retried", async () => {
  const f = fixture();
  const failedClient = new RazorpayTestClient(config, async (_input, init) => init?.method === "PATCH" ? new Response("", { status: 503 }) : Response.json({ id: "sub_test_123", plan_id: "plan_test_123", status: "active", current_end: Math.floor(f.candidate.currentPeriodEnd.getTime() / 1000), total_count: 20, paid_count: 15, remaining_count: 5, cancel_at_cycle_end: false }));
  assert.equal(await continueSubscription(f.candidate, f.repo, failedClient, new Date()), "needs_manual_review");
  assert.equal(await continueSubscription(f.candidate, f.repo, f.client, new Date()), "already_handled");
});

test("a persisted cancellation request prevents a continuation reservation", async () => {
  const f = fixture();
  assert.equal(await f.repo.requestRazorpayCancellation("user_test_123", "sub_test_123", new Date()), true);
  assert.equal(await continueSubscription(f.candidate, f.repo, f.client, new Date()), "cancelled");
  assert.equal(f.calls.length, 1);
});

test("fake-Prisma continuation reservation is unique per provider cycle and cancellation-fenced", async () => {
  const db = new FakePrismaClient(); const cycleEnd = new Date("2030-01-01T00:00:00.000Z");
  db.subscription.rows.push({ id: "local-sub-1", userId: "user_test_123", planId: "creator", interval: "weekly", status: "active", razorpaySubscriptionId: "sub_test_123", currentPeriodEnd: cycleEnd, cancelAtPeriodEnd: false, cancellationRequestedAt: null });
  const repo = new PrismaRepository(db); const input = { id: "cont_attempt_1", subscriptionId: "local-sub-1", providerSubscriptionId: "sub_test_123", cycleEnd, observedTotalCount: 20, observedPaidCount: 15, observedRemainingCount: 5, targetRemainingCount: 5_202, now: new Date("2029-12-01T00:00:00Z") };
  assert.equal(await repo.reserveSubscriptionContinuation(input), "reserved");
  assert.equal(await repo.reserveSubscriptionContinuation({ ...input, id: "cont_attempt_2" }), "existing");
  assert.equal(await repo.finishSubscriptionContinuation({ id: input.id, status: "manual_review", errorCategory: "provider_outcome_uncertain", now: input.now }), true);
  assert.equal(await repo.requestRazorpayCancellation("user_test_123", "sub_test_123", input.now), true);
  assert.equal(await repo.reserveSubscriptionContinuation({ ...input, id: "cont_attempt_3" }), "cancelled");
});
