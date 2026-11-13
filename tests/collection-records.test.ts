import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollection, deleteCollection, replaceCollectionMedia, setCollectionArchived, updateCollection } from "../src/server/handlers/collections.ts";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { makeMedia } from "./helpers.ts";
import { getCollectionDetail, getCollectionsOverview } from "../src/server/queries.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { CollectionDetailView } from "../src/components/CollectionViews.tsx";

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
