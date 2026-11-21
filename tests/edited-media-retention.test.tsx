import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { POST } from "../app/api/media/edited-retention/route.ts";
import { getEditedMediaRetentionStatus, requestEditedMediaRetention } from "../src/server/handlers/media-retention.ts";
import { getEditorPageData } from "../src/server/queries.ts";
import { EditedMediaRetentionChoice } from "../src/components/EditedMediaRetentionChoice.tsx";
import { reconcileEditedRetentionStatus } from "../src/lib/domain/edited-retention-status.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { setRuntimeForTests } from "../src/server/runtime.ts";
import type { RenderJobRecord } from "../src/server/repository.ts";
import { makeItem, makeMedia } from "./helpers.ts";
import { runNextEditedMediaReplacement } from "../src/server/media-replacement-worker.ts";
import { runNextMediaCleanupJob } from "../src/server/media-deletion/cleanup-worker.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const ORIGINAL_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const GOOD_ID = "00000000-0000-4000-8000-000000000003";
const FAILED_ID = "00000000-0000-4000-8000-000000000004";

function request(items: { mediaId: string; outputId: string }[], confirm = true) {
  return new Request("http://localhost/api/media/edited-retention", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm, items }),
  });
}

async function addOutput(repo: MemoryRepository, storage: MemoryMediaStorage, mediaId: string, outputId: string, storageKey: string) {
  const bytes = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  storage.objects.set(storageKey, bytes);
  assert.deepEqual(await repo.saveRenderOutput({ id: outputId, sourceMediaId: mediaId, ownerId: "owner", storageKey, sizeBytes: bytes.length, settingsHash: `settings-${outputId}`, createdAt: NOW }, Number.MAX_SAFE_INTEGER), { status: "saved", id: outputId });
}

const verifiedOriginal = (id: string, title = "Original.mp4") => makeMedia({ id, ownerId: "owner", kind: "video", title, validation: "verified", mimeType: "video/mp4", checksumSha256: "source-checksum" });
function persistent(storage: MemoryMediaStorage) {
  return new Proxy(storage, { get(target, property) { if (property === "kind") return "local-disk"; const value = Reflect.get(target, property, target) as unknown; return typeof value === "function" ? value.bind(target) : value; } }) as unknown as MemoryMediaStorage;
}

async function addCompletedRender(repo: MemoryRepository, mediaId: string, outputId: string, jobId = `render-${outputId}`) {
  const job: RenderJobRecord = {
    id: jobId, ownerId: "owner", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: mediaId,
    progressPercent: 0, attempts: 0, idempotencyKey: `render:${jobId}`, lockedBy: null, lockExpiresAt: null,
    errorMessage: null, createdAt: NOW, finishedAt: null, settingsHash: `settings-${outputId}`, payload: { version: 1 },
    pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
  };
  assert.equal((await repo.createRenderJob(job)).status, "created");
  const claimed = await repo.claimNextRenderJob({ workerId: `test-${jobId}`, now: NOW, leaseSeconds: 60, jobId });
  assert.ok(claimed?.lockToken);
  assert.equal(await repo.completeRenderJob(jobId, "owner", claimed!.lockToken!, NOW, outputId), true);
}

function install(repo: MemoryRepository, storage: MemoryMediaStorage, userId: string | null = "owner") {
  setRuntimeForTests({
    mode: "demo", repo, currentUserId: async () => userId, newId: () => `cleanup-${Math.random().toString(36).slice(2)}`,
    now: () => NOW,
    media: async () => ({ storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 5 }), maxUploadBytes: 200 * 1024 * 1024 }),
  });
}

test("retention choice offers both options and requires a separate explicit confirmation", () => {
  const markup = renderToStaticMarkup(<EditedMediaRetentionChoice items={[{ mediaId: "original", outputId: "edited", title: "Edited clip.mp4" }]} />);
  assert.match(markup, /Your videos have been edited\. What would you like to save\?/);
  assert.match(markup, /Keep original \+ edited videos/);
  assert.match(markup, /Keep only edited videos/);
  assert.match(markup, /Recommended/);
  assert.doesNotMatch(markup, /Confirm — Keep only edited videos/);
  assert.doesNotMatch(markup, /Confirm/);
});

