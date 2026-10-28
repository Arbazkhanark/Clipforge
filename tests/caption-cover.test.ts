import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCaption, previewBulkCaptionUpdate, applyBulkCaptionUpdate, editSingleCaption,
  previewBulkCoverUpdate, applyBulkCoverUpdate,
} from "../src/lib/domain/caption-cover-updates.ts";
import { claimItemForPublishing } from "../src/lib/domain/cycle-state.ts";
import { NOW, makeItem, makeCycle } from "./helpers.ts";

const sampleItems = () => [
  makeItem({ id: "pub", status: "published", captionText: "old", position: 1 }),
  makeItem({ id: "up1", status: "upcoming", position: 2 }),
  makeItem({ id: "up2", status: "scheduled", position: 3, captionText: "mine", captionSource: "individual" }),
  makeItem({ id: "busy", status: "publishing", position: 4, lockedBy: "w" }),
  makeItem({ id: "fail", status: "failed", position: 5 }),
];
const versions = (items: ReturnType<typeof sampleItems>) => Object.fromEntries(items.map((i) => [i.id, i.version]));
const byId = (items: ReturnType<typeof sampleItems>, id: string) => items.find((i) => i.id === id)!;

test("caption validation: length and hashtag limits (unverified numbers)", () => {
  assert.equal(validateCaption("hello #one #two").valid, true);
  assert.equal(validateCaption("x".repeat(2201)).valid, false);
  assert.equal(validateCaption(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ")).valid, false);
  assert.equal(validateCaption("x".repeat(2200)).valid, true);
});

test("bulk caption to ALL upcoming: only upcoming/scheduled change; published history untouched", () => {
  const items = sampleItems();
  const result = applyBulkCaptionUpdate({ items, target: { kind: "all_upcoming" }, newCaption: "New!", overwriteCustomConfirmed: true, expectedVersions: versions(items), changedBy: "bob", now: NOW });
  assert.ok(result.ok);
  assert.equal(byId(result.items, "pub").captionText, "old");
  assert.equal(byId(result.items, "pub").version, 1);
  assert.equal(byId(result.items, "busy").captionText, "");
  assert.equal(byId(result.items, "fail").captionText, "");
  assert.equal(byId(result.items, "up1").captionText, "New!");
  assert.equal(byId(result.items, "up2").captionText, "New!");
  assert.equal(result.summary.updated, 2);
  assert.equal(result.revisions.length, 2);
  assert.equal(result.revisions.find((r) => r.itemId === "up2")?.previousText, "mine");
});

test("custom captions are NOT overwritten without confirmation; the rest still update, and the report says so", () => {
  const items = sampleItems();
  const result = applyBulkCaptionUpdate({ items, target: { kind: "all_upcoming" }, newCaption: "New!", overwriteCustomConfirmed: false, expectedVersions: versions(items), changedBy: "bob", now: NOW });
  assert.equal(byId(result.items, "up2").captionText, "mine");
  assert.equal(byId(result.items, "up1").captionText, "New!");
  assert.equal(result.summary.needsConfirmation, 1);
  assert.equal(result.results.find((r) => r.itemId === "up2")?.outcome, "needs_overwrite_confirmation");
});

test("selected-only target; selecting a published/in-flight/unknown item is skipped with a reason", () => {
  const items = sampleItems();
  const result = applyBulkCaptionUpdate({ items, target: { kind: "selected", itemIds: ["up1", "pub", "busy", "ghost"] }, newCaption: "Hi", overwriteCustomConfirmed: false, expectedVersions: versions(items), changedBy: "bob", now: NOW });
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.skipped, 3);
  assert.match(result.results.find((r) => r.itemId === "pub")!.reason, /history/i);
  assert.equal(byId(result.items, "up2").captionText, "mine"); // not selected
});

test("PARTIAL FAILURE is reported honestly: stale version = conflict, others still updated", () => {
  const items = sampleItems();
  const stale = { ...versions(items), up1: 0 }; // user's screen was out of date for up1
  const result = applyBulkCaptionUpdate({ items, target: { kind: "all_upcoming" }, newCaption: "New!", overwriteCustomConfirmed: true, expectedVersions: stale, changedBy: "bob", now: NOW });
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(byId(result.items, "up1").captionText, ""); // untouched
});

test("RACE: worker claims an item after the user opened the screen -> caption update conflicts", () => {
  const items = sampleItems();
  const seenByUser = versions(items);
  // Worker claims up1 (bumps version, status -> publishing).
  const claim = claimItemForPublishing(makeCycle(), byId(items, "up1"), 1, "worker-1", NOW, 60);
  assert.ok(claim.claimed);
  const afterClaim = items.map((i) => (claim.claimed && i.id === "up1" ? claim.item : i));
  const result = applyBulkCaptionUpdate({ items: afterClaim, target: { kind: "selected", itemIds: ["up1"] }, newCaption: "Late edit", overwriteCustomConfirmed: true, expectedVersions: seenByUser, changedBy: "bob", now: NOW });
  assert.equal(result.summary.updated, 0);
  assert.equal(byId(result.items, "up1").captionText, ""); // publishing item unchanged
});

test("invalid caption changes nothing", () => {
  const items = sampleItems();
  const result = applyBulkCaptionUpdate({ items, target: { kind: "all_upcoming" }, newCaption: "x".repeat(5000), overwriteCustomConfirmed: true, expectedVersions: versions(items), changedBy: "bob", now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.items, items);
});

test("preview matches what apply will do and changes nothing", () => {
  const items = sampleItems();
  const before = JSON.stringify(items);
  const preview = previewBulkCaptionUpdate({ items, target: { kind: "all_upcoming" }, newCaption: "New!", overwriteCustomConfirmed: false });
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(preview.map((p) => [p.itemId, p.outcome]), [["up1", "will_update"], ["up2", "needs_overwrite_confirmation"]]);
});

test("single caption edit: marks it individual, records a revision, respects status and version", () => {
  const ok = editSingleCaption({ item: makeItem(), newCaption: "Mine", expectedVersion: 1, changedBy: "bob", now: NOW });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.item.captionSource, "individual"); assert.equal(ok.item.version, 2); assert.equal(ok.revision.newText, "Mine"); }
  assert.equal(editSingleCaption({ item: makeItem({ status: "published" }), newCaption: "x", expectedVersion: 1, changedBy: "bob", now: NOW }).ok, false);
  assert.equal(editSingleCaption({ item: makeItem(), newCaption: "x", expectedVersion: 9, changedBy: "bob", now: NOW }).ok, false);
});

