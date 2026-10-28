import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planImport, completeImport, failImport, switchItemToImportedCopy, findMediaDependencies, planOwnerDeletion,
  scheduleDeletionWithGracePeriod, blockItemsForRemovedSource, canPhysicallyDeleteMedia, markMediaDeleted,
  type MediaImportJob,
} from "../src/lib/domain/media-lifecycle.ts";
import { canKeepUsingSourceForCycleItem } from "../src/lib/domain/sharing-permissions.ts";
import { NOW, inDays, makeMedia, makeCollection, makeGrant, makeItem } from "./helpers.ts";

const importGrant = makeGrant({ capabilities: ["view", "import_copy"] });
const job = (over: Partial<MediaImportJob> = {}): MediaImportJob =>
  ({ id: "job1", importerId: "bob", sourceMediaId: "media1", status: "verifying", newObjectKey: "bob/copy.mp4", failureReason: null, ...over });
const planArgs = (over = {}) => ({ userId: "bob", media: makeMedia(), collection: makeCollection(), grants: [importGrant], now: NOW, existingJobs: [], storageUsedBytes: 0, storageLimitBytes: 10_000, warningAcknowledged: true, ...over });

// ---------- Import ----------
test("import requires the warning to be acknowledged, permission, and storage space", () => {
  assert.equal(planImport(planArgs({ warningAcknowledged: false })).kind, "denied");
  assert.equal(planImport(planArgs({ grants: [makeGrant()] })).kind, "denied");
  assert.equal(planImport(planArgs({ storageUsedBytes: 9_500 })).kind, "denied");
  assert.equal(planImport(planArgs()).kind, "allowed");
});

test("duplicate import is prevented (idempotent): returns the existing job", () => {
  const existing = job({ status: "copying" });
  const plan = planImport(planArgs({ existingJobs: [existing] }));
  assert.ok(plan.kind === "already_exists" && plan.existingJob.id === "job1");
  // A failed job does not block a fresh attempt.
  assert.equal(planImport(planArgs({ existingJobs: [job({ status: "failed" })] })).kind, "allowed");
});

test("successful import: verified copy -> charge storage once, create owned record", () => {
  const done = completeImport({ job: job(), sourceMedia: makeMedia(), collection: makeCollection(), grants: [importGrant], now: NOW, verification: { newObjectExists: true, copiedSizeBytes: 1000, checksumMatches: true } });
  assert.equal(done.job.status, "succeeded"); assert.equal(done.storageBytesToCharge, 1000);
  assert.equal(done.createOwnedMediaRecord, true); assert.equal(done.orphanObjectKeyToDelete, null);
});

test("failed import verification: no charge, no record, orphan object scheduled for cleanup", () => {
  const bad = [
    { newObjectExists: false, copiedSizeBytes: 0, checksumMatches: null },
    { newObjectExists: true, copiedSizeBytes: 999, checksumMatches: true },
    { newObjectExists: true, copiedSizeBytes: 1000, checksumMatches: false },
  ];
  for (const verification of bad) {
    const r = completeImport({ job: job(), sourceMedia: makeMedia(), collection: makeCollection(), grants: [importGrant], now: NOW, verification });
    assert.equal(r.job.status, "failed"); assert.equal(r.storageBytesToCharge, 0);
    assert.equal(r.createOwnedMediaRecord, false); assert.equal(r.orphanObjectKeyToDelete, "bob/copy.mp4");
  }
  const crashed = failImport(job({ status: "copying" }), "network error");
  assert.equal(crashed.orphanObjectKeyToDelete, "bob/copy.mp4"); assert.equal(crashed.storageBytesToCharge, 0);
  assert.throws(() => failImport(job({ status: "succeeded" }), "x"));
});

test("permission revoked while copying: import fails and cleans up", () => {
  const r = completeImport({ job: job(), sourceMedia: makeMedia(), collection: makeCollection(), grants: [makeGrant({ capabilities: ["view", "import_copy"], status: "revoked" })], now: NOW, verification: { newObjectExists: true, copiedSizeBytes: 1000, checksumMatches: true } });
  assert.equal(r.job.status, "failed"); assert.match(r.job.failureReason ?? "", /Permission changed/);
  assert.equal(r.orphanObjectKeyToDelete, "bob/copy.mp4");
});

