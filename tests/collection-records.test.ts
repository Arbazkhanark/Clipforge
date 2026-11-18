import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollection, deleteCollection, replaceCollectionMedia, setCollectionArchived, updateCollection, updateCollectionItemSettings, updateCollectionSharedSettings } from "../src/server/handlers/collections.ts";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { makeMedia } from "./helpers.ts";
import { getCollectionDetail, getCollectionsOverview } from "../src/server/queries.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionDetailView } from "../src/components/CollectionViews.tsx";
import { DEFAULT_EDITING_SETTINGS } from "../src/lib/domain/editing-settings.ts";
import { toRenderSettings } from "../src/lib/domain/editing-settings.ts";
import { hashExportSettings } from "../src/lib/render/render-limits.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";

function context(repo: MemoryRepository, userId: string): RequestContext {
  let n = 0;
  return { userId, now: new Date("2026-11-06T12:00:00Z"), repo, newId: () => `col-${++n}`, config: { coverSupport: "unknown" } };
}

test("collection writes use the signed-in user and hide someone else's collection", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "mine", ownerId: "ann", title: "Mine" }), { storageKey: "k/mine", thumbnailKey: null }, 1000);
  await repo.addMediaIfStorageWithin(makeMedia({ id: "theirs", ownerId: "bob", title: "Theirs" }), { storageKey: "k/theirs", thumbnailKey: null }, 1000);
  const ann = context(repo, "ann");
  const created = await createCollection(ann, { name: "Campaign", description: "Notes", visibility: "private", mediaIds: ["mine"] });
  assert.equal(created.collectionId, "col-1");
  assert.equal((await repo.getCollection("col-1"))?.ownerId, "ann");
  assert.deepEqual([(await repo.getCollection("col-1"))?.captionMode, (await repo.getCollection("col-1"))?.coverMode, (await repo.getCollection("col-1"))?.items?.[0]?.captionText, (await repo.getCollection("col-1"))?.items?.[0]?.coverMediaId], ["individual", "individual", "", null]);
  await assert.rejects(() => createCollection(ann, { name: "Nope", visibility: "private", mediaIds: ["theirs"] }), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => updateCollection(context(repo, "bob"), { collectionId: "col-1", name: "Stolen", visibility: "public_view", archived: false }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.equal((await repo.getCollection("col-1"))?.name, "Campaign");
  await updateCollection(ann, { collectionId: "col-1", name: "Renamed", description: "", visibility: "link", archived: true });
  const renamed = await repo.getCollection("col-1");
  assert.equal(renamed?.name, "Renamed");
  assert.equal(renamed?.archived, false);
  assert.equal(renamed?.visibility, "link");
  await assert.rejects(() => setCollectionArchived(ann, { collectionId: "col-1", archived: true, confirm: false }), (error: unknown) => error instanceof AppError && error.status === 422);
  assert.equal((await repo.getCollection("col-1"))?.archived, false);
  await setCollectionArchived(ann, { collectionId: "col-1", archived: true, confirm: true });
  assert.equal((await repo.getCollection("col-1"))?.archived, true);
  await replaceCollectionMedia(ann, { collectionId: "col-1", mediaIds: [] });
  assert.deepEqual((await repo.getCollection("col-1"))?.mediaIds, []);
  assert.equal((await repo.getMedia("mine"))?.title, "Mine");
  await assert.rejects(() => replaceCollectionMedia(ann, { collectionId: "col-1", mediaIds: ["mine", "mine"] }), (error: unknown) => error instanceof AppError && error.status === 422);
  assert.deepEqual((await repo.getCollection("col-1"))?.mediaIds, []);
  const second = await createCollection(ann, { name: "Other", visibility: "private", mediaIds: ["mine"] });
  await replaceCollectionMedia(ann, { collectionId: "col-1", mediaIds: ["mine"] });
  await assert.rejects(() => deleteCollection(context(repo, "bob"), { collectionId: "col-1", confirm: true }), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => deleteCollection(ann, { collectionId: "col-1", confirm: false }), (error: unknown) => error instanceof AppError && error.status === 422);
  await deleteCollection(ann, { collectionId: "col-1", confirm: true });
  assert.equal(await repo.getCollection("col-1"), null);
  assert.deepEqual((await repo.getCollection(second.collectionId))?.mediaIds, ["mine"]);
  assert.equal((await repo.getMedia("mine"))?.status, "active");
});

