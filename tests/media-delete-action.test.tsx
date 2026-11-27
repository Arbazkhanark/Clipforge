import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaTable } from "../src/components/MediaTable.tsx";
import { mediaDeleteUiReducer } from "../src/components/MediaDeleteAction.tsx";
import { GET, POST } from "../app/api/media/delete/route.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { setRuntimeForTests } from "../src/server/runtime.ts";
import { makeCollection, makeCycle, makeItem, makeMedia } from "./helpers.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { runNextMediaCleanupJob } from "../src/server/media-deletion/cleanup-worker.ts";
import type { CycleRecord, MediaImportJobRecord, RenderJobRecord } from "../src/server/repository.ts";

const NOW = new Date("2026-11-16T08:00:00.000Z");

function request(mediaId: string) {
  return new Request("http://localhost/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, confirm: true, expectedCollectionIds: ["collection-a"] }),
  });
}

function permanentRequest(mediaId: string, expectedCollectionIds: string[] = []) {
  return new Request("http://localhost/api/media/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, confirm: true, expectedCollectionIds }),
  });
}

async function addImage(repo: MemoryRepository, id: string) {
  assert.equal(await repo.addMediaIfStorageWithin(makeMedia({ id, ownerId: "owner", kind: "image" }), { storageKey: `private/owner/${id}`, thumbnailKey: null }, 100_000), true);
}

function addCycleRecord(repo: MemoryRepository, input: { id: string; status: "draft" | "running" | "paused" | "stopped" | "completed"; deletedAt: Date | null; name: string }) {
  const cycle: CycleRecord = { ...makeCycle({ id: input.id, ownerId: "owner", status: input.status, deletedAt: input.deletedAt }), name: input.name, socialAccountId: "synthetic-account", scheduleSettings: null };
  repo.cycles.set(cycle.id, cycle);
}

test("Media Library renders a separate Delete media action per active owned item and scheduled status for pending items", () => {
  const out = renderToStaticMarkup(<MediaTable library={{
    items: [
      { id: "active-video", title: "Launch reel.mp4", kind: "video", sizeBytes: 1024, durationMs: 1000, status: "active", validation: "verified", hasThumbnail: false, width: null, height: null },
      { id: "active-image", title: "Cover.png", kind: "image", sizeBytes: 512, durationMs: null, status: "active", validation: "verified", hasThumbnail: false, width: null, height: null },
      { id: "pending-media", title: "Pending.mp4", kind: "video", sizeBytes: 1024, durationMs: 1000, status: "pending_deletion", validation: "verified", hasThumbnail: false, width: null, height: null },
    ],
    total: 3, page: 1, pageCount: 1, pageSize: 24,
  }} />);

  assert.equal((out.match(/class="media-delete-trigger"/g) ?? []).length, 3);
  assert.match(out, /data-media-delete-id="active-video"/);
  assert.match(out, /data-media-delete-id="active-image"/);
  assert.match(out, /Delete permanently/);
  assert.match(out, /Already scheduled\. You can permanently delete it now\./);
  assert.match(out, /data-media-delete-id="pending-media"/);
});

test("delete confirmation UI reducer covers confirmation, loading, recoverable failure and scheduled success", () => {
  const previewing = mediaDeleteUiReducer({ status: "idle" }, { type: "begin_preview" });
  assert.equal(previewing.status, "preview_loading");
  const confirming = mediaDeleteUiReducer(previewing, { type: "preview_loaded" });
  assert.equal(confirming.status, "confirming");
  const loading = mediaDeleteUiReducer(confirming, { type: "start" });
  assert.equal(loading.status, "loading");
  const failed = mediaDeleteUiReducer(loading, { type: "failure", message: "Try again." });
  assert.deepEqual(failed, { status: "error", message: "Try again." });
  assert.equal(mediaDeleteUiReducer(failed, { type: "cancel" }).status, "idle");
  assert.deepEqual(mediaDeleteUiReducer(loading, { type: "queued", message: "Permanent cleanup queued." }), { status: "queued", message: "Permanent cleanup queued." });
});

