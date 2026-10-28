import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canItemTransition, moveItemToStatus, startCycle, pauseCycle, resumeCycle, stopCycle, isCycleFinished,
  claimItemForPublishing, recordPublishOutcome, recoverStaleLocks, buildPublishIdempotencyKey, canCycleTransition,
} from "../src/lib/domain/cycle-state.ts";
import { NOW, inDays, makeItem, makeCycle } from "./helpers.ts";

test("published and cancelled items can never change (history is permanent)", () => {
  for (const to of ["upcoming", "scheduled", "publishing", "failed", "needs_review", "cancelled", "published"] as const) {
    assert.equal(canItemTransition("published", to), false);
  }
  assert.equal(canItemTransition("cancelled", "upcoming"), false);
  assert.throws(() => moveItemToStatus(makeItem({ status: "published" }), "upcoming"));
});

test("an in-flight publishing item cannot be moved back to upcoming or cancelled", () => {
  assert.equal(canItemTransition("publishing", "upcoming"), false);
  assert.equal(canItemTransition("publishing", "cancelled"), false);
  assert.equal(canItemTransition("publishing", "needs_review"), true);
});

test("moveItemToStatus bumps the version and does not mutate the input", () => {
  const item = makeItem();
  const moved = moveItemToStatus(item, "scheduled");
  assert.equal(moved.version, 2); assert.equal(item.version, 1); assert.equal(item.status, "upcoming");
});

test("start requires final review confirmation and at least one editable item", () => {
  const draft = makeCycle({ status: "draft", finalReviewConfirmed: false });
  assert.equal(startCycle(draft, [makeItem()]).ok, false);
  assert.equal(startCycle({ ...draft, finalReviewConfirmed: true }, []).ok, false);
  const ok = startCycle({ ...draft, finalReviewConfirmed: true }, [makeItem()]);
  assert.ok(ok.ok && ok.cycle.status === "running");
  assert.equal(startCycle(makeCycle({ status: "running" }), [makeItem()]).ok, false);
});

test("pause / resume / stop transitions and honest in-flight reporting", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b", status: "publishing", lockedBy: "w" }), makeItem({ id: "c", status: "published" })];
  const paused = pauseCycle(makeCycle(), items);
  assert.ok(paused.ok);
  if (paused.ok) assert.deepEqual(paused.inFlightItemIds, ["b"]);
  assert.equal(resumeCycle(makeCycle({ status: "running" })).ok, false);
  assert.ok(resumeCycle(makeCycle({ status: "paused" })).ok);
  const stopped = stopCycle(makeCycle(), items);
  assert.ok(stopped.ok);
  if (stopped.ok) { assert.deepEqual(stopped.cancelledItemIds, ["a"]); assert.deepEqual(stopped.inFlightItemIds, ["b"]); }
  assert.equal(canCycleTransition("stopped", "running"), false);
});

test("claim succeeds only for a running cycle, due item, and matching version", () => {
  const item = makeItem({ scheduledFor: inDays(-1) });
  const ok = claimItemForPublishing(makeCycle(), item, 1, "w1", NOW, 120);
  assert.ok(ok.claimed);
  if (ok.claimed) {
    assert.equal(ok.item.status, "publishing"); assert.equal(ok.item.lockedBy, "w1");
    assert.equal(ok.item.lockExpiresAt?.getTime(), NOW.getTime() + 120_000); assert.equal(ok.item.version, 2);
  }
  assert.equal(claimItemForPublishing(makeCycle({ status: "paused" }), item, 1, "w1", NOW, 120).claimed, false);   // pause stops claims
  assert.equal(claimItemForPublishing(makeCycle(), makeItem({ scheduledFor: inDays(1) }), 1, "w1", NOW, 120).claimed, false);
  assert.equal(claimItemForPublishing(makeCycle(), item, 99, "w1", NOW, 120).claimed, false);                        // stale version
  assert.equal(claimItemForPublishing(makeCycle(), makeItem({ status: "published" }), 1, "w1", NOW, 120).claimed, false);
});

test("two workers racing: second claim on the same version fails", () => {
  const item = makeItem();
  const first = claimItemForPublishing(makeCycle(), item, 1, "w1", NOW, 60);
  assert.ok(first.claimed);
  // Worker 2 still holds the old copy of the item (version 1). Applying CAS in the DB would reject it;
  // here, claiming the NEW row state fails because it is already publishing.
  if (first.claimed) assert.equal(claimItemForPublishing(makeCycle(), first.item, 1, "w2", NOW, 60).claimed, false);
});

test("publish outcomes: success -> published; definite failure -> failed; ambiguous -> needs_review (no auto retry)", () => {
  const claimed = (id = "i") => { const r = claimItemForPublishing(makeCycle(), makeItem({ id }), 1, "w1", NOW, 60); assert.ok(r.claimed); return (r as { item: ReturnType<typeof makeItem> }).item; };
  const published = recordPublishOutcome(claimed(), "w1", "success");
  assert.equal(published.status, "published"); assert.equal(published.lockedBy, null);
  assert.equal(recordPublishOutcome(claimed(), "w1", "definite_failure").status, "failed");
  const ambiguous = recordPublishOutcome(claimed(), "w1", "ambiguous");
  assert.equal(ambiguous.status, "needs_review"); assert.equal(ambiguous.reviewReason, "ambiguous_publish_result");
  assert.equal(canItemTransition("needs_review", "publishing"), false); // cannot blindly retry
  assert.throws(() => recordPublishOutcome(claimed(), "someone-else", "success"));
  assert.throws(() => recordPublishOutcome(makeItem(), "w1", "success"));
});

test("restart recovery: stale rendering is redone, stale publishing needs review, fresh locks are left alone", () => {
  const items = [
    makeItem({ id: "r", status: "processing", lockedBy: "dead", lockExpiresAt: inDays(-1) }),
    makeItem({ id: "p", status: "publishing", lockedBy: "dead", lockExpiresAt: inDays(-1) }),
    makeItem({ id: "fresh", status: "publishing", lockedBy: "alive", lockExpiresAt: inDays(1) }),
    makeItem({ id: "idle" }),
  ];
  const recovered = recoverStaleLocks(items, NOW);
  const get = (id: string) => recovered.find((i) => i.id === id)!;
  assert.equal(get("r").status, "scheduled"); assert.equal(get("r").lockedBy, null);
  assert.equal(get("p").status, "needs_review"); assert.equal(get("p").reviewReason, "worker_lost_during_publish");
  assert.equal(get("fresh").status, "publishing");
  assert.equal(get("idle").status, "upcoming");
});

test("cycle finished only when nothing can still publish; idempotency key is stable", () => {
  assert.equal(isCycleFinished([makeItem({ status: "published" }), makeItem({ status: "cancelled" })]), true);
  assert.equal(isCycleFinished([makeItem({ status: "published" }), makeItem({ status: "upcoming" })]), false);
  assert.equal(isCycleFinished([makeItem({ status: "needs_review" })]), false);
  assert.equal(isCycleFinished([]), false);
  assert.equal(buildPublishIdempotencyKey(makeItem()), buildPublishIdempotencyKey(makeItem({ version: 9 })));
});