test("collection item captions and covers remain independent while shared defaults are applied and switched", async () => {
  const repo = new MemoryRepository();
  for (const [id, kind] of [["video-a", "video"], ["video-b", "video"], ["cover-a", "image"], ["cover-b", "image"]] as const) {
    await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId: "ann", kind }), { storageKey: `k/${id}`, thumbnailKey: null }, 10_000);
  }
  const ann = context(repo, "ann");
  const created = await createCollection(ann, { name: "Launch", visibility: "private", mediaIds: ["video-a", "video-b"], itemSettings: [
    { mediaAssetId: "video-a", captionText: "Caption A", coverMediaId: "cover-a" },
    { mediaAssetId: "video-b", captionText: "Caption B", coverMediaId: "cover-b" },
  ] });
  const initial = await repo.getCollection(created.collectionId);
  assert.deepEqual(initial?.items?.map((item) => [item.mediaAssetId, item.captionText, item.coverMediaId]), [["video-a", "Caption A", "cover-a"], ["video-b", "Caption B", "cover-b"]]);

  await assert.rejects(() => updateCollectionSharedSettings(ann, { collectionId: created.collectionId, expectedVersion: 1, captionMode: "shared", sharedCaptionText: "Same caption", coverMode: "shared", sharedCoverMediaId: "cover-a", confirmSharedSettings: false }), (error: unknown) => error instanceof AppError && error.status === 422);
  const sharedWrites = await Promise.allSettled([
    updateCollectionSharedSettings(ann, { collectionId: created.collectionId, expectedVersion: 1, captionMode: "shared", sharedCaptionText: "Same caption", coverMode: "shared", sharedCoverMediaId: "cover-a", confirmSharedSettings: true }),
    updateCollectionSharedSettings(ann, { collectionId: created.collectionId, expectedVersion: 1, captionMode: "shared", sharedCaptionText: "Racing caption", coverMode: "shared", sharedCoverMediaId: "cover-b", confirmSharedSettings: true }),
  ]);
  assert.equal(sharedWrites.filter((result) => result.status === "fulfilled").length, 1, "only one bulk write may win the collection version");
  assert.equal(sharedWrites.filter((result) => result.status === "rejected").length, 1);
  const bulk = sharedWrites.find((result): result is PromiseFulfilledResult<{ collectionId: string; affected: number }> => result.status === "fulfilled")!.value;
  assert.equal(bulk.affected, 2);
  const shared = await repo.getCollection(created.collectionId);
  assert.equal(shared?.captionMode, "shared"); assert.ok(["Same caption", "Racing caption"].includes(shared?.sharedCaptionText ?? ""));
  assert.equal(shared?.coverMode, "shared"); assert.ok(["cover-a", "cover-b"].includes(shared?.sharedCoverMediaId ?? ""));
  assert.deepEqual(shared?.items?.map((item) => [item.captionText, item.coverMediaId]), [["Caption A", "cover-a"], ["Caption B", "cover-b"]], "shared defaults must not overwrite individual values");

  const savedSharedCaption = shared?.sharedCaptionText;
  const savedSharedCover = shared?.sharedCoverMediaId;
  await updateCollectionSharedSettings(ann, { collectionId: created.collectionId, expectedVersion: 2, captionMode: "individual", sharedCaptionText: "unconfirmed dormant change", coverMode: "individual", sharedCoverMediaId: "unselected-cover", confirmSharedSettings: false });
  const individual = await repo.getCollection(created.collectionId);
  assert.equal(individual?.captionMode, "individual"); assert.equal(individual?.coverMode, "individual");
  assert.equal(individual?.sharedCaptionText, savedSharedCaption); assert.equal(individual?.sharedCoverMediaId, savedSharedCover, "inactive values are preserved without accepting unconfirmed hidden-field changes");
  assert.deepEqual(individual?.items?.map((item) => [item.captionText, item.coverMediaId]), [["Caption A", "cover-a"], ["Caption B", "cover-b"]]);
  assert.ok(repo.audit.some((entry) => entry.action === "collection.shared_settings_applied" && (entry.metadata as Record<string, unknown>)?.["affected"] === 2));
});

