import { test } from "node:test";
import assert from "node:assert/strict";
import { removeCollectionItem } from "../src/server/handlers/collections.ts";
import { jsonRoute } from "../src/server/http.ts";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { makeMedia } from "./helpers.ts";
import { getCollectionDetail } from "../src/server/queries.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CollectionDetailView } from "../src/components/CollectionViews.tsx";
import { CollectionVideoRemoveAction, collectionRemovalUiReducer, type CollectionRemovalUiState } from "../src/components/CollectionVideoRemoveAction.tsx";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";

const NOW = new Date("2026-11-16T08:00:00Z");
function context(repo: MemoryRepository, userId: string, storage?: MemoryMediaStorage): RequestContext {
  return { userId, now: NOW, repo, newId: () => "unused", config: { coverSupport: "unknown" }, ...(storage ? { media: { storage, probe: null, maxUploadBytes: 10_000 } } : {}) };
}

async function fixture() {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "media-a", ownerId: "owner", title: "Launch reel.mp4" }), { storageKey: "media/private-a", thumbnailKey: "thumb/private-a" }, 10_000);
  repo.storageKeys.set("media-a", "media/private-a");
  repo.thumbnailKeys.set("media-a", "thumb/private-a");
  await repo.createCollection({ id: "collection-a", ownerId: "owner", name: "Launch set", visibility: "private", archived: false, mediaIds: ["media-a"], items: [{ mediaAssetId: "media-a", captionText: "Caption stays", coverMediaId: null, version: 1 }] });
  await repo.createCollection({ id: "collection-b", ownerId: "owner", name: "Another set", visibility: "private", archived: false, mediaIds: ["media-a"] });
  await repo.upsertGrant({ collectionId: "collection-a", granteeId: "manager", capabilities: ["manage"], status: "active", expiresAt: null, grantedById: "owner" });
  await repo.upsertGrant({ collectionId: "collection-a", granteeId: "viewer", capabilities: ["view", "download"], status: "active", expiresAt: null, grantedById: "owner" });
  return repo;
}

test("remove from collection deletes only its membership and preserves media, storage, derivatives, other memberships and grants", async () => {
  const repo = await fixture();
  const storage = new MemoryMediaStorage();
  storage.objects.set("media/private-a", new Uint8Array([1, 2, 3]));
  storage.objects.set("thumb/private-a", new Uint8Array([4, 5]));
  assert.deepEqual(await removeCollectionItem(context(repo, "owner", storage), { collectionId: "collection-a", mediaAssetId: "media-a" }), { collectionId: "collection-a", mediaAssetId: "media-a", status: "removed" });
  assert.deepEqual((await repo.getCollection("collection-a"))?.mediaIds, []);
  assert.deepEqual((await repo.getCollection("collection-b"))?.mediaIds, ["media-a"]);
  assert.equal((await repo.getMedia("media-a"))?.status, "active");
  assert.deepEqual([repo.storageKeys.get("media-a"), repo.thumbnailKeys.get("media-a")], ["media/private-a", "thumb/private-a"]);
  assert.equal(await storage.exists("media/private-a"), true);
  assert.equal(await storage.exists("thumb/private-a"), true);
  assert.deepEqual(await repo.getGrants("collection-a"), [
    { collectionId: "collection-a", granteeId: "manager", capabilities: ["manage"], status: "active", expiresAt: null, grantedById: "owner" },
    { collectionId: "collection-a", granteeId: "viewer", capabilities: ["view", "download"], status: "active", expiresAt: null, grantedById: "owner" },
  ]);
  assert.equal(repo.audit.filter((entry) => entry.action === "collection.item_removed").length, 1);
});

