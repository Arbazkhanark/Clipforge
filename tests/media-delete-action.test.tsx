import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaTable } from "../src/components/MediaTable.tsx";
import { mediaDeleteUiReducer } from "../src/components/MediaDeleteAction.tsx";
import { GET, POST } from "../app/api/media/delete/route.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { setRuntimeForTests } from "../src/server/runtime.ts";
import { makeItem, makeMedia } from "./helpers.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { runNextMediaCleanupJob } from "../src/server/media-deletion/cleanup-worker.ts";

const NOW = new Date("2026-11-16T08:00:00.000Z");

function request(mediaId: string) {
  return new Request("http://localhost/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaId, confirm: true, expectedCollectionIds: ["collection-a"] }),
  });
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