test("GET preview identifies collections and permanent deletion unlinks only owner media, then worker deletes only its private objects", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "owner-media", ownerId: "owner", title: "Private video.mp4" }), { storageKey: "private/owner/video", thumbnailKey: "private/owner/thumb" }, 100_000);
  await repo.createCollection({ id: "collection-a", ownerId: "owner", name: "Campaign launch", visibility: "private", archived: false, mediaIds: ["owner-media"] });
  const storage = new MemoryMediaStorage();
  storage.objects.set("private/owner/video", new Uint8Array([1, 2, 3]));
  storage.objects.set("private/owner/thumb", new Uint8Array([4, 5]));
  let userId: string | null = null;
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => userId, newId: () => "unused", now: () => NOW });
  try {
    const unauthenticated = await POST(request("owner-media"));
    assert.equal(unauthenticated.status, 401);
    userId = "other";
    const otherUser = await POST(request("owner-media"));
    assert.equal(otherUser.status, 404);
    assert.equal((await repo.getMedia("owner-media"))?.status, "active");

    userId = "owner";
    const preview = await GET(new Request("http://localhost/api/media/delete?mediaId=owner-media"));
    assert.equal(preview.status, 200);
    assert.deepEqual((await preview.json() as { collections: { id: string; name: string }[] }).collections, [{ id: "collection-a", name: "Campaign launch" }]);
    const invalidatedPreview = await POST(new Request("http://localhost/api/media/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: "owner-media", confirm: true, expectedCollectionIds: [] }) }));
    assert.equal(invalidatedPreview.status, 409);
    assert.equal((await repo.getMedia("owner-media"))?.status, "active");

    const permanentRequest = new Request("http://localhost/api/media/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: "owner-media", confirm: true, expectedCollectionIds: ["collection-a"] }) });
    const response = await POST(permanentRequest);
    assert.equal(response.status, 200);
    const body = await response.json() as { mediaId: string; jobId: string; status: string; removedCollectionIds: string[] };
    assert.equal(body.mediaId, "owner-media");
    assert.equal(body.status, "queued");
    assert.deepEqual(body.removedCollectionIds, ["collection-a"]);
    assert.equal((await repo.getMedia("owner-media"))?.status, "deleted");
    assert.equal((await repo.getCollection("collection-a"))?.mediaIds.length, 0);
    assert.equal(repo.audit.filter((entry) => entry.action === "media.permanent_deletion_queued").length, 1);
    assert.equal(await storage.exists("private/owner/video"), true);

    assert.equal(await runNextMediaCleanupJob({ repo, storage, workerId: "cleanup-test", now: NOW }), "deleted");
    assert.equal(await storage.exists("private/owner/video"), false);
    assert.equal(await storage.exists("private/owner/thumb"), false);
    assert.equal((await repo.getMedia("owner-media"))?.status, "deleted");

    const replay = await POST(new Request("http://localhost/api/media/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaId: "owner-media", confirm: true, expectedCollectionIds: [] }) }));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { status: string }).status, "existing");
  } finally {
    setRuntimeForTests(null);
  }
});

test("permanent deletion refuses media still used by an active publishing cycle", async () => {
  const repo = new MemoryRepository();
  await repo.addMediaIfStorageWithin(makeMedia({ id: "in-use-media", ownerId: "owner", title: "Scheduled reel.mp4" }), { storageKey: "private/owner/in-use", thumbnailKey: null }, 100_000);
  repo.items.set("active-cycle-item", makeItem({ id: "active-cycle-item", cycleOwnerId: "owner", mediaAssetId: "in-use-media", status: "scheduled" }));
  let userId: string | null = "owner";
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => userId, newId: () => "unused", now: () => NOW });
  try {
    const response = await POST(new Request("http://localhost/api/media/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaId: "in-use-media", confirm: true, expectedCollectionIds: [] }),
    }));
    assert.equal(response.status, 409);
    assert.equal((await repo.getMedia("in-use-media"))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally {
    setRuntimeForTests(null);
  }
});

test("permanent deletion blocks an active collection cover and identifies the collection", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "cover-image");
  assert.equal(await repo.createCollection(makeCollection({ id: "active-cover-collection", ownerId: "owner", name: "Campaign artwork", mediaIds: [], sharedCoverMediaId: "cover-image" })), true);
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "unused", now: () => NOW });
  try {
    const response = await POST(permanentRequest("cover-image"));
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /active collection “Campaign artwork”/);
    assert.equal((await repo.getMedia("cover-image"))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally { setRuntimeForTests(null); }
});