test("Export History can reopen retention choice only while a verified export and original are available", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID, "History clip.mp4"), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "history-output", "render/owner/history");
  await addCompletedRender(repo, ORIGINAL_ID, "history-output");
  const ctx = { userId: "owner", now: NOW, repo, newId: () => "new-id", config: { coverSupport: "unknown" as const }, media: { storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 5 }), maxUploadBytes: 10_000 } };
  try {
    const available = await getEditorPageData(ctx, { mediaId: undefined, search: {} });
    assert.equal(available.exports[0]?.retentionStatus, "available");
    const availableUi = renderToStaticMarkup(<EditedMediaRetentionChoice presentation="history" items={available.exports.map((item) => ({ mediaId: item.sourceMediaId, outputId: item.id, title: item.sourceTitle, retentionStatus: item.retentionStatus, retentionMessage: item.retentionMessage }))} />);
    assert.match(availableUi, /Keep only edited videos/);

    await requestEditedMediaRetention(ctx, { confirm: true, items: [{ mediaId: ORIGINAL_ID, outputId: "history-output" }] });
    const queued = await getEditorPageData(ctx, { mediaId: undefined, search: {} });
    assert.equal(queued.exports[0]?.retentionStatus, "queued");
    const queuedUi = renderToStaticMarkup(<EditedMediaRetentionChoice presentation="history" items={queued.exports.map((item) => ({ mediaId: item.sourceMediaId, outputId: item.id, title: item.sourceTitle, retentionStatus: item.retentionStatus, retentionMessage: item.retentionMessage }))} />);
    assert.match(queuedUi, /replacement is queued/i);
    assert.doesNotMatch(queuedUi, /Keep only edited videos/);
  } finally { setRuntimeForTests(null); }
});

test("retention status reports queued/deleted accurately and fails closed for unauthorized or unverified outputs", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "status-output", "render/owner/status");
  const ctx = { userId: "owner", now: NOW, repo, newId: () => "new-id", config: { coverSupport: "unknown" as const }, media: { storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 5 }), maxUploadBytes: 10_000 } };
  try {
    await assert.rejects(() => getEditedMediaRetentionStatus(ctx, ORIGINAL_ID, "status-output"), (error: unknown) => error instanceof Error && "status" in error && error.status === 404);
    await addCompletedRender(repo, ORIGINAL_ID, "status-output");
    assert.equal((await getEditedMediaRetentionStatus(ctx, ORIGINAL_ID, "status-output")).status, "available");
    await requestEditedMediaRetention(ctx, { confirm: true, items: [{ mediaId: ORIGINAL_ID, outputId: "status-output" }] });
    assert.equal((await getEditedMediaRetentionStatus(ctx, ORIGINAL_ID, "status-output")).status, "queued");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    await assert.rejects(() => getEditedMediaRetentionStatus({ ...ctx, userId: "other" }, ORIGINAL_ID, "status-output"), (error: unknown) => error instanceof Error && "status" in error && error.status === 404);
  } finally { setRuntimeForTests(null); }
});

test("ambiguous POST response reconciliation uses read-only status lookup and never resubmits deletion", async () => {
  let calls = 0;
  const reconciled = await reconcileEditedRetentionStatus([{ mediaId: ORIGINAL_ID, outputId: "output" }], async (input, init) => {
    calls++;
    assert.equal(String(input).startsWith("/api/media/edited-retention?"), true);
    assert.equal(init?.method, undefined, "status reconciliation is a GET, never a second destructive POST");
    return Response.json({ mediaId: ORIGINAL_ID, outputId: "output", status: "queued", message: "Original deletion is queued." });
  });
  assert.equal(calls, 1);
  assert.deepEqual(reconciled.map(({ status }) => status), ["queued"]);
  await assert.rejects(() => reconcileEditedRetentionStatus([{ mediaId: ORIGINAL_ID, outputId: "output" }], async () => new Response("", { status: 503 })));
});

test("confirmed retention queues only the verified original; derivative and edited storage stay intact", async () => {
  const repo = new MemoryRepository();
  const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([9, 8]));
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  await addCompletedRender(repo, ORIGINAL_ID, "edited");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal(response.status, 200);
    const body = await response.json() as { results: { status: string; message: string }[] };
    assert.equal(body.results[0]?.status, "queued", JSON.stringify(body.results));
    assert.match(body.results[0]?.message ?? "", /original stays available until its edited copy is verified/);
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    assert.equal(await storage.exists("private/owner/original"), true, "cleanup is deferred to existing cleanup worker");
    assert.equal(await storage.exists("render/owner/edited"), true);
    assert.equal((await repo.getRenderOutput("edited"))?.sourceMediaId, ORIGINAL_ID);
    assert.equal(repo.audit.filter((entry) => entry.action === "media.permanent_deletion_queued").length, 0);
    assert.equal(repo.editedMediaReplacements.size, 1);
  } finally { setRuntimeForTests(null); }
});

