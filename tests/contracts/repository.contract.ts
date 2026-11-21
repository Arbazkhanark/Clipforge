// Reusable test suite for the data Repository: MemoryRepository passes it today; PrismaRepository (over a FAKE client now,
// over real PostgreSQL later) must pass the very same tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Repository, CycleRecord, MediaVerificationJobRecord, PersistedCycleSchedule, SocialAccountRecord } from "../../src/server/repository.ts";
import type { PlanId } from "../../src/lib/billing/catalog.ts";
import { DEFAULT_EDITING_SETTINGS } from "../../src/lib/domain/editing-settings.ts";
import type { CollectionPermissionGrant, CycleItem, MediaAsset, VideoCollection } from "../../src/lib/domain/types.ts";

export interface RepoHarness {
  repo: Repository;
  seedPlan(userId: string, plan: PlanId): Promise<void>;
  seedMedia(media: MediaAsset, keys?: { storageKey: string; thumbnailKey: string | null }): Promise<void>;
  seedCollection(collection: VideoCollection): Promise<void>;
  seedGrant(grant: CollectionPermissionGrant): Promise<void>;
  seedSocialAccount(account: SocialAccountRecord): Promise<void>;
  seedCycle(cycle: CycleRecord): Promise<void>;
  seedItems(items: CycleItem[]): Promise<void>;
  seedUsage(userId: string, monthStart: Date, usage: { processingSeconds: number; exports: number; scheduledItems: number }): Promise<void>;
  auditActions(): Promise<string[]>;
  revisionCount(): Promise<number>;
}

const T0 = new Date("2026-06-01T12:00:00Z"); const day = 86_400_000;
const sampleSchedule: PersistedCycleSchedule = { timeZone: "Asia/Kolkata", intervalMinutes: 1440, postsPerInterval: 1, daysOfWeek: [1, 2, 3, 4, 5], windowStart: "09:00", windowEnd: "09:00", dailyMax: 1, endDate: null, startDate: "2026-06-02", orderMode: "shuffle", shuffleSeed: "stable_seed_01" };
const media = (id: string, ownerId: string, over: Partial<MediaAsset> = {}): MediaAsset => ({ id, ownerId, status: "active", sizeBytes: 100, deleteAfter: null, title: id, kind: "video", durationMs: 1000, createdAt: new Date(T0.getTime() - day), width: 160, height: 120, validation: "verified", mimeType: "video/mp4", ...over });
const collection = (id: string, ownerId: string, mediaIds: string[], over: Partial<VideoCollection> = {}): VideoCollection => ({ id, ownerId, visibility: "private", archived: false, mediaIds, name: id, ...over });
const grant = (collectionId: string, granteeId: string, over: Partial<CollectionPermissionGrant> = {}): CollectionPermissionGrant => ({ collectionId, granteeId, capabilities: ["view"], status: "active", expiresAt: null, grantedById: "owner", ...over });
const cycle = (id: string, ownerId: string, over: Partial<CycleRecord> = {}): CycleRecord => ({ id, ownerId, status: "draft", finalReviewConfirmed: false, name: id, socialAccountId: "acct", ...over });
const item = (id: string, cycleId: string, over: Partial<CycleItem> = {}): CycleItem => ({ id, cycleId, cycleOwnerId: "bob", mediaAssetId: `m-${id}`, selectedRenderOutputId: null, sourceKind: "owned", sourceCollectionId: null, status: "upcoming", position: 1, version: 1, scheduledFor: null, captionText: "", captionSource: "none", coverMediaId: null, coverIsCustom: false, coverState: "none", lockedBy: null, lockExpiresAt: null, reviewReason: null, ...over });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