test("collection settings validate image ownership and reject stale concurrent item updates", async () => {
  const repo = new MemoryRepository();
  for (const [id, ownerId, kind] of [["video", "ann", "video"], ["owned-image", "ann", "image"], ["other-image", "bob", "image"]] as const) await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId, kind }), { storageKey: `k/${id}`, thumbnailKey: null }, 10_000);
  const ann = context(repo, "ann");
  const { collectionId } = await createCollection(ann, { name: "One", visibility: "private", mediaIds: ["video"] });
  await assert.rejects(() => updateCollectionItemSettings(ann, { collectionId, mediaAssetId: "video", captionText: "No", coverMediaId: "other-image", expectedVersion: 1 }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => updateCollectionItemSettings(ann, { collectionId, mediaAssetId: "video", captionText: "No", coverMediaId: "video", expectedVersion: 1 }), (error: unknown) => error instanceof AppError && error.status === 422);
  const concurrent = await Promise.allSettled([
    updateCollectionItemSettings(ann, { collectionId, mediaAssetId: "video", captionText: "First", coverMediaId: "owned-image", expectedVersion: 1 }),
    updateCollectionItemSettings(ann, { collectionId, mediaAssetId: "video", captionText: "Second", coverMediaId: "owned-image", expectedVersion: 1 }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof AppError && result.reason.status === 409).length, 1);
  assert.ok(["First", "Second"].includes((await repo.getCollection(collectionId))?.items?.[0]?.captionText ?? ""));
  assert.deepEqual((await repo.getCollection(collectionId))?.items?.map((item) => [item.coverMediaId, item.version]), [["owned-image", 2]]);
});

test("collection membership edits preserve retained item settings and default newly added videos", async () => {
  const repo = new MemoryRepository();
  for (const id of ["video-a", "video-b", "video-c", "cover"]) await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId: "ann", title: id === "video-a" ? "Original title" : id, kind: id === "cover" ? "image" : "video" }), { storageKey: `k/${id}`, thumbnailKey: null }, 10_000);
  const ann = context(repo, "ann");
  const { collectionId } = await createCollection(ann, { name: "Preserve settings", visibility: "private", mediaIds: ["video-a", "video-b"], itemSettings: [
    { mediaAssetId: "video-a", captionText: "Keep this", coverMediaId: "cover" },
    { mediaAssetId: "video-b", captionText: "Remove this", coverMediaId: null },
  ] });
  const beforeVersion = (await repo.getCollection(collectionId))?.settingsVersion;
  await replaceCollectionMedia(ann, { collectionId, mediaIds: ["video-a", "video-c"] });
  const updated = await repo.getCollection(collectionId);
  assert.deepEqual(updated?.items?.map((item) => [item.mediaAssetId, item.captionText, item.coverMediaId, item.version]), [
    ["video-a", "Keep this", "cover", 1],
    ["video-c", "", null, 1],
  ]);
  assert.equal(updated?.settingsVersion, (beforeVersion ?? 1) + 1);
  assert.equal((await repo.getMedia("video-a"))?.title, "Original title", "collection edits do not mutate original media metadata");
});

