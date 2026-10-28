import { test } from "node:test";
import assert from "node:assert/strict";
import { runPreflight, type PreflightInput } from "../src/lib/domain/preflight.ts";
import { NOW, makeItem, makeCycle, makeMedia, makeCollection, makeGrant } from "./helpers.ts";
import { canKeepUsingSourceForCycleItem } from "../src/lib/domain/sharing-permissions.ts";

const okAccess = (items: ReturnType<typeof makeItem>[]) => Object.fromEntries(items.map((i) => [i.id, { allowed: true, reason: "ok" }]));
const baseInput = (over: Partial<PreflightInput> = {}): PreflightInput => {
  const items = [makeItem({ id: "a", mediaAssetId: "m1", captionText: "Hello" }), makeItem({ id: "b", mediaAssetId: "m2", captionText: "Hi" })];
  return { cycle: makeCycle({ status: "draft" }), items, socialAccountStatus: "connected", scheduledItemsPerMonthLimit: 100, scheduledItemsUsedThisMonth: 0, coverSupport: "supported", sourceAccessByItemId: okAccess(items), ...over };
};
const levelOf = (report: ReturnType<typeof runPreflight>, id: string) => report.checks.find((c) => c.id === id)?.level;

test("a healthy cycle is ready to start", () => {
  const report = runPreflight(baseInput());
  assert.equal(report.overall, "ready"); assert.equal(report.canStart, true);
});

test("account problems block", () => {
  for (const status of [null, "token_expired", "revoked", "disconnected"] as const) {
    const report = runPreflight(baseInput({ socialAccountStatus: status }));
    assert.equal(levelOf(report, "account"), "blocked"); assert.equal(report.canStart, false);
  }
});

test("empty cycle blocks; unconfirmed final review needs action", () => {
  assert.equal(levelOf(runPreflight(baseInput({ items: [], sourceAccessByItemId: {} })), "items"), "blocked");
  const report = runPreflight(baseInput({ cycle: makeCycle({ status: "draft", finalReviewConfirmed: false }) }));
  assert.equal(levelOf(report, "final_review"), "action_required"); assert.equal(report.canStart, false);
});

test("revoked shared permission is detected via the real permission rule and blocks", () => {
  const items = [makeItem({ id: "a", captionText: "x" })];
  const revoked = canKeepUsingSourceForCycleItem(items[0]!, makeMedia(), makeCollection(), [makeGrant({ status: "revoked" })], NOW);
  const report = runPreflight(baseInput({ items, sourceAccessByItemId: { a: revoked } }));
  assert.equal(levelOf(report, "source_access"), "blocked");
  assert.deepEqual(report.checks.find((c) => c.id === "source_access")?.itemIds, ["a"]);
});

test("failed / needs_review items and plan overflow require action", () => {
  const items = [makeItem({ id: "a", captionText: "x" }), makeItem({ id: "f", status: "failed", mediaAssetId: "m9" })];
  assert.equal(levelOf(runPreflight(baseInput({ items, sourceAccessByItemId: okAccess(items) })), "needs_review"), "action_required");
  assert.equal(levelOf(runPreflight(baseInput({ scheduledItemsUsedThisMonth: 99 })), "plan_limit"), "action_required");
});

test("invalid caption needs action; empty caption is only a recommendation (can still start)", () => {
  const bad = [makeItem({ id: "a", captionText: "x".repeat(3000) })];
  assert.equal(levelOf(runPreflight(baseInput({ items: bad, sourceAccessByItemId: okAccess(bad) })), "caption_invalid"), "action_required");
  const empty = [makeItem({ id: "a", captionText: "" })];
  const report = runPreflight(baseInput({ items: empty, sourceAccessByItemId: okAccess(empty) }));
  assert.equal(levelOf(report, "caption_empty"), "recommendation"); assert.equal(report.canStart, true);
});

test("covers: unsupported or unknown platform support is disclosed as a recommendation, never claimed as applied", () => {
  const items = [makeItem({ id: "a", captionText: "x", coverMediaId: "c1", coverState: "saved_internally" })];
  for (const coverSupport of ["unsupported", "unknown"] as const) {
    const report = runPreflight(baseInput({ items, sourceAccessByItemId: okAccess(items), coverSupport }));
    assert.equal(levelOf(report, "cover_support"), "recommendation");
  }
  assert.equal(levelOf(runPreflight(baseInput({ items, sourceAccessByItemId: okAccess(items), coverSupport: "supported" })), "cover_support"), undefined);
});

test("duplicates are flagged, cancelled items are ignored", () => {
  const dup = [makeItem({ id: "a", mediaAssetId: "m", captionText: "x" }), makeItem({ id: "b", mediaAssetId: "m", captionText: "x" })];
  assert.equal(levelOf(runPreflight(baseInput({ items: dup, sourceAccessByItemId: okAccess(dup) })), "duplicates"), "recommendation");
  const cancelled = [dup[0]!, { ...dup[1]!, status: "cancelled" as const }];
  assert.equal(levelOf(runPreflight(baseInput({ items: cancelled, sourceAccessByItemId: okAccess(cancelled) })), "duplicates"), undefined);
});

test("overall level is the worst check", () => {
  const report = runPreflight(baseInput({ socialAccountStatus: "revoked", scheduledItemsUsedThisMonth: 99 }));
  assert.equal(report.overall, "blocked");
});

test("Instagram's documented rolling 24h quota is enforced before start; recent posts count too", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 5, 1) + m * 60_000);
  const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: `i${i}`, mediaAssetId: `m${i}`, captionText: "x", status: "scheduled", scheduledFor: at(i * 10) }));
  const input = baseInput({ items, sourceAccessByItemId: okAccess(items) });
  assert.equal(levelOf(runPreflight(input), "platform_quota"), undefined);
  assert.equal(levelOf(runPreflight({ ...input, publishLimitPer24h: 5 }), "platform_quota"), "action_required");
  const recent = Array.from({ length: 95 }, (_, i) => at(-600 + i));
  const report = runPreflight({ ...input, recentPublishTimes: recent });
  assert.equal(levelOf(report, "platform_quota"), "action_required"); assert.equal(report.canStart, false);
});