export function runRepositoryContract(name: string, factory: () => Promise<RepoHarness> | RepoHarness): void {
  const t = (title: string, fn: (h: RepoHarness) => Promise<void>) => test(`[${name}] ${title}`, async () => fn(await factory()));

  t("plan: free by default, seeded plan returned", async (h) => {
    await h.seedPlan("bob", "pro");
    assert.equal(await h.repo.getPlanIdForUser("bob"), "pro"); assert.equal(await h.repo.getPlanIdForUser("nobody"), "free");
  });

  t("media: get, getMany, missing ids absent, fields round-trip, storage keys are NOT part of the media object", async (h) => {
    await h.seedMedia(media("m1", "bob", { title: "Clip One", durationMs: 2500, validation: "incomplete" }), { storageKey: "media/bob/m1", thumbnailKey: "thumb/bob/m1" });
    const m = (await h.repo.getMedia("m1"))!;
    assert.deepEqual([m.id, m.ownerId, m.title, m.kind, m.durationMs, m.sizeBytes, m.status, m.mimeType, m.hasThumbnail], ["m1", "bob", "Clip One", "video", 2500, 100, "active", "video/mp4", true]);
    assert.ok(!JSON.stringify(m).includes("media/bob/m1") && !JSON.stringify(m).includes("thumb/bob"));
    assert.equal(await h.repo.getMedia("nope"), null);
    assert.deepEqual(ids(await h.repo.getMediaByIds(["m1", "ghost"])), ["m1"]); assert.deepEqual(await h.repo.getMediaByIds([]), []);
    assert.deepEqual(await h.repo.getMediaStorageInfo("m1"), { storageKey: "media/bob/m1", thumbnailKey: "thumb/bob/m1", mimeType: "video/mp4" });
    assert.equal(await h.repo.getMediaStorageInfo("nope"), null);
  });

  t("media list: only the owner's, newest first, paged with a true total, kind filter, deleted hidden", async (h) => {
    for (let i = 1; i <= 5; i++) await h.seedMedia(media(`v${i}`, "bob", { createdAt: new Date(T0.getTime() - i * day) }), { storageKey: `media/bob/v${i}`, thumbnailKey: null });
    await h.seedMedia(media("img", "bob", { kind: "image", durationMs: null, createdAt: new Date(T0.getTime() - 9 * day), mimeType: "image/png" }), { storageKey: "media/bob/img", thumbnailKey: null });
    await h.seedMedia(media("gone", "bob", { status: "deleted" }), { storageKey: "media/bob/gone", thumbnailKey: null });
    await h.seedMedia(media("theirs", "eve"), { storageKey: "media/eve/theirs", thumbnailKey: null });
    const first = await h.repo.listMediaForOwner("bob", { limit: 4, offset: 0 });
    assert.equal(first.total, 6); assert.deepEqual(first.items.map((m) => m.id), ["v1", "v2", "v3", "v4"]);
    assert.deepEqual((await h.repo.listMediaForOwner("bob", { limit: 4, offset: 4 })).items.map((m) => m.id), ["v5", "img"]);
    assert.deepEqual((await h.repo.listMediaForOwner("bob", { limit: 10, offset: 0, kind: "image" })).items.map((m) => m.id), ["img"]);
    assert.equal((await h.repo.listMediaForOwner("bob", { limit: 10, offset: 99 })).items.length, 0);
    assert.deepEqual((await h.repo.listMediaForOwner("bob", { limit: 10, offset: 0, search: "v1" })).items.map((m) => m.id), ["v1"]);
    assert.deepEqual((await h.repo.listMediaForOwner("bob", { limit: 10, offset: 0, sort: "oldest" })).items.map((m) => m.id), ["img", "v5", "v4", "v3", "v2", "v1"]);
    assert.deepEqual((await h.repo.listMediaForOwner("eve", { limit: 10, offset: 0, search: "v1" })).items, []);
    assert.equal(await h.repo.getStorageUsedBytes("bob"), 600); assert.equal(await h.repo.getStorageUsedBytes("nobody"), 0);
  });

  t("quota: insert only if it fits (exactly at the limit is fine); refused uploads leave nothing behind; deleted media does not count", async (h) => {
    await h.seedMedia(media("big", "bob", { sizeBytes: 900 }), { storageKey: "media/bob/big", thumbnailKey: null });
    assert.equal(await h.repo.addMediaIfStorageWithin(media("new1", "bob", { sizeBytes: 101 }), { storageKey: "media/bob/new1", thumbnailKey: null }, 1000), false);
    assert.equal(await h.repo.getMedia("new1"), null); assert.equal(await h.repo.getMediaStorageInfo("new1"), null);
    assert.equal(await h.repo.addMediaIfStorageWithin(media("new2", "bob", { sizeBytes: 100 }), { storageKey: "media/bob/new2", thumbnailKey: "thumb/bob/new2" }, 1000), true);
    assert.deepEqual(await h.repo.getMediaStorageInfo("new2"), { storageKey: "media/bob/new2", thumbnailKey: "thumb/bob/new2", mimeType: "video/mp4" });
    assert.equal(await h.repo.getStorageUsedBytes("bob"), 1000);
    assert.equal(await h.repo.addMediaIfStorageWithin(media("new3", "eve", { sizeBytes: 500 }), { storageKey: "media/eve/new3", thumbnailKey: null }, 1000), true); // other users are separate
  });

  t("quota RACE: simultaneous inserts that fit alone but not together - exactly one wins", async (h) => {
    await h.seedMedia(media("big", "bob", { sizeBytes: 800 }), { storageKey: "media/bob/big", thumbnailKey: null });
    const results = await Promise.all([1, 2, 3].map((n) => h.repo.addMediaIfStorageWithin(media(`r${n}`, "bob", { sizeBytes: 150 }), { storageKey: `media/bob/r${n}`, thumbnailKey: null }, 1000)));
    assert.equal(results.filter(Boolean).length, 1); assert.equal(await h.repo.getStorageUsedBytes("bob"), 950);
  });

  t("collections: owned list keeps media order; shared list needs a VALID grant (not revoked, not expired, not own); containing-media lookup", async (h) => {
    await h.seedCollection(collection("c1", "owner", ["m2", "m1"], { visibility: "link", description: "Hello", archived: true }));
    await h.seedCollection(collection("c2", "owner", ["m3"])); await h.seedCollection(collection("c3", "owner", [])); await h.seedCollection(collection("bobs", "bob", ["m1"]));
    await h.seedGrant(grant("c1", "bob")); await h.seedGrant(grant("c2", "bob", { status: "revoked" })); await h.seedGrant(grant("c3", "bob", { expiresAt: new Date(T0.getTime() - 1000) }));
    const owned = await h.repo.listCollectionsForOwner("owner"); assert.deepEqual(ids(owned), ["c1", "c2", "c3"]);
    const c1 = (await h.repo.getCollection("c1"))!; assert.deepEqual([c1.mediaIds, c1.visibility, c1.archived, c1.description, c1.name], [["m2", "m1"], "link", true, "Hello", "c1"]);
    assert.equal((await h.repo.getCollection("c3"))!.description, undefined); assert.equal(await h.repo.getCollection("nope"), null);
    assert.deepEqual(ids(await h.repo.listCollectionsSharedWith("bob", T0)), ["c1"]);          // revoked and expired excluded, own collection excluded
    assert.deepEqual(ids(await h.repo.listCollectionsContainingMedia("m1")), ["bobs", "c1"]);
    assert.deepEqual(await h.repo.listCollectionsContainingMedia("lonely"), []);
  });

  t("grants: upsert creates then UPDATES (one row per person), keeps who granted, revoked state persists", async (h) => {
    await h.seedCollection(collection("c1", "owner", []));
    await h.repo.upsertGrant(grant("c1", "bob", { capabilities: ["view"], expiresAt: new Date(T0.getTime() + day), grantedById: "mgr" }));
    await h.repo.upsertGrant(grant("c1", "bob", { capabilities: ["view", "use_in_cycle"], expiresAt: null, grantedById: "owner" }));
    await h.repo.upsertGrant(grant("c1", "carol", { capabilities: ["view", "download"] }));
    const grants = await h.repo.getGrants("c1");
    assert.equal(grants.length, 2);
    const bob = grants.find((g) => g.granteeId === "bob")!; assert.deepEqual([bob.capabilities, bob.expiresAt, bob.grantedById, bob.status], [["view", "use_in_cycle"], null, "owner", "active"]);
    await h.repo.upsertGrant({ ...bob, status: "revoked" });
    assert.equal((await h.repo.getGrants("c1")).find((g) => g.granteeId === "bob")!.status, "revoked");
    assert.deepEqual(await h.repo.getGrants("other"), []);
  });

  t("cycles: create/get/list, active count (stopped does not count), status moves are compare-and-set, concurrent starts - one wins", async (h) => {
    await h.repo.createCycle(cycle("cy1", "bob", { name: "June" })); await h.repo.createCycle(cycle("cy2", "bob", { status: "stopped" })); await h.repo.createCycle(cycle("cy3", "eve"));
    const c = (await h.repo.getCycle("cy1"))!; assert.deepEqual([c.name, c.ownerId, c.status, c.finalReviewConfirmed, c.socialAccountId], ["June", "bob", "draft", false, "acct"]);
    assert.equal(await h.repo.getCycle("nope"), null);
    assert.deepEqual(ids(await h.repo.listCyclesForOwner("bob")), ["cy1", "cy2"]);
    assert.equal(await h.repo.countActiveCycles("bob"), 1);
    assert.equal(await h.repo.transitionCycleStatus("cy1", "running", "paused", false), false);   // wrong "from": nothing changes
    assert.equal((await h.repo.getCycle("cy1"))!.status, "draft");
    const races = await Promise.all([h.repo.transitionCycleStatus("cy1", "draft", "running", true), h.repo.transitionCycleStatus("cy1", "draft", "running", true)]);
    assert.equal(races.filter(Boolean).length, 1);
    assert.deepEqual([(await h.repo.getCycle("cy1"))!.status, (await h.repo.getCycle("cy1"))!.finalReviewConfirmed], ["running", true]);
  });

  t("cycle items: ordered by position; version-checked save changes only when the version matches; races have one winner; identity never changes", async (h) => {
    await h.seedCycle(cycle("cy1", "bob"));
    await h.seedCycle(cycle("cy2", "bob"));
    await h.seedItems([item("b", "cy1", { position: 2 }), item("a", "cy1", { position: 1, scheduledFor: new Date(T0.getTime() + day) }), item("z", "cy2")]);
    await h.repo.addCycleItems([]);
    const items = await h.repo.getCycleItems("cy1"); assert.deepEqual(items.map((i) => i.id), ["a", "b"]); assert.equal(items[0]!.scheduledFor!.getTime(), T0.getTime() + day);
    const a = items[0]!;
    const edited = { ...a, captionText: "New", captionSource: "bulk" as const, version: 2 };
    assert.deepEqual(await h.repo.saveCycleItemsIfVersionMatches([{ item: edited, expectedVersion: 1 }]), [{ itemId: "a", saved: true }]);
    const saved = (await h.repo.getCycleItems("cy1"))[0]!; assert.deepEqual([saved.captionText, saved.version, saved.cycleId, saved.cycleOwnerId], ["New", 2, "cy1", "bob"]);
    const identityChanged = { ...saved, mediaAssetId: "standalone-media", sourceCollectionId: null, version: 3 };
    assert.deepEqual(await h.repo.saveCycleItemsIfVersionMatches([{ item: identityChanged, expectedVersion: 2 }]), [{ itemId: "a", saved: false }]);
    assert.deepEqual([(await h.repo.getCycleItems("cy1"))[0]!.mediaAssetId, (await h.repo.getCycleItems("cy1"))[0]!.sourceCollectionId], [a.mediaAssetId, a.sourceCollectionId]);
    assert.deepEqual(await h.repo.saveCycleItemsIfVersionMatches([{ item: { ...a, captionText: "Stale", version: 2 }, expectedVersion: 1 }]), [{ itemId: "a", saved: false }]);
    assert.equal((await h.repo.getCycleItems("cy1"))[0]!.captionText, "New");
    assert.deepEqual(await h.repo.saveCycleItemsIfVersionMatches([{ item: { ...a, id: "ghost", version: 2 }, expectedVersion: 1 }]), [{ itemId: "ghost", saved: false }]);
    const current = (await h.repo.getCycleItems("cy1"))[0]!;
    const race = await Promise.all(["ONE", "TWO"].map((c) => h.repo.saveCycleItemsIfVersionMatches([{ item: { ...current, captionText: c, version: 3 }, expectedVersion: 2 }])));
    assert.equal(race.flat().filter((r) => r.saved).length, 1); assert.equal((await h.repo.getCycleItems("cy1"))[0]!.version, 3);
    assert.equal((await h.repo.getCycleItems("cy2")).length, 1);                                   // other cycle untouched
  });

  t("stop cycle: owned status change and item cancellation are atomic and version checked", async (h) => {
    await h.repo.createCycle(cycle("stop-cycle", "bob"));
    const queued = item("stop-item", "stop-cycle", { cycleOwnerId: "bob", status: "scheduled", scheduledFor: new Date(T0.getTime() + day) });
    await h.seedItems([queued]);
    const cancelled = { ...queued, status: "cancelled" as const, scheduledFor: null, version: 2 };
    assert.equal(await h.repo.stopCycle("stop-cycle", "eve", "draft", false, [{ item: cancelled, expectedVersion: 1 }]), false);
    assert.equal((await h.repo.getCycle("stop-cycle"))!.status, "draft");
    assert.equal(await h.repo.stopCycle("stop-cycle", "bob", "draft", false, [{ item: cancelled, expectedVersion: 99 }]), false);
    assert.deepEqual([(await h.repo.getCycle("stop-cycle"))!.status, (await h.repo.getCycleItems("stop-cycle"))[0]!.status], ["draft", "scheduled"]);
    assert.equal(await h.repo.stopCycle("stop-cycle", "bob", "draft", false, [{ item: cancelled, expectedVersion: 1 }]), true);
    assert.deepEqual([(await h.repo.getCycle("stop-cycle"))!.status, (await h.repo.getCycleItems("stop-cycle"))[0]!.status], ["stopped", "cancelled"]);
  });

  t("cycle schedule: settings and assigned item times save atomically for the owner while draft; stale item/status/owner changes reject", async (h) => {
    await h.repo.createCycle(cycle("schedule-cycle", "bob"));
    const queued = item("schedule-item", "schedule-cycle", { cycleOwnerId: "bob" });
    await h.seedItems([queued]);
    const scheduled = { ...queued, status: "scheduled" as const, scheduledFor: new Date("2026-06-02T03:30:00Z"), version: 2 };
    assert.equal(await h.repo.saveCycleSchedule("schedule-cycle", "bob", sampleSchedule, [{ item: scheduled, expectedVersion: 1 }]), true);
    assert.deepEqual((await h.repo.getCycle("schedule-cycle"))!.scheduleSettings, sampleSchedule);
    assert.deepEqual((await h.repo.getCycle("schedule-cycle"))!.orderMode, "shuffle");
    assert.equal((await h.repo.getCycle("schedule-cycle"))!.timezone, "Asia/Kolkata");
    assert.deepEqual([(await h.repo.getCycleItems("schedule-cycle"))[0]!.status, (await h.repo.getCycleItems("schedule-cycle"))[0]!.scheduledFor!.toISOString()], ["scheduled", "2026-06-02T03:30:00.000Z"]);
    const changed = { ...scheduled, status: "upcoming" as const, scheduledFor: null, version: 3 };
    const modifiedSettings = { ...sampleSchedule, timeZone: "UTC" };
    assert.equal(await h.repo.saveCycleSchedule("schedule-cycle", "bob", modifiedSettings, [{ item: changed, expectedVersion: 1 }]), false);
    assert.equal((await h.repo.getCycle("schedule-cycle"))!.scheduleSettings!.timeZone, "Asia/Kolkata"); // item conflict rolled back settings too
    assert.equal(await h.repo.saveCycleSchedule("schedule-cycle", "eve", modifiedSettings, []), false);
    assert.equal(await h.repo.transitionCycleStatus("schedule-cycle", "draft", "running", true), true);
    assert.equal(await h.repo.saveCycleSchedule("schedule-cycle", "bob", modifiedSettings, []), false);
  });

  t("cycle item render output: explicitly selects only owned successful derivative matching source, version-checked, clearing allowed", async (h) => {
    await h.repo.createCycle(cycle("output-cycle", "bob"));
    await h.seedMedia(media("m-src1", "bob"), { storageKey: "media/bob/src1", thumbnailKey: null });
    await h.seedMedia(media("m-src2", "bob"), { storageKey: "media/bob/src2", thumbnailKey: null });
    const item1 = item("ci-1", "output-cycle", { cycleOwnerId: "bob", mediaAssetId: "m-src1", version: 1 });
    await h.seedItems([item1]);
    await h.repo.saveRenderOutput({ id: "deriv-1", ownerId: "bob", sourceMediaId: "m-src1", storageKey: "render/bob/deriv-1", sizeBytes: 500, settingsHash: "h1", createdAt: T0 }, 1_000_000);
    await h.repo.saveRenderOutput({ id: "deriv-wrong-owner", ownerId: "eve", sourceMediaId: "m-src1", storageKey: "render/eve/d", sizeBytes: 500, settingsHash: "h2", createdAt: T0 }, 1_000_000);
    await h.repo.saveRenderOutput({ id: "deriv-wrong-source", ownerId: "bob", sourceMediaId: "m-src2", storageKey: "render/bob/d2", sizeBytes: 500, settingsHash: "h3", createdAt: T0 }, 1_000_000);

    // Initial state: unselected
    assert.equal((await h.repo.getCycleItems("output-cycle"))[0]!.selectedRenderOutputId, null);

    // Wrong owner rejected
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "deriv-wrong-owner", expectedVersion: 1 }), false);
    // Wrong caller owner rejected
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "eve", renderOutputId: "deriv-1", expectedVersion: 1 }), false);
    // Wrong source media rejected
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "deriv-wrong-source", expectedVersion: 1 }), false);
    // Stale version rejected
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "deriv-1", expectedVersion: 99 }), false);
    // Non-existent derivative rejected
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "does-not-exist", expectedVersion: 1 }), false);

    // Valid selection succeeds and increments version
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "deriv-1", expectedVersion: 1 }), true);
    const updated = (await h.repo.getCycleItems("output-cycle"))[0]!;
    assert.equal(updated.selectedRenderOutputId, "deriv-1");
    assert.equal(updated.version, 2);

    // Clearing selection with null succeeds and increments version
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: null, expectedVersion: 2 }), true);
    const cleared = (await h.repo.getCycleItems("output-cycle"))[0]!;
    assert.equal(cleared.selectedRenderOutputId, null);
    assert.equal(cleared.version, 3);

    // Re-select for status check
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: "deriv-1", expectedVersion: 3 }), true);

    // Non-draft cycle rejects selection
    assert.equal(await h.repo.transitionCycleStatus("output-cycle", "draft", "running", true), true);
    assert.equal(await h.repo.selectCycleItemRenderOutput({ cycleId: "output-cycle", itemId: "ci-1", ownerId: "bob", renderOutputId: null, expectedVersion: 4 }), false);
  });

  t("render outputs: listRenderOutputsForOwnerAndSource filters by owner and source, sorted by createdAt desc, id asc", async (h) => {
    const t1 = new Date(T0.getTime() + 1000);
    const t2 = new Date(T0.getTime() + 2000);
    await h.repo.saveRenderOutput({ id: "ro-old", ownerId: "bob", sourceMediaId: "m-s1", storageKey: "k1", sizeBytes: 100, settingsHash: "s1", createdAt: t1 }, 1_000_000);
    await h.repo.saveRenderOutput({ id: "ro-new", ownerId: "bob", sourceMediaId: "m-s1", storageKey: "k2", sizeBytes: 200, settingsHash: "s2", createdAt: t2 }, 1_000_000);
    await h.repo.saveRenderOutput({ id: "ro-other-src", ownerId: "bob", sourceMediaId: "m-s2", storageKey: "k3", sizeBytes: 300, settingsHash: "s3", createdAt: t2 }, 1_000_000);
    await h.repo.saveRenderOutput({ id: "ro-other-owner", ownerId: "eve", sourceMediaId: "m-s1", storageKey: "k4", sizeBytes: 400, settingsHash: "s4", createdAt: t2 }, 1_000_000);

    const bobOutputs = await h.repo.listRenderOutputsForOwnerAndSource("bob", "m-s1");
    assert.deepEqual(bobOutputs.map((o) => o.id), ["ro-new", "ro-old"]);
    assert.equal(bobOutputs[0]!.sizeBytes, 200);

    const eveOutputs = await h.repo.listRenderOutputsForOwnerAndSource("eve", "m-s1");
    assert.deepEqual(eveOutputs.map((o) => o.id), ["ro-other-owner"]);

    const emptyOutputs = await h.repo.listRenderOutputsForOwnerAndSource("bob", "non-existent");
    assert.deepEqual(emptyOutputs, []);
  });

  t("usage: monthly sums, scheduled-items count and recent publish times (own published items only)", async (h) => {
    const month = new Date(Date.UTC(2026, 5, 1));
    await h.seedUsage("bob", month, { processingSeconds: 600, exports: 4, scheduledItems: 12 });
    await h.seedUsage("bob", new Date(Date.UTC(2026, 4, 1)), { processingSeconds: 99, exports: 99, scheduledItems: 99 });
    assert.deepEqual(await h.repo.getMonthlyUsage("bob", month), { processingSeconds: 600, exports: 4 });
    assert.equal(await h.repo.getScheduledItemsUsedThisMonth("bob", month), 12);
    assert.deepEqual(await h.repo.getMonthlyUsage("nobody", month), { processingSeconds: 0, exports: 0 }); assert.equal(await h.repo.getScheduledItemsUsedThisMonth("nobody", month), 0);
    await h.seedCycle(cycle("cy1", "bob")); await h.seedCycle(cycle("cy9", "eve"));
    const recent = new Date(T0.getTime() - 3_600_000), old = new Date(T0.getTime() - 3 * day);
    await h.seedItems([item("p1", "cy1", { status: "published", scheduledFor: recent }), item("p2", "cy1", { status: "published", scheduledFor: old }), item("u1", "cy1", { status: "upcoming", scheduledFor: recent }), item("e1", "cy9", { status: "published", scheduledFor: recent, cycleOwnerId: "eve" })]);
    const times = await h.repo.getRecentPublishTimes("bob", new Date(T0.getTime() - day));
    assert.deepEqual(times.map((d) => d.getTime()), [recent.getTime()]);
    assert.deepEqual(await h.repo.getRecentPublishTimes("nobody", old), []);
  });

  t("social accounts: lookup and per-owner list", async (h) => {
    await h.seedSocialAccount({ id: "a1", userId: "bob", status: "connected" }); await h.seedSocialAccount({ id: "a2", userId: "bob", status: "token_expired" }); await h.seedSocialAccount({ id: "a3", userId: "eve", status: "connected" });
    const expiredAccount = await h.repo.getSocialAccount("a2");
    assert.deepEqual(expiredAccount && { id: expiredAccount.id, userId: expiredAccount.userId, status: expiredAccount.status }, { id: "a2", userId: "bob", status: "token_expired" }); assert.equal(await h.repo.getSocialAccount("nope"), null);
    assert.deepEqual(ids(await h.repo.listSocialAccountsForOwner("bob")), ["a1", "a2"]);
  });

  t("editing templates: stored per owner, newest first, JSON settings round-trip, and the plan limit is enforced atomically", async (h) => {
    const tpl = (id: string, ownerId: string, minutes: number) => ({ id, ownerId, name: `T ${id}`, settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 1.5, logo: { mediaId: "logo1", widthFraction: 0.2, centerX: 0.8, centerY: 0.1, opacity: 1 } }, createdAt: new Date(T0.getTime() + minutes * 60_000) });
    assert.equal(await h.repo.createTemplateIfWithinLimit(tpl("a", "bob", 1), 2), true); assert.equal(await h.repo.createTemplateIfWithinLimit(tpl("b", "bob", 2), 2), true);
    assert.equal(await h.repo.createTemplateIfWithinLimit(tpl("c", "bob", 3), 2), false);                       // at the limit: refused, nothing stored
    assert.equal(await h.repo.createTemplateIfWithinLimit(tpl("d", "eve", 4), 2), true);                        // other owners are separate
    const mine = await h.repo.listTemplatesForOwner("bob"); assert.deepEqual(mine.map((x) => x.id), ["b", "a"]);
    assert.deepEqual(mine[0]!.settings, tpl("b", "bob", 2).settings); assert.equal(mine[0]!.name, "T b");
    assert.deepEqual(await h.repo.listTemplatesForOwner("nobody"), []);
  });

  t("editing templates RACE: simultaneous saves beyond the limit - only the allowed number succeed", async (h) => {
    const tpl = (n: number) => ({ id: `r${n}`, ownerId: "bob", name: `R${n}`, settings: DEFAULT_EDITING_SETTINGS, createdAt: new Date(T0.getTime() + n * 1000) });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => h.repo.createTemplateIfWithinLimit(tpl(n), 3)));
    assert.equal(results.filter(Boolean).length, 3); assert.equal((await h.repo.listTemplatesForOwner("bob")).length, 3);
  });

  t("collections can be created, renamed, reordered, and a duplicate or missing file writes nothing", async (h) => {
    await h.seedMedia(media("m1", "owner")); await h.seedMedia(media("m2", "owner"));
    assert.equal(await h.repo.createCollection(collection("c-new", "owner", ["m2", "m1"], { name: "Named", description: "D" })), true);
    assert.deepEqual((await h.repo.getCollection("c-new"))?.mediaIds, ["m2", "m1"]);
    assert.equal(await h.repo.createCollection(collection("c-new", "owner", [])), false);
    assert.equal((await h.repo.listCollectionsForOwner("owner")).filter((c) => c.id === "c-new").length, 1);
    assert.equal(await h.repo.createCollection(collection("c-dup-media", "owner", ["m1", "m1"])), false);
    assert.equal(await h.repo.getCollection("c-dup-media"), null);
    assert.equal(await h.repo.createCollection(collection("c-missing-media", "owner", ["no-such-file"])), false);
    assert.equal(await h.repo.updateCollection("c-new", { name: "Renamed", description: null, visibility: "link", archived: false }), true);
    const updated = await h.repo.getCollection("c-new");
    assert.equal(updated?.name, "Renamed"); assert.equal(updated?.description, undefined); assert.equal(updated?.visibility, "link"); assert.equal(updated?.archived, false);
    assert.deepEqual(updated?.mediaIds, ["m2", "m1"]);
    assert.equal(await h.repo.replaceCollectionMedia("c-new", ["m1", "m2"]), true);
    assert.deepEqual((await h.repo.getCollection("c-new"))?.mediaIds, ["m1", "m2"]);
    await h.seedMedia(media("m3", "owner"));
    assert.equal(await h.repo.addOwnedMediaToCollection({ collectionId: "c-new", mediaAssetId: "m3", ownerId: "owner", actorId: "owner", now: T0 }), "added");
    assert.equal(await h.repo.addOwnedMediaToCollection({ collectionId: "c-new", mediaAssetId: "m3", ownerId: "owner", actorId: "owner", now: T0 }), "existing");
    assert.deepEqual((await h.repo.getCollection("c-new"))?.mediaIds, ["m1", "m2", "m3"]);
    assert.equal(await h.repo.addOwnedMediaToCollection({ collectionId: "c-new", mediaAssetId: "m3", ownerId: "eve", actorId: "eve", now: T0 }), "not_found");
    assert.equal(await h.repo.replaceCollectionMedia("c-new", ["m1", "m2"]), true);
    assert.equal(await h.repo.replaceCollectionMedia("c-new", ["m1", "m1"]), false);
    assert.deepEqual((await h.repo.getCollection("c-new"))?.mediaIds, ["m1", "m2"]);
    assert.equal(await h.repo.replaceCollectionMedia("c-new", ["missing-media"]), false);
    assert.deepEqual((await h.repo.getCollection("c-new"))?.mediaIds, ["m1", "m2"]);
    assert.equal(await h.repo.replaceCollectionMedia("missing", []), false);
    assert.equal(await h.repo.replaceCollectionMedia("c-new", ["foreign-media"]), false);
    assert.equal(await h.repo.updateCollection("missing", { name: "x", description: null, visibility: "private", archived: false }), false);
    assert.equal(await h.repo.createCollection(collection("c-keep", "owner", ["m1"])), true);
    assert.equal(await h.repo.updateCollection("c-new", { name: "Renamed", description: null, visibility: "link", archived: true }), true);
    assert.equal(await h.repo.deleteCollection("c-new"), true);
    assert.equal(await h.repo.getCollection("c-new"), null);
    assert.equal((await h.repo.getMedia("m1"))?.id, "m1");
    assert.deepEqual((await h.repo.getCollection("c-keep"))?.mediaIds, ["m1"]);
    assert.equal(await h.repo.deleteCollection("missing"), false);
  });

  t("collection-only cycle creation derives items from authorized memberships and rejects standalone items atomically", async (h) => {
    await h.seedMedia(media("cycle-video", "owner"));
    await h.seedCollection(collection("cycle-source", "owner", ["cycle-video"]));
    const requestedCycle = cycle("collection-cycle", "owner");
    const derivedItem = item("collection-cycle-item", requestedCycle.id, { cycleOwnerId: "owner", mediaAssetId: "cycle-video", sourceCollectionId: "cycle-source" });
    assert.equal(await h.repo.createCycleWithCollectionItemsWithinLimit(requestedCycle, [derivedItem], 3, { "cycle-source": 1 }), true);
    assert.deepEqual((await h.repo.getCycleItems(requestedCycle.id)).map((entry) => [entry.mediaAssetId, entry.sourceCollectionId]), [["cycle-video", "cycle-source"]]);

    const directCycle = cycle("standalone-cycle", "owner");
    const standaloneItem = item("standalone-item", directCycle.id, { cycleOwnerId: "owner", mediaAssetId: "cycle-video", sourceCollectionId: null });
    assert.equal(await h.repo.createCycleWithCollectionItemsWithinLimit(directCycle, [standaloneItem], 3, {}), false);
    assert.equal(await h.repo.getCycle(directCycle.id), null);
    assert.deepEqual(await h.repo.getCycleItems(directCycle.id), []);
  });

  t("cycle item insertion requires a video membership in an authorized source collection", async (h) => {
    await h.seedCycle(cycle("guarded-cycle", "owner"));
    await h.seedMedia(media("guarded-video", "owner"));
    await h.seedCollection(collection("guarded-source", "owner", ["guarded-video"]));
    const valid = item("guarded-item", "guarded-cycle", { cycleOwnerId: "owner", mediaAssetId: "guarded-video", sourceCollectionId: "guarded-source", sourceKind: "owned" });
    assert.equal(await h.repo.addCycleItems([valid], { "guarded-source": 1 }), true);

    const unprovenanced = item("no-source-item", "guarded-cycle", { cycleOwnerId: "owner", mediaAssetId: "guarded-video", sourceCollectionId: null });
    assert.equal(await h.repo.addCycleItems([unprovenanced]), false);
    await h.seedMedia(media("guarded-video-2", "owner"));
    assert.equal(await h.repo.replaceCollectionMedia("guarded-source", ["guarded-video", "guarded-video-2"]), true);
    const wrongSourceKind = item("wrong-source-kind", "guarded-cycle", { cycleOwnerId: "owner", mediaAssetId: "guarded-video-2", sourceCollectionId: "guarded-source", sourceKind: "shared_reference" });
    assert.equal(await h.repo.addCycleItems([wrongSourceKind], { "guarded-source": 1 }), false);
    const scheduledAtCreation = item("pre-scheduled-item", "guarded-cycle", { cycleOwnerId: "owner", mediaAssetId: "guarded-video", sourceCollectionId: "guarded-source", sourceKind: "owned", status: "scheduled", scheduledFor: T0 });
    assert.equal(await h.repo.createCycleWithCollectionItemsWithinLimit(cycle("scheduled-at-create", "owner"), [scheduledAtCreation], 3, { "guarded-source": 1 }), false);
    assert.equal(await h.repo.createCycleWithCollectionItemsWithinLimit(cycle("reviewed-at-create", "owner", { finalReviewConfirmed: true }), [
      item("reviewed-item", "reviewed-at-create", { cycleOwnerId: "owner", mediaAssetId: "guarded-video", sourceCollectionId: "guarded-source", sourceKind: "owned" }),
    ], 3, { "guarded-source": 1 }), false);
  });

  t("collection upload is atomic with membership and verification job; invalid collection and quota leave no records", async (h) => {
    await h.seedCollection(collection("upload-target", "owner", []));
    const uploaded = media("uploaded-video", "owner", { validation: "incomplete" });
    const job: MediaVerificationJobRecord = {
      id: "verify-uploaded-video", ownerId: "owner", mediaAssetId: uploaded.id, status: "queued", progressPercent: 0,
      attempts: 0, idempotencyKey: `media-verification:${uploaded.id}`, lockedBy: null, lockToken: null, lockExpiresAt: null,
      errorMessage: null, createdAt: T0, finishedAt: null, payload: { stage: "queued" },
    };
    const audit = { actorId: "owner", action: "media.uploaded", entityType: "MediaAsset", entityId: uploaded.id };
    const keys = { storageKey: "private/owner/uploaded-video", thumbnailKey: null };
    assert.equal(await h.repo.addMediaWithVerificationJobIfStorageWithin(uploaded, keys, job, audit, 1000, "upload-target"), true);
    assert.deepEqual((await h.repo.getCollection("upload-target"))?.mediaIds, [uploaded.id]);
    assert.deepEqual(await h.repo.getMediaStorageInfo(uploaded.id), { ...keys, mimeType: "video/mp4" });
    assert.equal((await h.repo.getMediaVerificationForOwner("owner", uploaded.id))?.status, "processing");
    assert.equal(await h.repo.addMediaWithVerificationJobIfStorageWithin(uploaded, keys, { ...job, id: "duplicate-job" }, audit, 1000, "upload-target"), false);

    const unavailable = media("unavailable-upload", "owner", { validation: "incomplete" });
    const unavailableJob = { ...job, id: "unavailable-job", mediaAssetId: unavailable.id, idempotencyKey: `media-verification:${unavailable.id}` };
    assert.equal(await h.repo.addMediaWithVerificationJobIfStorageWithin(unavailable, { storageKey: "private/owner/unavailable", thumbnailKey: null }, unavailableJob, { ...audit, entityId: unavailable.id }, 1000, "missing-collection"), "collection_unavailable");
    assert.equal(await h.repo.getMedia(unavailable.id), null);
    assert.equal(await h.repo.getMediaVerificationForOwner("owner", unavailable.id), null);

    const overQuota = media("over-quota-upload", "owner", { validation: "incomplete", sizeBytes: 1001 });
    const quotaJob = { ...job, id: "quota-job", mediaAssetId: overQuota.id, idempotencyKey: `media-verification:${overQuota.id}` };
    assert.equal(await h.repo.addMediaWithVerificationJobIfStorageWithin(overQuota, { storageKey: "private/owner/over-quota", thumbnailKey: null }, quotaJob, { ...audit, entityId: overQuota.id }, 1000), false);
    assert.equal(await h.repo.getMedia(overQuota.id), null);
  });

  t("membership add/remove preserves the media, storage reference, grants, and other collection memberships", async (h) => {
    await h.seedMedia(media("shared-video", "owner"), { storageKey: "private/owner/shared-video", thumbnailKey: "private/owner/shared-thumb" });
    await h.seedCollection(collection("first-collection", "owner", ["shared-video"]));
    await h.seedCollection(collection("second-collection", "owner", []));
    const existingGrant = grant("first-collection", "viewer", { capabilities: ["view"], grantedById: "owner" });
    await h.seedGrant(existingGrant);
    assert.equal(await h.repo.addOwnedMediaToCollection({ collectionId: "second-collection", mediaAssetId: "shared-video", ownerId: "owner", actorId: "owner", now: T0 }), "added");
    assert.equal(await h.repo.addOwnedMediaToCollection({ collectionId: "second-collection", mediaAssetId: "shared-video", ownerId: "owner", actorId: "owner", now: T0 }), "existing");
    assert.deepEqual((await h.repo.getCollection("second-collection"))?.mediaIds, ["shared-video"]);
    assert.equal(await h.repo.removeCollectionItem({ collectionId: "first-collection", mediaAssetId: "shared-video", actorId: "owner", now: T0 }), "removed");
    assert.equal(await h.repo.removeCollectionItem({ collectionId: "first-collection", mediaAssetId: "shared-video", actorId: "owner", now: T0 }), "already_absent");
    assert.equal((await h.repo.getMedia("shared-video"))?.id, "shared-video");
    assert.deepEqual(await h.repo.getMediaStorageInfo("shared-video"), { storageKey: "private/owner/shared-video", thumbnailKey: "private/owner/shared-thumb", mimeType: "video/mp4" });
    assert.deepEqual((await h.repo.getCollection("first-collection"))?.mediaIds, []);
    assert.deepEqual((await h.repo.getCollection("second-collection"))?.mediaIds, ["shared-video"]);
    assert.deepEqual(await h.repo.getGrants("first-collection"), [existingGrant]);
  });

  t("active cycle references block collection membership removal/deletion while published history is preserved", async (h) => {
    await h.seedMedia(media("active-video", "owner"));
    await h.seedCollection(collection("active-source", "owner", ["active-video"]));
    await h.seedCycle(cycle("active-cycle", "owner", { status: "running" }));
    await h.seedItems([item("active-cycle-item", "active-cycle", { cycleOwnerId: "owner", mediaAssetId: "active-video", sourceCollectionId: "active-source", status: "scheduled" })]);
    assert.equal(await h.repo.removeCollectionItem({ collectionId: "active-source", mediaAssetId: "active-video", actorId: "owner", now: T0 }), "conflict");
    assert.equal(await h.repo.replaceCollectionMedia("active-source", []), false);
    assert.equal(await h.repo.deleteCollection("active-source"), false);
    assert.deepEqual((await h.repo.getCollection("active-source"))?.mediaIds, ["active-video"]);

    await h.seedMedia(media("historical-video", "owner"));
    await h.seedCollection(collection("historical-source", "owner", ["historical-video"]));
    await h.seedCycle(cycle("historical-cycle", "owner", { status: "completed" }));
    await h.seedItems([item("published-history", "historical-cycle", { cycleOwnerId: "owner", mediaAssetId: "historical-video", sourceCollectionId: "historical-source", status: "published" })]);
    assert.equal(await h.repo.deleteCollection("historical-source"), true);
    assert.deepEqual((await h.repo.getCycleItems("historical-cycle")).map((entry) => [entry.id, entry.sourceCollectionId, entry.mediaAssetId]), [["published-history", "historical-source", "historical-video"]]);
    assert.equal((await h.repo.getMedia("historical-video"))?.id, "historical-video");
  });

  t("audit and caption revisions are appended", async (h) => {
    await h.repo.appendAudit({ actorId: "bob", action: "x.did", entityType: "T", entityId: "1", metadata: { n: 1 } }); await h.repo.appendAudit({ actorId: null, action: "y.did", entityType: "T", entityId: "2" });
    assert.deepEqual((await h.auditActions()).sort(), ["x.did", "y.did"]);
    await h.repo.saveCaptionRevisions([]); await h.repo.saveCaptionRevisions([{ itemId: "i1", previousText: "a", newText: "b", source: "bulk", changedBy: "bob", changedAt: T0 }]);
    assert.equal(await h.revisionCount(), 1);
  });
}