test("collection owner sees safe sharing-management data; a recipient does not receive the management DTO", async () => {
  const repo = new MemoryRepository();
  const owner = context(repo, "owner");
  await repo.createCollection({ id: "shared", ownerId: "owner", name: "Shared", visibility: "private", archived: false, mediaIds: [], createdAt: owner.now });
  await repo.upsertGrant({ collectionId: "shared", granteeId: "recipient", capabilities: ["view", "use_in_cycle"], status: "active", expiresAt: null, grantedById: "owner" });

  const ownerDetail = await getCollectionDetail(owner, "shared");
  assert.deepEqual(ownerDetail.sharingManagement?.grants, [{ granteeId: "recipient", capabilities: ["view", "use_in_cycle"], status: "active", expiresAt: null, grantedById: "owner" }]);
  assert.equal(ownerDetail.sharingManagement?.activeRecipients, 1);
  assert.equal(ownerDetail.sharingManagement?.recipientLimit, 0);
  assert.equal(ownerDetail.sharingManagement?.expiringGrants, false);
  const ownerHtml = renderToStaticMarkup(CollectionDetailView({ detail: ownerDetail }));
  assert.match(ownerHtml, /People with collection access/);
  assert.match(ownerHtml, /USER ID<\/span><code>recipient<\/code>/);
  assert.match(ownerHtml, /Your current plan does not include collection sharing/);
  assert.match(ownerHtml, /Revoke access/);

  const recipientDetail = await getCollectionDetail(context(repo, "recipient"), "shared");
  assert.equal(recipientDetail.sharingManagement, undefined);
  assert.equal(JSON.stringify(recipientDetail).includes("sharingManagement"), false);
  assert.equal(JSON.stringify(recipientDetail).includes("granteeId"), false);
  assert.equal(renderToStaticMarkup(CollectionDetailView({ detail: recipientDetail })).includes("People with collection access"), false);
});

test("collection owner gets a bulk template action preselecting every collection video; viewers do not", async () => {
  const repo = new MemoryRepository();
  const owner = context(repo, "owner");
  for (const id of ["video-one", "video-two"]) {
    await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId: "owner", kind: "video", title: id }), { storageKey: `private/${id}`, thumbnailKey: null }, 10_000);
  }
  await repo.createCollection({ id: "template-collection", ownerId: "owner", name: "Campaign", visibility: "public_view", archived: false, mediaIds: ["video-one", "video-two"], createdAt: owner.now });
  const ownerHtml = renderToStaticMarkup(CollectionDetailView({ detail: await getCollectionDetail(owner, "template-collection") }));
  assert.match(ownerHtml, /Apply template to all videos/);
  assert.match(ownerHtml, /href="\/editor\/bulk\?media=video-one&amp;media=video-two"/);
  const viewerHtml = renderToStaticMarkup(CollectionDetailView({ detail: await getCollectionDetail(context(repo, "viewer"), "template-collection") }));
  assert.doesNotMatch(viewerHtml, /Apply template to all videos/);
});

test("collection videos play the exact completed edited export and show their template label", async () => {
  const repo = new MemoryRepository();
  const owner = context(repo, "owner");
  for (const id of ["edited", "custom"]) {
    await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId: "owner", kind: "video", title: `${id}.mp4`, durationMs: 12_000, hasThumbnail: true }), { storageKey: `private/${id}`, thumbnailKey: `private/${id}-thumb` }, 20_000);
  }
  await repo.createCollection({ id: "preview-collection", ownerId: "owner", name: "Previews", visibility: "public_view", archived: false, mediaIds: ["edited", "custom"], createdAt: owner.now });

  const settings = { ...DEFAULT_EDITING_SETTINGS, aspect: "1:1" as const };
  await repo.saveVideoSettings({ id: "video-settings-edited", ownerId: "owner", name: "v:edited", settings, createdAt: owner.now });
  await repo.saveVideoSettings({ id: "video-settings-custom", ownerId: "owner", name: "v:custom", settings: { ...settings, zoom: 1.2 }, createdAt: owner.now });
  await repo.createTemplateIfWithinLimit({ id: "template-portrait", ownerId: "owner", name: "Portrait look", settings, createdAt: owner.now }, 5);
  const settingsHash = hashExportSettings("edited", toRenderSettings(settings, getPlan("free").features.maxResolution), null, null);
  await repo.saveRenderOutput({ id: "edited-output", sourceMediaId: "edited", ownerId: "owner", storageKey: "private/edited-export", sizeBytes: 4, settingsHash, createdAt: owner.now }, 20_000);

  const ownerHtml = renderToStaticMarkup(CollectionDetailView({ detail: await getCollectionDetail(owner, "preview-collection") }));
  assert.match(ownerHtml, /src="\/api\/renders\/preview\?id=edited-output"/);
  assert.match(ownerHtml, /Template: Portrait look/);
  assert.match(ownerHtml, /Edited export/);
  assert.match(ownerHtml, /Custom settings/);
  assert.match(ownerHtml, /Original · no matching export yet/);
  assert.match(ownerHtml, /src="\/api\/media\/file\?id=custom&amp;variant=preview"/);

  const viewerHtml = renderToStaticMarkup(CollectionDetailView({ detail: await getCollectionDetail(context(repo, "viewer"), "preview-collection") }));
  assert.match(viewerHtml, /Template details unavailable/);
  assert.doesNotMatch(viewerHtml, /Portrait look|edited-output|\/api\/renders\/preview/);
  assert.match(viewerHtml, /Playback is not included in this collection’s permissions/);
});