test("import is allowed during the grace period (import before deletion)", () => {
  const graceMedia = makeMedia({ status: "pending_deletion", deleteAfter: inDays(2) });
  assert.equal(planImport(planArgs({ media: graceMedia })).kind, "allowed");
  assert.equal(planImport(planArgs({ media: makeMedia({ status: "pending_deletion", deleteAfter: inDays(-1) }) })).kind, "denied");
});

test("switching an upcoming item to the imported copy requires a succeeded import and the right owner", () => {
  const copy = makeMedia({ id: "copy1", ownerId: "bob" });
  const ok = switchItemToImportedCopy({ item: makeItem(), importedMedia: copy, job: job({ status: "succeeded" }) });
  assert.ok(ok.ok);
  if (ok.ok) { assert.equal(ok.item.mediaAssetId, "copy1"); assert.equal(ok.item.sourceKind, "imported_copy"); assert.equal(ok.item.sourceCollectionId, null); }
  assert.equal(switchItemToImportedCopy({ item: makeItem(), importedMedia: copy, job: job({ status: "copying" }) }).ok, false);
  assert.equal(switchItemToImportedCopy({ item: makeItem(), importedMedia: makeMedia({ id: "copy1", ownerId: "eve" }), job: job({ status: "succeeded" }) }).ok, false);
  assert.equal(switchItemToImportedCopy({ item: makeItem({ status: "published" }), importedMedia: copy, job: job({ status: "succeeded" }) }).ok, false);
});

// ---------- Deletion ----------
const depsArgs = (over = {}) => ({ media: makeMedia(), collections: [makeCollection()], grants: [makeGrant()], cycleItems: [makeItem()], importJobs: [], now: NOW, ...over });

test("dependencies: recipients, active items and imports are found; revoked grants and finished items are not", () => {
  const deps = findMediaDependencies(depsArgs({ importJobs: [job({ status: "copying" })] }));
  assert.deepEqual(deps.sharedWithUserIds, ["bob"]);
  assert.equal(deps.activeCycleItems.length, 1); assert.equal(deps.activeImportJobs.length, 1); assert.equal(deps.hasDependencies, true);
  const none = findMediaDependencies(depsArgs({ grants: [makeGrant({ status: "revoked" })], cycleItems: [makeItem({ status: "published" })] }));
  assert.equal(none.hasDependencies, false);
});

test("owner deletion: only the owner; no deps -> delete now; deps -> owner must choose (nothing silent)", () => {
  const media = makeMedia();
  const depsNone = findMediaDependencies(depsArgs({ grants: [], cycleItems: [] }));
  assert.equal(planOwnerDeletion({ requestedBy: "bob", media, dependencies: depsNone, reason: "normal" }).outcome, "denied");
  assert.equal(planOwnerDeletion({ requestedBy: "owner", media, dependencies: depsNone, reason: "normal" }).outcome, "delete_now");
  const deps = findMediaDependencies(depsArgs());
  const plan = planOwnerDeletion({ requestedBy: "owner", media, dependencies: deps, reason: "normal" });
  assert.ok(plan.outcome === "needs_owner_choice");
  if (plan.outcome === "needs_owner_choice") { assert.deepEqual(plan.options, ["cancel", "schedule_with_grace_period"]); assert.deepEqual(plan.affectedUserIds, ["bob"]); }
  assert.equal(planOwnerDeletion({ requestedBy: "owner", media: makeMedia({ status: "deleted" }), dependencies: depsNone, reason: "normal" }).outcome, "denied");
});

test("legal removal: no grace period; upcoming items blocked, imports failed, recipients told", () => {
  const deps = findMediaDependencies(depsArgs({ importJobs: [job({ id: "j9", status: "copying" })] }));
  const plan = planOwnerDeletion({ requestedBy: "owner", media: makeMedia(), dependencies: deps, reason: "legal_removal" });
  assert.ok(plan.outcome === "forced_removal");
  if (plan.outcome === "forced_removal") { assert.deepEqual(plan.cycleItemIdsToBlock, ["item1"]); assert.deepEqual(plan.importJobIdsToFail, ["j9"]); assert.deepEqual(plan.affectedUserIds, ["bob"]); }
});