test("replacement worker verifies the new MediaAsset, transfers collection metadata, then queues the original for private cleanup", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID, "Clip.mp4"), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1, 2]));
  await repo.createCollection({ id: "collection-a", ownerId: "owner", visibility: "private", archived: false, name: "Launch", mediaIds: [ORIGINAL_ID], items: [{ mediaAssetId: ORIGINAL_ID, captionText: "Collection caption", coverMediaId: null, version: 4 }] });
  await repo.createCollection({ id: "collection-b", ownerId: "owner", visibility: "private", archived: false, name: "Archive", mediaIds: [ORIGINAL_ID], items: [{ mediaAssetId: ORIGINAL_ID, captionText: "Second caption", coverMediaId: null, version: 9 }] });
  const historyItem = makeItem({ id: "historical-published-item", mediaAssetId: ORIGINAL_ID, cycleOwnerId: "owner", status: "published" });
  repo.items.set(historyItem.id, historyItem);
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  await addCompletedRender(repo, ORIGINAL_ID, "edited");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    const body = await response.json() as { results: { status: string }[] };
    assert.equal(body.results[0]?.status, "queued");
    const replacementJob = [...repo.editedMediaReplacements.values()][0]!;
    const media = { userId: "owner", now: NOW, repo, newId: () => "test-id", config: { coverSupport: "unknown" as const }, media: { storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 5 }), maxUploadBytes: 10_000 } };
    assert.equal(await runNextEditedMediaReplacement(media, "replacement-test", replacementJob.id), "completed");
    const replacementId = replacementJob.plannedReplacementMediaAssetId;
    const promoted = await repo.getMedia(replacementId);
    assert.equal(promoted?.validation, "verified");
    assert.equal(promoted?.ownerId, "owner");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "deleted");
    assert.equal(await storage.exists("private/owner/original"), true, "only the cleanup worker removes the original object");
    assert.equal(await storage.exists("render/owner/edited"), true, "render derivative remains intact");
    assert.deepEqual(repo.collections.get("collection-a")?.mediaIds, [replacementId]);
    assert.deepEqual(repo.collections.get("collection-b")?.mediaIds, [replacementId]);
    assert.deepEqual(repo.collections.get("collection-a")?.items?.[0], { mediaAssetId: replacementId, captionText: "Collection caption", coverMediaId: null, version: 5 });
    assert.deepEqual(repo.collections.get("collection-b")?.items?.[0], { mediaAssetId: replacementId, captionText: "Second caption", coverMediaId: null, version: 10 });
    assert.deepEqual(repo.items.get(historyItem.id), historyItem, "historical cycle items remain unchanged and continue to point at the original media record");
    assert.equal(new Set(repo.collections.get("collection-a")?.mediaIds).size, 1, "membership transfer does not duplicate the new media in a collection");
    assert.equal(repo.mediaCleanupJobs.size, 1);
    assert.equal(await runNextMediaCleanupJob({ repo, storage: persistent(storage), workerId: "cleanup-test", now: new Date() }), "deleted");
    assert.equal(await storage.exists("private/owner/original"), false, "original bytes are removed only through the dependency-aware cleanup worker");
    assert.equal(await storage.exists(`media/owner/${replacementId}`), true, "replacement object is never deleted with the original");
    assert.equal(await storage.exists("render/owner/edited"), true, "edited derivative remains available in export history");
    const replay = await requestEditedMediaRetention(media, { confirm: true, items: [{ mediaId: ORIGINAL_ID, outputId: "edited" }] });
    assert.equal(replay.results[0]?.status, "existing");
  } finally { setRuntimeForTests(null); }
});

test("missing or mismatched edited output keeps the original", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([9]));
  await repo.addMediaIfStorageWithin(makeMedia({ id: OTHER_ID, ownerId: "owner", kind: "video" }), { storageKey: "private/owner/other", thumbnailKey: null }, 10_000);
  await addOutput(repo, storage, OTHER_ID, "wrong-output", "render/owner/wrong");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "missing" }]));
    assert.equal(response.status, 200);
    const body = await response.json() as { results: { status: string }[] };
    assert.equal(body.results[0]?.status, "blocked");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
    const mismatch = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "wrong-output" }]));
    assert.equal((await mismatch.json() as { results: { status: string }[] }).results[0]?.status, "blocked");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
  } finally { setRuntimeForTests(null); }
});

