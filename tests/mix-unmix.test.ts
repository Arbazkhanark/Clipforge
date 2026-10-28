import { test } from "node:test";
import assert from "node:assert/strict";
import { mixVideosIntoCycle, reorderUpcomingItems, unmixItems } from "../src/lib/domain/mix-unmix.ts";
import { NOW, makeMedia, makeCollection, makeGrant, makeItem } from "./helpers.ts";

const FULL = { useSharedVideosInCycles: true, mixAndUnmix: true };
const own = (id: string) => ({ media: makeMedia({ id, ownerId: "bob" }), collection: makeCollection({ id: "mine", ownerId: "bob", mediaIds: [id] }) });
const shared = (id: string) => ({ media: makeMedia({ id, ownerId: "owner" }), collection: makeCollection({ id: "col1", ownerId: "owner", mediaIds: [id] }) });

test("mix owned + shared videos; source kinds and positions are recorded", () => {
  const result = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), shared("s1")], existingItems: [], grants: [makeGrant()], planFeatures: FULL, now: NOW });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.accepted.map((a) => [a.mediaAssetId, a.sourceKind, a.sourceCollectionId, a.position]),
    [["a", "owned", "mine", 1], ["s1", "shared_reference", "col1", 2]]);
});

test("new items are appended after existing positions", () => {
  const existing = [makeItem({ id: "x", mediaAssetId: "x", position: 7 })];
  const result = mixVideosIntoCycle({ userId: "bob", candidates: [own("a")], existingItems: existing, grants: [], planFeatures: FULL, now: NOW });
  assert.equal(result.accepted[0]?.position, 8);
});

test("shared video without permission is rejected but others still accepted", () => {
  const result = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), shared("s1")], existingItems: [], grants: [makeGrant({ capabilities: ["view"] })], planFeatures: FULL, now: NOW });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected[0]?.mediaAssetId, "s1");
});

test("plan gates: shared use and mixing owners are blocked when the plan lacks the feature", () => {
  const noShared = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), shared("s1")], existingItems: [], grants: [makeGrant()], planFeatures: { useSharedVideosInCycles: false, mixAndUnmix: false }, now: NOW });
  assert.equal(noShared.accepted.length, 0);
  const noMix = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), shared("s1")], existingItems: [], grants: [makeGrant()], planFeatures: { useSharedVideosInCycles: true, mixAndUnmix: false }, now: NOW });
  assert.equal(noMix.accepted.length, 0);
  // Only own videos: fine even on a plan without the features.
  const ownOnly = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), own("b")], existingItems: [], grants: [], planFeatures: { useSharedVideosInCycles: false, mixAndUnmix: false }, now: NOW });
  assert.equal(ownOnly.accepted.length, 2);
});

test("duplicates are rejected unless confirmed; cancelled items do not count as duplicates", () => {
  const existing = [makeItem({ id: "i1", mediaAssetId: "a" }), makeItem({ id: "i2", mediaAssetId: "b", status: "cancelled" })];
  const base = { userId: "bob", existingItems: existing, grants: [], planFeatures: FULL, now: NOW };
  const r1 = mixVideosIntoCycle({ ...base, candidates: [own("a"), own("b"), own("a")] });
  assert.deepEqual(r1.accepted.map((x) => x.mediaAssetId), ["b"]);
  assert.equal(r1.rejected.length, 2);
  const r2 = mixVideosIntoCycle({ ...base, candidates: [own("a")], confirmedDuplicateMediaIds: ["a"] });
  assert.equal(r2.accepted.length, 1);
});

test("same video listed in two selected collections is added once", () => {
  const dup = { media: makeMedia({ id: "a", ownerId: "bob" }), collection: makeCollection({ id: "other", ownerId: "bob", mediaIds: ["a"] }) };
  const result = mixVideosIntoCycle({ userId: "bob", candidates: [own("a"), dup], existingItems: [], grants: [], planFeatures: FULL, now: NOW });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
});

test("an imported copy is marked imported_copy", () => {
  const c = { ...own("copy1"), isImportedCopy: true };
  const result = mixVideosIntoCycle({ userId: "bob", candidates: [c], existingItems: [], grants: [], planFeatures: FULL, now: NOW });
  assert.equal(result.accepted[0]?.sourceKind, "imported_copy");
});

test("reorder: only upcoming items move; published and in-flight items keep their positions", () => {
  const items = [
    makeItem({ id: "p", position: 1, status: "published" }),
    makeItem({ id: "a", position: 2 }), makeItem({ id: "b", position: 3 }),
    makeItem({ id: "w", position: 4, status: "publishing" }),
    makeItem({ id: "c", position: 5, status: "scheduled" }),
  ];
  const result = reorderUpcomingItems(items, ["c", "a", "b"]);
  assert.ok(result.ok);
  if (result.ok) {
    const pos = Object.fromEntries(result.items.map((i) => [i.id, i.position]));
    assert.deepEqual(pos, { p: 1, c: 2, a: 3, b: 5, w: 4 });
    assert.equal(result.items.find((i) => i.id === "p")?.version, 1); // untouched
  }
});

test("reorder rejects published/in-flight ids, duplicates and incomplete lists", () => {
  const items = [makeItem({ id: "p", status: "published" }), makeItem({ id: "a", position: 2 }), makeItem({ id: "b", position: 3 })];
  assert.equal(reorderUpcomingItems(items, ["p", "a"]).ok, false);
  assert.equal(reorderUpcomingItems(items, ["a", "a"]).ok, false);
  assert.equal(reorderUpcomingItems(items, ["a"]).ok, false);
});

test("unmix removes upcoming items by cancelling (row kept) and never touches published or in-flight", () => {
  const items = [
    makeItem({ id: "up", status: "upcoming" }), makeItem({ id: "pub", status: "published" }),
    makeItem({ id: "busy", status: "publishing", lockedBy: "w1" }), makeItem({ id: "keep", status: "upcoming" }),
  ];
  const result = unmixItems(items, ["up", "pub", "busy"]);
  assert.deepEqual(result.removedItemIds, ["up"]);
  assert.equal(result.items.find((i) => i.id === "up")?.status, "cancelled");
  assert.equal(result.items.find((i) => i.id === "pub")?.status, "published");
  assert.equal(result.items.find((i) => i.id === "busy")?.status, "publishing");
  assert.equal(result.items.find((i) => i.id === "keep")?.status, "upcoming");
  assert.equal(result.items.length, 4); // nothing deleted
  assert.deepEqual(result.blocked.map((b) => b.itemId).sort(), ["busy", "pub"]);
});

test("unmix is pure: it does not mutate its input", () => {
  const items = [makeItem({ id: "up" })];
  unmixItems(items, ["up"]);
  assert.equal(items[0]?.status, "upcoming");
});