test("permanent deletion blocks a cover on a non-deleted active publishing cycle", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "cover-image");
  addCycleRecord(repo, { id: "active-cover-cycle", status: "running", deletedAt: null, name: "Weekly posts" });
  repo.items.set("published-cover-item", makeItem({ id: "published-cover-item", cycleId: "active-cover-cycle", cycleOwnerId: "owner", mediaAssetId: "cover-image", status: "published", coverMediaId: "cover-image", externalPostId: "synthetic-post" }));
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "unused", now: () => NOW });
  try {
    const response = await POST(permanentRequest("cover-image"));
    assert.equal(response.status, 409);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /active publishing cycle “Weekly posts”/);
    assert.equal((await repo.getMedia("cover-image"))?.status, "active");
    assert.equal(repo.items.get("published-cover-item")?.externalPostId, "synthetic-post");
  } finally { setRuntimeForTests(null); }
});

test("deletion clears cover pointers only from archived collections and retains deleted-cycle publishing history", async () => {
  const repo = new MemoryRepository();
  await addImage(repo, "cover-image"); await addImage(repo, "collection-member");
  assert.equal(await repo.createCollection(makeCollection({
    id: "archived-cover-collection", ownerId: "owner", name: "Archived campaign", archived: true, mediaIds: ["collection-member"], sharedCoverMediaId: "cover-image",
    items: [{ mediaAssetId: "collection-member", captionText: "Keep this caption", coverMediaId: "cover-image", version: 3 }], settingsVersion: 9,
  })), true);
  addCycleRecord(repo, { id: "deleted-history-cycle", status: "stopped", deletedAt: NOW, name: "Retained post history" });
  repo.items.set("retained-published-item", makeItem({ id: "retained-published-item", cycleId: "deleted-history-cycle", cycleOwnerId: "owner", mediaAssetId: "cover-image", status: "published", coverMediaId: "cover-image", externalPostId: "synthetic-post", publishedAt: NOW }));
  const storage = new MemoryMediaStorage(); storage.objects.set(`private/owner/cover-image`, new Uint8Array([1]));
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "cleanup-job", now: () => NOW });
  try {
    const response = await POST(permanentRequest("cover-image"));
    assert.equal(response.status, 200);
    const archived = await repo.getCollection("archived-cover-collection");
    assert.equal(archived?.sharedCoverMediaId, null);
    assert.equal(archived?.items?.[0]?.coverMediaId, null);
    assert.equal(archived?.items?.[0]?.version, 4);
    assert.equal(archived?.items?.[0]?.captionText, "Keep this caption");
    const history = repo.items.get("retained-published-item");
    assert.equal(history?.coverMediaId, "cover-image");
    assert.equal(history?.externalPostId, "synthetic-post");
    assert.equal(history?.publishedAt?.toISOString(), NOW.toISOString());
    assert.equal(await repo.canCleanupMediaAsset("cover-image"), true);
    assert.equal(await runNextMediaCleanupJob({ repo, storage, workerId: "cleanup", now: NOW }), "deleted");
    assert.equal(await storage.exists("private/owner/cover-image"), false);
  } finally { setRuntimeForTests(null); }
});

test("deleted and archived covers do not hide a separate active cover dependency", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "cover-image");
  assert.equal(await repo.createCollection(makeCollection({ id: "archived-cover", ownerId: "owner", archived: true, mediaIds: [], sharedCoverMediaId: "cover-image" })), true);
  assert.equal(await repo.createCollection(makeCollection({ id: "active-cover", ownerId: "owner", name: "Live cover", archived: false, mediaIds: [], sharedCoverMediaId: "cover-image" })), true);
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "unused", now: () => NOW });
  try {
    const blocked = await POST(permanentRequest("cover-image"));
    assert.equal(blocked.status, 409);
    assert.equal(repo.collections.get("archived-cover")?.sharedCoverMediaId, "cover-image", "do not clear stale references until all active blockers are resolved");
    repo.collections.set("active-cover", { ...repo.collections.get("active-cover")!, archived: true });
    const allowed = await POST(permanentRequest("cover-image"));
    assert.equal(allowed.status, 200);
    assert.equal(repo.collections.get("archived-cover")?.sharedCoverMediaId, null);
    assert.equal(repo.collections.get("active-cover")?.sharedCoverMediaId, null);
  } finally { setRuntimeForTests(null); }
});