test("bulk cover: upcoming items get saved_internally (never applied_on_instagram); published untouched", () => {
  const items = sampleItems();
  const result = applyBulkCoverUpdate({ items, target: { kind: "all_upcoming" }, newCoverMediaId: "cover1", overwriteCustomConfirmed: false, expectedVersions: versions(items), userMayUseCoverMedia: true, coverSupport: "supported" });
  assert.ok(result.ok);
  assert.equal(byId(result.items, "up1").coverMediaId, "cover1");
  assert.equal(byId(result.items, "up1").coverState, "saved_internally");
  assert.equal(byId(result.items, "pub").coverMediaId, null);
  assert.equal(byId(result.items, "busy").coverMediaId, null);
  assert.equal(result.warning, null);
  assert.ok(result.items.every((i) => i.coverState !== "applied_on_instagram"));
});

test("bulk cover: unsupported / unknown platform support is disclosed, selection is NOT discarded", () => {
  const items = sampleItems();
  const common = { items, target: { kind: "all_upcoming" } as const, newCoverMediaId: "cover1", overwriteCustomConfirmed: false, expectedVersions: versions(items), userMayUseCoverMedia: true };
  const unsupported = applyBulkCoverUpdate({ ...common, coverSupport: "unsupported" });
  assert.match(unsupported.warning ?? "", /NOT be applied on Instagram/);
  assert.equal(byId(unsupported.items, "up1").coverMediaId, "cover1");
  const unknown = applyBulkCoverUpdate({ ...common, coverSupport: "unknown" });
  assert.match(unknown.warning ?? "", /could not confirm/);
});

test("bulk cover: custom covers need confirmation; permission to use the image is required", () => {
  const items = [makeItem({ id: "c1", coverMediaId: "mine", coverIsCustom: true, coverState: "saved_internally" }), makeItem({ id: "c2" })];
  const noConfirm = applyBulkCoverUpdate({ items, target: { kind: "all_upcoming" }, newCoverMediaId: "new", overwriteCustomConfirmed: false, expectedVersions: { c1: 1, c2: 1 }, userMayUseCoverMedia: true, coverSupport: "supported" });
  assert.equal(noConfirm.items.find((i) => i.id === "c1")?.coverMediaId, "mine");
  assert.equal(noConfirm.items.find((i) => i.id === "c2")?.coverMediaId, "new");
  const noPermission = applyBulkCoverUpdate({ items, target: { kind: "all_upcoming" }, newCoverMediaId: "new", overwriteCustomConfirmed: true, expectedVersions: { c1: 1, c2: 1 }, userMayUseCoverMedia: false, coverSupport: "supported" });
  assert.equal(noPermission.ok, false);
  assert.deepEqual(noPermission.items, items);
  const preview = previewBulkCoverUpdate({ items, target: { kind: "all_upcoming" }, newCoverMediaId: "new", overwriteCustomConfirmed: false });
  assert.equal(preview[0]?.outcome, "needs_overwrite_confirmation");
});

test("bulk cover: stale version is a conflict", () => {
  const items = [makeItem({ id: "c2" })];
  const result = applyBulkCoverUpdate({ items, target: { kind: "all_upcoming" }, newCoverMediaId: "new", overwriteCustomConfirmed: false, expectedVersions: { c2: 0 }, userMayUseCoverMedia: true, coverSupport: "supported" });
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.items[0]?.coverMediaId, null);
});
