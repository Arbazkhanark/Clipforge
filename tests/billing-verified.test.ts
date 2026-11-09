import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { interpretRazorpayWebhook, WEBHOOK_EVENT_TO_STATUS } from "../src/lib/billing/razorpay-webhook.ts";
import { applySubscriptionEvent, effectivePlanId, hasPaidEntitlements, trialStartAtUnix, TRIAL_DAYS, TRIAL_DISCLOSURE, type SubscriptionState } from "../src/lib/billing/subscription-state.ts";

const SECRET = "whsec_test";
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");
const body = (event: string, over: object = {}) => JSON.stringify({ event, created_at: 1000, payload: { subscription: { entity: { id: "sub_1", status: "x" } } }, ...over });
const call = (raw: string, over: Partial<Parameters<typeof interpretRazorpayWebhook>[0]> = {}) =>
  interpretRazorpayWebhook({ rawBody: raw, signatureHeader: sign(raw), eventIdHeader: "evt_1", webhookSecret: SECRET, ...over });

test("webhook: valid signed subscription event is interpreted", () => {
  const result = call(body("subscription.activated"));
  assert.deepEqual(result, { kind: "subscription_event", eventId: "evt_1", event: "subscription.activated", subscriptionId: "sub_1", newStatus: "authenticated", createdAt: 1000 });
});

test("webhook: every documented subscription event maps to the right status", () => {
  const expected: Record<string, string> = { authenticated: "authenticated", activated: "authenticated", charged: "active", pending: "pending", halted: "halted", cancelled: "cancelled" };
  for (const [name, status] of Object.entries(expected)) assert.equal(WEBHOOK_EVENT_TO_STATUS[`subscription.${name}`], status);
});

test("webhook: signature is checked on the exact raw bytes before anything else", () => {
  const raw = body("subscription.activated");
  assert.deepEqual(call(raw, { signatureHeader: "deadbeef" }), { kind: "rejected", reason: "bad_signature" });
  assert.deepEqual(call(raw, { signatureHeader: null }), { kind: "rejected", reason: "bad_signature" });
  assert.deepEqual(call(raw, { webhookSecret: "other" }), { kind: "rejected", reason: "bad_signature" });
  // Re-serialised body (different bytes) must fail.
  assert.deepEqual(call(JSON.stringify(JSON.parse(raw), null, 2), { signatureHeader: sign(raw) }), { kind: "rejected", reason: "bad_signature" });
});

test("webhook: event id header is required (used for duplicate detection); malformed bodies rejected after a valid signature", () => {
  assert.deepEqual(call(body("subscription.activated"), { eventIdHeader: "" }), { kind: "rejected", reason: "missing_event_id" });
  assert.deepEqual(call(body("subscription.activated"), { eventIdHeader: undefined }), { kind: "rejected", reason: "missing_event_id" });
  assert.deepEqual(call("not json"), { kind: "rejected", reason: "invalid_body" });
  assert.deepEqual(call("null"), { kind: "rejected", reason: "invalid_body" });
  assert.deepEqual(call(JSON.stringify({ foo: 1 })), { kind: "rejected", reason: "invalid_body" });
  assert.deepEqual(call(JSON.stringify({ event: "subscription.activated", created_at: 1 })), { kind: "rejected", reason: "invalid_body" }); // no subscription id
  assert.deepEqual(call(JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity: { id: "s" } } } })), { kind: "rejected", reason: "invalid_body" }); // no created_at
});

test("webhook: other authentic events are ignored (recorded, answered 200), including prototype-name tricks", () => {
  assert.deepEqual(call(body("payment.captured")), { kind: "ignored", eventId: "evt_1", event: "payment.captured" });
  assert.equal(call(body("constructor")).kind, "ignored");
  assert.equal(call(body("__proto__")).kind, "ignored");
});

test("webhook + state machine: duplicates and out-of-order deliveries are harmless", () => {
  let state: SubscriptionState = { planId: "pro", interval: "weekly", status: "created", lastEventAt: 0, processedEventIds: [] };
  const deliver = (event: string, eventId: string, createdAt: number) => {
    const r = call(body(event, { created_at: createdAt }), { eventIdHeader: eventId });
    assert.equal(r.kind, "subscription_event");
    if (r.kind !== "subscription_event") throw new Error("unreachable");
    const out = applySubscriptionEvent(state, { eventId: r.eventId, createdAt: r.createdAt, newStatus: r.newStatus });
    if (out.applied) state = out.state;
    return out;
  };
  assert.equal(deliver("subscription.authenticated", "e1", 10).applied, true);
  assert.equal(deliver("subscription.activated", "e2", 20).applied, true);
  const dup = deliver("subscription.activated", "e2", 20);
  assert.ok(!dup.applied && dup.reason === "duplicate");
  const stale = deliver("subscription.authenticated", "e3", 5);
  assert.ok(!stale.applied && stale.reason === "stale");
  assert.equal(deliver("subscription.charged", "e4", 30).applied, true); // charge on an active subscription: no change, recorded
  assert.equal(state.status, "active");
  assert.equal(deliver("subscription.pending", "e5", 40).applied, true);
  assert.equal(deliver("subscription.halted", "e6", 50).applied, true);
  assert.equal(effectivePlanId(state), "free");
});

test("trial: 7 days via a future start_at; entitlements only while the trial lasts and only after authorisation", () => {
  assert.equal(TRIAL_DAYS, 7);
  assert.equal(trialStartAtUnix(1_000_000), 1_000_000 + 7 * 86_400);
  const trial: SubscriptionState = { planId: "creator", interval: "monthly", status: "authenticated", lastEventAt: 1, processedEventIds: [], trialEndsAt: 2_000_000 };
  assert.equal(hasPaidEntitlements(trial, 1_999_999), true);
  assert.equal(effectivePlanId(trial, 1_999_999), "creator");
  assert.equal(hasPaidEntitlements(trial, 2_000_000), false);      // trial over, not yet charged/active
  assert.equal(hasPaidEntitlements(trial), false);                  // no clock given: never assume
  assert.equal(hasPaidEntitlements({ ...trial, status: "created" }, 1_999_999), false); // not authorised yet
  assert.equal(hasPaidEntitlements({ ...trial, trialEndsAt: null }, 1), false);
  assert.equal(hasPaidEntitlements({ ...trial, status: "cancelled" }, 1), false);
});

test("trial disclosure states length, auth payment + refund, renewal and cancellation", () => {
  for (const text of ["7 days", "₹5", "refunded", "every billing period", "cancel"]) assert.ok(TRIAL_DISCLOSURE.includes(text), text);
});