test("access-request views are owner/requester scoped and do not reveal private collection details", async () => {
  const repo = new MemoryRepository();
  const now = new Date("2026-11-06T12:00:00Z");
  await repo.createCollection({ id: "private-access-target", ownerId: "owner", name: "Confidential collection name", description: "Private notes", visibility: "private", archived: false, mediaIds: [], createdAt: now });
  await repo.createCollectionAccessRequest({ id: "access-request", collectionId: "private-access-target", requesterId: "recipient", requestedCapabilities: ["view"], now });

  const requesterOverview = await getCollectionsOverview(context(repo, "recipient"));
  assert.equal(requesterOverview.accessRequests.length, 1);
  const safeRequestJson = JSON.stringify(requesterOverview.accessRequests);
  assert.ok(safeRequestJson.includes("private-access-target"));
  assert.ok(!safeRequestJson.includes("Confidential collection name"));
  assert.ok(!safeRequestJson.includes("Private notes"));
  assert.deepEqual(requesterOverview.owned, []);
  assert.deepEqual(requesterOverview.sharedWithMe, []);

  const ownerDetail = await getCollectionDetail(context(repo, "owner"), "private-access-target");
  assert.equal(ownerDetail.pendingAccessRequests?.length, 1);
  assert.equal(ownerDetail.pendingAccessRequests?.[0]?.requesterId, "recipient");
  await assert.rejects(() => getCollectionDetail(context(repo, "stranger"), "private-access-target"), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.deepEqual(await repo.listPendingCollectionAccessRequests("private-access-target", "stranger"), []);
  assert.equal((await repo.listCollectionAccessRequestsForRequester("stranger")).length, 0);
});

test("collection videos render as responsive cards while retaining the authorized import form", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(
    makeMedia({ id: "shared-video", ownerId: "owner", title: "Campaign reel" }),
    { storageKey: "private/shared-video", thumbnailKey: null },
    10_000,
  );
  await repo.createCollection({
    id: "shared-collection",
    ownerId: "owner",
    name: "Campaign",
    description: undefined,
    visibility: "private",
    archived: false,
    mediaIds: ["shared-video"],
    createdAt: new Date("2026-11-06T12:00:00Z"),
  });
  await repo.upsertGrant({
    collectionId: "shared-collection",
    granteeId: "recipient",
    capabilities: ["view", "import_copy"],
    status: "active",
    expiresAt: null,
    grantedById: "owner",
  });

  const detail = await getCollectionDetail(context(repo, "recipient"), "shared-collection");
  const html = renderToStaticMarkup(CollectionDetailView({ detail }));

  assert.match(html, /collection-video-grid/);
  assert.match(html, /collection-video-card/);
  assert.match(html, /Campaign reel/);
  assert.match(html, /action="\/api\/forms\/media-import"/);
  assert.match(html, /name="sourceMediaId" value="shared-video"/);
  assert.match(html, /name="warningAcknowledged"/);
});
