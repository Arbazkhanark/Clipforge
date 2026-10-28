import { test } from "node:test";
import assert from "node:assert/strict";
import { applySubscriptionEvent, canTransition, effectivePlanId, hasPaidEntitlements, planChangeRequest, type SubscriptionState } from "../src/lib/billing/subscription-state.ts";

const base = (over: Partial<SubscriptionState> = {}): SubscriptionState =>
  ({ planId: "pro", interval: "weekly", status: "created", lastEventAt: 0, processedEventIds: [], ...over });

test("happy path created -> authenticated -> active", () => {
  let s = base();
  for (const [i, st] of (["authenticated", "active"] as const).entries()) {
    const out = applySubscriptionEvent(s, { eventId: `e${i}`, createdAt: 10 + i, newStatus: st });
    assert.equal(out.applied, true); s = out.state;
  }
  assert.equal(s.status, "active");
  assert.equal(hasPaidEntitlements(s), true);
});

test("duplicate webhook delivery is ignored", () => {
  const first = applySubscriptionEvent(base(), { eventId: "e1", createdAt: 5, newStatus: "active" });
  const again = applySubscriptionEvent(first.state, { eventId: "e1", createdAt: 5, newStatus: "active" });
  assert.deepEqual(again, { applied: false, state: first.state, reason: "duplicate" });
});

test("out-of-order (stale) event is ignored", () => {
  const s = base({ status: "active", lastEventAt: 100 });
  const out = applySubscriptionEvent(s, { eventId: "old", createdAt: 50, newStatus: "pending" });
  assert.equal(out.applied, false);
  if (!out.applied) assert.equal(out.reason, "stale");
  assert.equal(out.state.status, "active");
});

test("terminal states cannot be revived", () => {
  for (const status of ["cancelled", "completed", "expired"] as const) {
    const out = applySubscriptionEvent(base({ status, lastEventAt: 1 }), { eventId: "x", createdAt: 2, newStatus: "active" });
    assert.equal(out.applied, false);
  }
  assert.equal(canTransition("halted", "active"), true);
  assert.equal(canTransition("created", "halted"), false);
});

test("failed renewal path: active -> pending -> halted loses paid entitlements", () => {
  let s = base({ status: "active" });
  s = applySubscriptionEvent(s, { eventId: "a", createdAt: 1, newStatus: "pending" }).state;
  assert.equal(effectivePlanId(s), "pro"); // grace while retrying
  s = applySubscriptionEvent(s, { eventId: "b", createdAt: 2, newStatus: "halted" }).state;
  assert.equal(effectivePlanId(s), "free");
});

test("a created-but-unpaid subscription grants nothing", () => {
  assert.equal(effectivePlanId(base({ status: "created" })), "free");
  assert.equal(effectivePlanId(base({ status: "authenticated" })), "free");
});

test("plan change preserves billing interval; interval change needs separate consent", () => {
  const s = base({ status: "active", interval: "weekly" });
  assert.deepEqual(planChangeRequest(s, "agency"), { planId: "agency", interval: "weekly" });
  assert.deepEqual(planChangeRequest(s, "creator", "weekly"), { planId: "creator", interval: "weekly" });
  assert.throws(() => planChangeRequest(s, "agency", "monthly"), /consent/);
  assert.throws(() => planChangeRequest(s, "agency", "yearly"), /Unsupported/);
  assert.throws(() => planChangeRequest(s, "gold"), /Unknown plan/);
});