test("grace period: marks media, real deleteAfter date, one honest notification per affected user", () => {
  const deps = findMediaDependencies(depsArgs());
  const result = scheduleDeletionWithGracePeriod({ media: makeMedia(), dependencies: deps, graceDays: 7, now: NOW, collections: [makeCollection()], grants: [importGrant, makeGrant()] });
  assert.ok(!("error" in result));
  if (!("error" in result)) {
    assert.equal(result.media.status, "pending_deletion"); assert.equal(result.media.deleteAfter?.getTime(), inDays(7).getTime());
    const n = result.notifications[0]!;
    assert.equal(result.notifications.length, 1);
    assert.deepEqual([n.userId, n.usedInActiveCycle, n.importSizeBytes, n.canImport, n.deleteAfter.getTime()], ["bob", true, 1000, true, inDays(7).getTime()]);
  }
  assert.ok("error" in scheduleDeletionWithGracePeriod({ media: makeMedia(), dependencies: deps, graceDays: 0, now: NOW, collections: [], grants: [] }));
  assert.ok("error" in scheduleDeletionWithGracePeriod({ media: makeMedia({ status: "deleted" }), dependencies: deps, graceDays: 3, now: NOW, collections: [], grants: [] }));
});

test("during the grace period an existing cycle item keeps working; after it, it is blocked for review", () => {
  const scheduled = scheduleDeletionWithGracePeriod({ media: makeMedia(), dependencies: findMediaDependencies(depsArgs()), graceDays: 7, now: NOW, collections: [], grants: [] });
  assert.ok(!("error" in scheduled));
  if ("error" in scheduled) return;
  const item = makeItem();
  assert.equal(canKeepUsingSourceForCycleItem(item, scheduled.media, makeCollection(), [makeGrant()], inDays(3)).allowed, true);
  assert.equal(canKeepUsingSourceForCycleItem(item, scheduled.media, makeCollection(), [makeGrant()], inDays(8)).allowed, false);

  const items = [makeItem({ id: "up" }), makeItem({ id: "pub", status: "published" }), makeItem({ id: "busy", status: "publishing" }), makeItem({ id: "other", mediaAssetId: "zzz" })];
  const blocked = blockItemsForRemovedSource(items, "media1");
  const st = (id: string) => blocked.find((i) => i.id === id)!;
  assert.equal(st("up").status, "needs_review"); assert.equal(st("up").reviewReason, "source_removed");
  assert.equal(st("pub").status, "published"); assert.equal(st("busy").status, "publishing"); assert.equal(st("other").status, "upcoming");
});

test("physical deletion is blocked while anything still needs the file", () => {
  const afterGrace = makeMedia({ status: "pending_deletion", deleteAfter: inDays(-1) });
  const check = (over: object) => canPhysicallyDeleteMedia({ media: afterGrace, cycleItems: [], importJobs: [], now: NOW, ...over });
  assert.equal(check({}).allowed, true);
  assert.equal(canPhysicallyDeleteMedia({ media: makeMedia(), cycleItems: [], importJobs: [], now: NOW }).allowed, false); // active media
  assert.equal(canPhysicallyDeleteMedia({ media: makeMedia({ status: "pending_deletion", deleteAfter: inDays(2) }), cycleItems: [], importJobs: [], now: NOW }).allowed, false); // grace not over
  assert.equal(check({ cycleItems: [makeItem({ status: "publishing" })] }).allowed, false);
  assert.equal(check({ cycleItems: [makeItem({ status: "processing" })] }).allowed, false);
  assert.equal(check({ cycleItems: [makeItem({ status: "upcoming" })] }).allowed, false);
  assert.equal(check({ importJobs: [job({ status: "copying" })] }).allowed, false);
  assert.equal(check({ cycleItems: [makeItem({ status: "published" }), makeItem({ status: "needs_review" })] }).allowed, true); // history / blocked items don't need the file
  assert.equal(canPhysicallyDeleteMedia({ media: markMediaDeleted(makeMedia()), cycleItems: [], importJobs: [], now: NOW }).allowed, true);
});

test("an independent import survives deletion of the original (separate media record)", () => {
  // The copy has its own id/owner, so physical deletion of the original does not look at it.
  const copy = makeMedia({ id: "copy1", ownerId: "bob" });
  const copyItem = makeItem({ mediaAssetId: "copy1", sourceKind: "imported_copy", status: "upcoming" });
  const originalGone = makeMedia({ status: "deleted" });
  assert.equal(canPhysicallyDeleteMedia({ media: originalGone, cycleItems: [copyItem], importJobs: [], now: NOW }).allowed, true);
  assert.equal(canKeepUsingSourceForCycleItem(copyItem, copy, null, [], NOW).allowed, true);
});
