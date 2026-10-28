import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTAGRAM_VERIFIED, INSTAGRAM_UNVERIFIED, instagramCoverSupport, findPublishQuotaViolations, isContainerCreationAllowedNow, nextActionForContainerStatus,
} from "../src/lib/integrations/instagram-capabilities.ts";

const at = (minutes: number) => new Date(Date.UTC(2026, 5, 1, 0, 0) + minutes * 60_000);

test("documented constants are recorded with their conflicts and unknowns, not hidden", () => {
  assert.equal(INSTAGRAM_VERIFIED.publishLimitPer24h, 100);
  assert.match(INSTAGRAM_VERIFIED.publishLimitDocConflict, /50/);
  assert.equal(INSTAGRAM_VERIFIED.containerLifetimeHours, 24);
  assert.equal(INSTAGRAM_VERIFIED.photoFormat, "JPEG");
  assert.ok(INSTAGRAM_UNVERIFIED.length >= 5);
  assert.ok(INSTAGRAM_UNVERIFIED.some((t) => /caption/i.test(t)));
  assert.ok(INSTAGRAM_UNVERIFIED.some((t) => /Reels video requirements/.test(t)));
});

test("cover support: Reels have cover parameters in the official reference; photo posts have no cover", () => {
  assert.equal(instagramCoverSupport("reel"), "supported");
  assert.equal(instagramCoverSupport("photo"), "unsupported");
});

test("rolling 24h quota: exactly the limit is fine, one more is flagged, old posts age out", () => {
  const exactly = Array.from({ length: 100 }, (_, i) => at(i));
  assert.deepEqual(findPublishQuotaViolations(exactly), []);
  const over = findPublishQuotaViolations([...exactly, at(100)]);
  assert.equal(over.length, 1); assert.equal(over[0]!.count, 101); assert.equal(over[0]!.limit, 100);
  // 100 posts, then one 24h later: the first has left the window.
  assert.deepEqual(findPublishQuotaViolations([...exactly, at(24 * 60)]), []);
  assert.equal(findPublishQuotaViolations([at(0), at(1), at(2)], 2).length, 1);
});

test("six reels every 21 minutes is 40+ per day: within 100, so no violation (not a claim that it is safe for the account)", () => {
  const times = Array.from({ length: 40 }, (_, i) => at(i * 21));
  assert.deepEqual(findPublishQuotaViolations(times), []);
  assert.ok(findPublishQuotaViolations(Array.from({ length: 120 }, (_, i) => at(i * 10))).length > 0);
});

test("containers are created shortly before publishing, never days ahead (they expire after 24h)", () => {
  const scheduled = at(24 * 60);
  assert.equal(isContainerCreationAllowedNow(scheduled, at(0)), false);
  assert.equal(isContainerCreationAllowedNow(scheduled, at(24 * 60 - 31)), false);
  assert.equal(isContainerCreationAllowedNow(scheduled, at(24 * 60 - 30)), true);
  assert.equal(isContainerCreationAllowedNow(scheduled, at(24 * 60 + 5)), true); // late
  assert.throws(() => isContainerCreationAllowedNow(scheduled, at(0), 24 * 60));
});

test("container status decides the safe next action; only PUBLISHED proves a post is live", () => {
  assert.equal(nextActionForContainerStatus("IN_PROGRESS"), "wait");
  assert.equal(nextActionForContainerStatus("FINISHED"), "publish_now");
  assert.equal(nextActionForContainerStatus("PUBLISHED"), "mark_published");
  assert.equal(nextActionForContainerStatus("ERROR"), "mark_failed");
  assert.equal(nextActionForContainerStatus("EXPIRED"), "recreate_container");
  assert.equal(nextActionForContainerStatus("SOMETHING_NEW"), "needs_review");
});