test("cover assignment and permanent deletion serialize so a deleted media item cannot gain a new cover", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "cover-image");
  assert.equal(await repo.createCollection(makeCollection({ id: "race-cover-collection", ownerId: "owner", mediaIds: [], settingsVersion: 1 })), true);
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "race-cleanup", now: () => NOW });
  try {
    const [deletion, assigned] = await Promise.all([
      repo.requestPermanentMediaDeletion({ id: "race-cleanup", mediaId: "cover-image", ownerId: "owner", expectedCollectionIds: [], now: NOW }),
      repo.saveCollectionSharedSettings({ collectionId: "race-cover-collection", ownerId: "owner", actorId: "owner", affected: 0, expectedVersion: 1, coverMode: "shared", sharedCoverMediaId: "cover-image" }),
    ]);
    const collection = repo.collections.get("race-cover-collection");
    assert.ok((deletion.status === "queued" && assigned === false && collection?.sharedCoverMediaId == null)
      || (deletion.status === "cover_in_use" && assigned === true && collection?.sharedCoverMediaId === "cover-image"));
    assert.equal((await repo.getMedia("cover-image"))?.status, deletion.status === "queued" ? "deleted" : "active");
  } finally { setRuntimeForTests(null); }
});

test("failed private-storage cleanup leaves the tombstoned media row and a retryable cleanup job", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "storage-failure-image");
  const storage = new MemoryMediaStorage(); storage.objects.set("private/owner/storage-failure-image", new Uint8Array([1]));
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "storage-failure-job", now: () => NOW });
  try {
    assert.equal((await POST(permanentRequest("storage-failure-image"))).status, 200);
    storage.deleteCommittedMediaObject = async () => { throw new Error("synthetic storage failure"); };
    assert.equal(await runNextMediaCleanupJob({ repo, storage, workerId: "cleanup", now: NOW }), "retrying");
    assert.equal((await repo.getMedia("storage-failure-image"))?.status, "deleted");
    assert.equal(await storage.exists("private/owner/storage-failure-image"), true);
    assert.equal([...repo.mediaCleanupJobs.values()][0]?.status, "queued");
  } finally { setRuntimeForTests(null); }
});

test("permanent deletion continues to protect active media imports and renders", async () => {
  const repo = new MemoryRepository(); await addImage(repo, "protected-image");
  const importJob: MediaImportJobRecord = { id: "synthetic-import", importerId: "owner", sourceMediaId: "protected-image", sourceCollectionId: "source-collection", status: "copying", idempotencyKey: "synthetic-import-key", newObjectKey: "private/owner/import", stagingObjectKey: null, attemptStorageKeys: [], resultMediaAssetId: "import-result", failureReason: null, attempts: 1, lockedBy: "worker", lockToken: "synthetic-lock", leaseExpiresAt: new Date(NOW.getTime() + 60_000), createdAt: NOW, updatedAt: NOW };
  repo.mediaImportJobs.set(importJob.id, importJob);
  setRuntimeForTests({ mode: "demo", repo, currentUserId: async () => "owner", newId: () => "unused", now: () => NOW });
  try {
    const importBlocked = await POST(permanentRequest("protected-image"));
    assert.equal(importBlocked.status, 409);
    assert.match((await importBlocked.json() as { error: { message: string } }).error.message, /import/i);
    repo.mediaImportJobs.delete(importJob.id);
    const renderJob: RenderJobRecord = { id: "synthetic-render", ownerId: "owner", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: "protected-image", progressPercent: 0, attempts: 0, idempotencyKey: "synthetic-render-key", lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: NOW, finishedAt: null, settingsHash: null, payload: {}, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null };
    repo.renderJobs.set(renderJob.id, renderJob);
    const renderBlocked = await POST(permanentRequest("protected-image"));
    assert.equal(renderBlocked.status, 409);
    assert.match((await renderBlocked.json() as { error: { message: string } }).error.message, /render/i);
    assert.equal((await repo.getMedia("protected-image"))?.status, "active");
  } finally { setRuntimeForTests(null); }
});