test("a stored derivative without a successfully completed render job cannot authorize original deletion", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    const body = await response.json() as { results: { status: string; message: string }[] };
    assert.equal(body.results[0]?.status, "blocked");
    assert.match(body.results[0]?.message ?? "", /completed render/);
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally { setRuntimeForTests(null); }
});

test("a completed render whose private output is missing or has changed size keeps the original", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  await addCompletedRender(repo, ORIGINAL_ID, "edited");
  storage.objects.delete("render/owner/edited");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal((await response.json() as { results: { status: string; message: string }[] }).results[0]?.status, "blocked");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally { setRuntimeForTests(null); }
});

test("retention endpoint rejects an unauthenticated request", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  install(repo, storage, null);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal(response.status, 401);
  } finally { setRuntimeForTests(null); }
});

test("replaying a successful choice returns the existing cleanup request without touching the edited output", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  await addCompletedRender(repo, ORIGINAL_ID, "edited");
  install(repo, storage);
  try {
    const first = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal((await first.json() as { results: { status: string }[] }).results[0]?.status, "queued");
    const replay = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal((await replay.json() as { results: { status: string }[] }).results[0]?.status, "existing");
    assert.equal(await storage.exists("render/owner/edited"), true);
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally { setRuntimeForTests(null); }
});

test("partial bulk result queues only successful output pairs and preserves failed originals", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  for (const id of [GOOD_ID, FAILED_ID]) {
    await repo.addMediaIfStorageWithin(verifiedOriginal(id), { storageKey: `private/owner/${id}`, thumbnailKey: null }, 10_000);
    storage.objects.set(`private/owner/${id}`, new Uint8Array([1]));
  }
  await addOutput(repo, storage, GOOD_ID, "good-output", "render/owner/good");
  await addCompletedRender(repo, GOOD_ID, "good-output");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: GOOD_ID, outputId: "good-output" }, { mediaId: FAILED_ID, outputId: "missing-output" }]));
    const body = await response.json() as { results: { mediaId: string; status: string }[] };
    assert.deepEqual(body.results.map((result) => result.status), ["queued", "blocked"]);
    assert.equal((await repo.getMedia(GOOD_ID))?.status, "active");
    assert.equal((await repo.getMedia(FAILED_ID))?.status, "active");
    assert.equal(repo.mediaCleanupJobs.size, 0);
    assert.equal(await storage.exists("render/owner/good"), true);
  } finally { setRuntimeForTests(null); }
});

test("replacement quota is checked before the durable request is created", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  const limit = getPlan("free").limits.storageBytes;
  await repo.addMediaIfStorageWithin({ ...verifiedOriginal(ORIGINAL_ID), sizeBytes: limit }, { storageKey: "private/owner/original", thumbnailKey: null }, Number.MAX_SAFE_INTEGER);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "quota-output", "render/owner/quota");
  await addCompletedRender(repo, ORIGINAL_ID, "quota-output");
  install(repo, storage);
  try {
    const response = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "quota-output" }]));
    const body = await response.json() as { results: { status: string; message: string }[] };
    assert.equal(body.results[0]?.status, "blocked");
    assert.match(body.results[0]?.message ?? "", /not enough storage/i);
    assert.equal(repo.editedMediaReplacements.size, 0);
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
  } finally { setRuntimeForTests(null); }
});