test("explicit delegated manage capability can remove, view-only and public viewers cannot", async () => {
  const repo = await fixture();
  const detail = await getCollectionDetail(context(repo, "manager"), "collection-a");
  assert.equal(detail.permissions.canManage, true);
  const html = renderToStaticMarkup(CollectionDetailView({ detail }));
  assert.match(html, /Remove from collection/);
  const viewerDetail = await getCollectionDetail(context(repo, "viewer"), "collection-a");
  assert.equal(viewerDetail.permissions.canManage, false);
  assert.doesNotMatch(renderToStaticMarkup(CollectionDetailView({ detail: viewerDetail })), /Remove from collection/);
  await assert.rejects(() => removeCollectionItem(context(repo, "viewer"), { collectionId: "collection-a", mediaAssetId: "media-a" }), (error: unknown) => error instanceof AppError && error.status === 403);
  await assert.rejects(() => removeCollectionItem(context(repo, "outsider"), { collectionId: "collection-a", mediaAssetId: "media-a" }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.deepEqual((await repo.getCollection("collection-a"))?.mediaIds, ["media-a"]);
  assert.deepEqual((await repo.getCollection("collection-b"))?.mediaIds, ["media-a"]);
});

test("removal UI requires confirmation and exposes loading, success and recoverable error states", () => {
  const initial: CollectionRemovalUiState = { status: "idle" };
  const confirming = collectionRemovalUiReducer(initial, { type: "confirm" });
  assert.equal(confirming.status, "confirming");
  assert.equal(collectionRemovalUiReducer(confirming, { type: "start" }).status, "loading");
  assert.equal(collectionRemovalUiReducer({ status: "loading" }, { type: "success" }).status, "success");
  const failed = collectionRemovalUiReducer({ status: "loading" }, { type: "failure", message: "Permission was revoked." });
  assert.deepEqual(failed, { status: "error", message: "Permission was revoked." });
  assert.equal(collectionRemovalUiReducer(failed, { type: "cancel" }).status, "idle");
  const html = renderToStaticMarkup(createElement(CollectionVideoRemoveAction, { collectionId: "collection-a", collectionName: "Launch set", mediaAssetId: "media-a", mediaTitle: "Launch reel.mp4" }));
  assert.match(html, /Remove from collection/);
  assert.doesNotMatch(html, /Delete media/);
});

test("removal is idempotent, validates identifiers, and rejects while an association import is active", async () => {
  const repo = await fixture();
  const owner = context(repo, "owner");
  const input = { collectionId: "collection-a", mediaAssetId: "media-a" };
  assert.equal((await removeCollectionItem(owner, input)).status, "removed");
  assert.equal((await removeCollectionItem(owner, input)).status, "already_absent");
  assert.equal(repo.audit.filter((entry) => entry.action === "collection.item_removed").length, 1);
  await assert.rejects(() => removeCollectionItem(owner, { ...input, mediaAssetId: "bad/id" }), (error: unknown) => error instanceof AppError && error.status === 422);

  const other = await fixture();
  other.mediaImportJobs.set("job-a", { id: "job-a", importerId: "recipient", sourceMediaId: "media-a", sourceCollectionId: "collection-a", status: "copying" } as never);
  await assert.rejects(() => removeCollectionItem(context(other, "owner"), input), (error: unknown) => error instanceof AppError && error.status === 409);
  assert.deepEqual((await other.getCollection("collection-a"))?.mediaIds, ["media-a"]);
});

test("concurrent duplicate removals serialize into one removal and one idempotent success", async () => {
  const repo = await fixture();
  const input = { collectionId: "collection-a", mediaAssetId: "media-a" };
  const results = await Promise.all([
    removeCollectionItem(context(repo, "owner"), input),
    removeCollectionItem(context(repo, "owner"), input),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["already_absent", "removed"]);
  assert.equal(repo.audit.filter((entry) => entry.action === "collection.item_removed").length, 1);
  assert.equal((await repo.getMedia("media-a"))?.status, "active");
});

test("JSON removal endpoint enforces session authorization and reports idempotent completion", async () => {
  const repo = await fixture();
  const makeRoute = (userId: string | null) => jsonRoute(removeCollectionItem, () => ({ mode: "demo", repo, currentUserId: async () => userId, newId: () => "unused", now: () => NOW }));
  const request = () => new Request("http://localhost/api/collections/remove-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collectionId: "collection-a", mediaAssetId: "media-a" }) });
  const unauthenticated = await makeRoute(null)(request());
  assert.equal(unauthenticated.status, 401);
  const viewer = await makeRoute("viewer")(request());
  assert.equal(viewer.status, 403);
  const ownerRoute = makeRoute("owner");
  const removed = await ownerRoute(request());
  assert.equal(removed.status, 200);
  assert.equal((await removed.json() as { status: string }).status, "removed");
  const replay = await ownerRoute(request());
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { status: string }).status, "already_absent");
});

test("concurrent remove and owner deletion scheduling preserve the media record and private objects", async () => {
  const repo = await fixture();
  const [removed, deletion] = await Promise.all([
    removeCollectionItem(context(repo, "owner"), { collectionId: "collection-a", mediaAssetId: "media-a" }),
    repo.scheduleMediaDeletion({ mediaId: "media-a", ownerId: "owner", now: NOW, graceDays: 7 }),
  ]);
  assert.ok(removed.status === "removed" || removed.status === "already_absent");
  assert.ok(deletion === "scheduled" || deletion === "already_pending");
  const media = await repo.getMedia("media-a");
  assert.equal(media?.status, "pending_deletion");
  assert.deepEqual([repo.storageKeys.get("media-a"), repo.thumbnailKeys.get("media-a")], ["media/private-a", "thumb/private-a"]);
  assert.deepEqual((await repo.getCollection("collection-b"))?.mediaIds, ["media-a"]);
});