test("verification failure preserves the original and every collection membership", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await repo.createCollection({ id: "failure-collection", ownerId: "owner", visibility: "private", archived: false, name: "Keep", mediaIds: [ORIGINAL_ID], items: [{ mediaAssetId: ORIGINAL_ID, captionText: "Keep me", coverMediaId: null, version: 3 }] });
  await addOutput(repo, storage, ORIGINAL_ID, "failed-verification-output", "render/owner/failed");
  await addCompletedRender(repo, ORIGINAL_ID, "failed-verification-output");
  install(repo, storage);
  try {
    await requestEditedMediaRetention({ userId: "owner", now: NOW, repo, newId: () => "replacement-test", config: { coverSupport: "unknown" }, media: { storage: persistent(storage), probe: async () => { throw new Error("synthetic probe failure"); }, maxUploadBytes: 10_000 } }, { confirm: true, items: [{ mediaId: ORIGINAL_ID, outputId: "failed-verification-output" }] });
    const job = [...repo.editedMediaReplacements.values()][0]!;
    const failed = await runNextEditedMediaReplacement({ userId: "owner", now: NOW, repo, newId: () => "replacement-test", config: { coverSupport: "unknown" }, media: { storage: persistent(storage), probe: async () => { throw new Error("synthetic probe failure"); }, maxUploadBytes: 10_000 } }, "replacement-failure", job.id);
    assert.equal(failed, "failed");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    assert.deepEqual(repo.collections.get("failure-collection")?.mediaIds, [ORIGINAL_ID]);
    assert.deepEqual(repo.collections.get("failure-collection")?.items?.[0], { mediaAssetId: ORIGINAL_ID, captionText: "Keep me", coverMediaId: null, version: 3 });
    assert.equal(repo.mediaCleanupJobs.size, 0);
  } finally { setRuntimeForTests(null); }
});

test("an ambiguous database response after replacement commit resumes idempotently without duplicating the asset", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "retry-output", "render/owner/retry");
  await addCompletedRender(repo, ORIGINAL_ID, "retry-output");
  await requestEditedMediaRetention({ userId: "owner", now: NOW, repo, newId: () => `replacement-${Math.random().toString(36).slice(2)}`, config: { coverSupport: "unknown" }, media: { storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 4 }), maxUploadBytes: 10_000 } }, { confirm: true, items: [{ mediaId: ORIGINAL_ID, outputId: "retry-output" }] });
  const job = [...repo.editedMediaReplacements.values()][0]!;
  const originalCommit = repo.commitEditedMediaReplacement.bind(repo);
  let loseResponse = true;
  repo.commitEditedMediaReplacement = async (input) => {
    const result = await originalCommit(input);
    if (loseResponse && result === "applied") { loseResponse = false; throw new Error("synthetic lost response after commit"); }
    return result;
  };
  const workerContext = { userId: "owner", now: NOW, repo, newId: () => "worker-test", config: { coverSupport: "unknown" as const }, media: { storage: persistent(storage), probe: async () => ({ width: 1080, height: 1920, durationSeconds: 4 }), maxUploadBytes: 10_000 } };
  try {
    assert.equal(await runNextEditedMediaReplacement(workerContext, "replacement-retry", job.id), "failed");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    const persistedJob = repo.editedMediaReplacements.get(job.id)!;
    assert.ok(persistedJob.replacementMediaAssetId);
    persistedJob.lockExpiresAt = new Date(0);
    assert.equal(await runNextEditedMediaReplacement(workerContext, "replacement-retry", job.id), "completed");
    assert.equal(repo.media.size, 2, "the retried job does not create a duplicate MediaAsset");
    assert.equal(repo.mediaVerificationJobs.size, 1, "the retried job does not create duplicate verification jobs");
    assert.equal(repo.mediaCleanupJobs.size, 1);
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "deleted");
  } finally { setRuntimeForTests(null); }
});

test("unauthorized and protected originals are preserved", async () => {
  const repo = new MemoryRepository(); const storage = new MemoryMediaStorage();
  await repo.addMediaIfStorageWithin(verifiedOriginal(ORIGINAL_ID), { storageKey: "private/owner/original", thumbnailKey: null }, 10_000);
  storage.objects.set("private/owner/original", new Uint8Array([1]));
  await addOutput(repo, storage, ORIGINAL_ID, "edited", "render/owner/edited");
  await addCompletedRender(repo, ORIGINAL_ID, "edited");
  repo.items.set("scheduled", makeItem({ id: "scheduled", mediaAssetId: ORIGINAL_ID, cycleOwnerId: "owner", status: "scheduled" }));
  install(repo, storage, "other");
  try {
    const denied = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal(denied.status, 200); // authenticated as another user: per-item response is intentionally non-enumerating
    assert.equal((await denied.json() as { results: { status: string }[] }).results[0]?.status, "blocked");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
    install(repo, storage, "owner");
    const blocked = await POST(request([{ mediaId: ORIGINAL_ID, outputId: "edited" }]));
    assert.equal((await blocked.json() as { results: { status: string }[] }).results[0]?.status, "blocked");
    assert.equal((await repo.getMedia(ORIGINAL_ID))?.status, "active");
  } finally { setRuntimeForTests(null); }
});
