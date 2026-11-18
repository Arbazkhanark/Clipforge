// Export pipeline. Real FFmpeg cases are skipped when ffmpeg or ffprobe is missing.
// The database case runs only when DATABASE_URL is the isolated local database at process start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { getPlan } from "../src/lib/billing/catalog.ts";
import { toRenderSettings, type EditingSettings } from "../src/lib/domain/editing-settings.ts";
import { hashExportSettings } from "../src/lib/render/render-limits.ts";
import { probeVideo, readPixel } from "../src/lib/render/render-runner.ts";
import { AppError } from "../src/server/errors.ts";
import { serveRender, serveRenderPreview } from "../src/server/handlers/render-serve.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { createRenderScheduler, runNextPersistedRenderJob, startExport, type ExportRunner } from "../src/server/render/export-service.ts";
import type { RenderJobRecord } from "../src/server/repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { mediaKeyFor } from "../src/server/storage/media-storage.ts";
import { makeCollection, makeGrant, makeMedia, NOW } from "./helpers.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const databaseUrlAtStart = isolatedDatabaseUrl();
const hasDatabase = Boolean(databaseUrlAtStart);
const until = async (ready: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await ready()) return; await new Promise((resolve) => setTimeout(resolve, 50)); } assert.fail("timed out waiting for a render"); };

function context(repo: MemoryRepository, storage: MemoryMediaStorage, userId: string, renders = createRenderScheduler(1)): RequestContext {
  return { userId, now: NOW, repo, newId: () => `job${++counter}`, config: { coverSupport: "unknown" }, media: { storage, probe: null, maxUploadBytes: 200 * 1024 * 1024 }, renders };
}
let counter = 0;

function library() {
  const repo = new MemoryRepository();
  const storage = new MemoryMediaStorage();
  repo.plans.set("bob", "free"); repo.plans.set("eve", "free");
  const video = makeMedia({ id: "v1", ownerId: "bob", kind: "video", title: "Clip", width: 320, height: 240, durationMs: 1000, sizeBytes: 1000, validation: "verified", mimeType: "video/mp4" });
  repo.media.set("v1", video);
  repo.storageKeys.set("v1", mediaKeyFor("bob", "v1"));
  storage.objects.set(mediaKeyFor("bob", "v1"), new Uint8Array([1, 2, 3, 4]));
  return { repo, storage };
}

const settings = { aspect: "9:16", background: { kind: "solid", colorHex: "#ff00ff" }, zoom: 1, offsetX: 0, offsetY: 0, border: { thicknessPx: 0, colorHex: "#ffffff" }, logo: null };

test("invalid settings and someone else's video are refused before a render starts", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  const ctx = context(repo, storage, "bob", renders);
  await assert.rejects(() => startExport(ctx, { mediaId: "v1", settings: { ...settings, zoom: 9 } }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => startExport(ctx, { mediaId: "missing", settings }), (error: unknown) => error instanceof AppError && error.status === 404);
  repo.media.set("evevid", makeMedia({ id: "evevid", ownerId: "eve", kind: "video", validation: "verified", width: 320, height: 240, durationMs: 1000 }));
  await assert.rejects(() => startExport(ctx, { mediaId: "evevid", settings }), (error: unknown) => error instanceof AppError && error.status === 404);
  assert.equal(renders.jobs.size, 0);
  assert.deepEqual([...storage.objects.keys()], [mediaKeyFor("bob", "v1")]);
});

test("export validates trim against the server-side source duration and passes the normalized range to FFmpeg", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  const ctx = context(repo, storage, "bob", renders);
  const invalid = await assert.rejects(() => startExport(ctx, { mediaId: "v1", settings: { ...settings, trim: { startSeconds: 0.2, endSeconds: 1.001 } } }), (error: unknown) => error instanceof AppError && error.status === 422);
  assert.equal(invalid, undefined);
  assert.equal((await repo.listRenderJobsForOwner("bob")).length, 0);
  let seenTrim: unknown;
  const runner: ExportRunner = { async render(args) { seenTrim = args.settings.trim; return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const job = await startExport(ctx, { mediaId: "v1", settings: { ...settings, trim: { startSeconds: 0.2, endSeconds: 0.8 } } }, runner);
  await until(() => renders.jobs.get(job.jobId)?.status === "failed");
  assert.deepEqual(seenTrim, { startSeconds: 0.2, endSeconds: 0.8 });
});

test("trim choices participate in normalized render-job idempotency without changing full-video compatibility", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(0);
  const ctx = context(repo, storage, "bob", renders);
  const full = await startExport(ctx, { mediaId: "v1", settings });
  const legacyFull = await startExport(ctx, { mediaId: "v1", settings: { ...settings, trim: { startSeconds: 0, endSeconds: null } } });
  assert.equal(legacyFull.jobId, full.jobId, "legacy settings and normalized no-trim settings reuse the same export job");
  const trimmed = await startExport(ctx, { mediaId: "v1", settings: { ...settings, trim: { startSeconds: 0, endSeconds: 0.75 } } });
  assert.notEqual(trimmed.jobId, full.jobId);
  assert.equal((await repo.listRenderJobsForOwner("bob")).length, 2);
});

test("active promotional Creator tier supplies the catalog processing allowance to exports", async () => {
  const { repo, storage } = library();
  repo.promotionalAccessGrants.set("promo-bob", {
    id: "promo-bob", promotionId: "promotion-bob", userId: "bob", redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status: "active", planId: "creator",
    durationDays: 3, queueSequence: 1n, startsAt: new Date(NOW.getTime() - 1), expiresAt: new Date(NOW.getTime() + 3 * 86_400_000), activatedAt: new Date(NOW.getTime() - 1), revokedAt: null,
    grantedByAdminId: "admin", reason: null, createdAt: NOW, updatedAt: NOW,
  });
  repo.setUsage("bob", new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)), { processingSeconds: getPlan("free").limits.processingMinutesPerMonth * 60, exports: 0, scheduledItems: 0 });
  const renders = createRenderScheduler(1);
  const runner: ExportRunner = { async render() { return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const job = await startExport(context(repo, storage, "bob", renders), { mediaId: "v1", settings }, runner);
  assert.ok(job.jobId, "Creator processing allowance permits a request beyond the Free monthly limit");
  await until(() => renders.jobs.get(job.jobId)?.status === "failed");
});

test("a granted video can be rendered and an unknown email-style path is never used", async () => {
  const { repo, storage } = library();
  repo.collections.set("col", makeCollection({ id: "col", ownerId: "bob", mediaIds: ["v1"] }));
  await repo.upsertGrant(makeGrant({ collectionId: "col", granteeId: "eve", capabilities: ["use_in_cycle"] }));
  const renders = createRenderScheduler(1);
  let seen = "";
  const runner: ExportRunner = { async render(args) { seen = args.inputPath; return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const job = await startExport(context(repo, storage, "eve", renders), { mediaId: "v1", settings, path: "/etc/passwd", ffmpeg: "rm -rf /" }, runner);
  await until(() => renders.jobs.get(job.jobId)?.status === "failed");
  assert.equal(seen.includes("passwd"), false);
  assert.equal(seen.includes("rm"), false);
  assert.deepEqual([...storage.objects.get(mediaKeyFor("bob", "v1"))!], [1, 2, 3, 4]);
});

test("a failed render removes its temporary file and does not store an export", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  let outputPath = "";
  const runner: ExportRunner = { async render(args) { outputPath = args.outputPath; await writeFile(args.outputPath, Buffer.from("partial")); return { succeeded: false, outputValidated: false, problems: ["ffmpeg exited with code 1"], processingSeconds: 0.1, outputProbe: null }; } };
  const job = await startExport(context(repo, storage, "bob", renders), { mediaId: "v1", settings }, runner);
  await until(() => renders.jobs.get(job.jobId)?.status === "failed" && outputPath !== "" && !existsSync(outputPath));
  assert.equal(renders.jobs.get(job.jobId)?.message, "Rendering failed before a finished file was saved. The original video was not changed.");
  assert.equal((renders.jobs.get(job.jobId)?.message ?? "").includes("/"), false);
  assert.equal((await repo.listRenderOutputsForOwner("bob")).length, 0);
  assert.deepEqual([...storage.objects.keys()], [mediaKeyFor("bob", "v1")]);
});

test("a missing FFmpeg program fails the job without saving an export", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  const runner: ExportRunner = { async render() { throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }); } };
  const job = await startExport(context(repo, storage, "bob", renders), { mediaId: "v1", settings }, runner);
  await until(() => renders.jobs.get(job.jobId)?.status === "failed");
  assert.match(renders.jobs.get(job.jobId)?.message ?? "", /FFmpeg is not available/);
  assert.equal((await repo.listRenderOutputsForOwner("bob")).length, 0);
});

test("only one render runs at a time when the process limit is one", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const runner: ExportRunner = { async render() { started++; if (started === 1) await gate; return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const ctx = context(repo, storage, "bob", renders);
  const first = await startExport(ctx, { mediaId: "v1", settings }, runner);
  await until(() => started === 1);
  assert.equal(renders.jobs.get(first.jobId)?.status, "processing");
  const second = await startExport(ctx, { mediaId: "v1", settings: { ...settings, zoom: 1.1 } }, runner);
  assert.equal(renders.jobs.get(second.jobId)?.status, "queued");
  assert.equal(started, 1);
  release();
  await until(() => renders.jobs.get(first.jobId)?.status === "failed" && renders.jobs.get(second.jobId)?.status === "failed");
  assert.equal(started, 2);
});

test("export requests are persisted before execution and duplicate active requests reuse one durable job", async () => {
  const { repo, storage } = library();
  const renders = createRenderScheduler(1);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  const runner: ExportRunner = { async render() { started++; await gate; return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const ctx = context(repo, storage, "bob", renders);
  const first = await startExport(ctx, { mediaId: "v1", settings }, runner);
  await until(() => started === 1);
  const duplicate = await startExport(ctx, { mediaId: "v1", settings }, runner);
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal((await repo.listRenderJobsForOwner("bob")).length, 1);
  const persistedWhileRunning = await repo.getRenderJobForOwner(first.jobId, "bob");
  assert.equal(persistedWhileRunning?.status, "running");
  release();
  await until(async () => (await repo.getRenderJobForOwner(first.jobId, "bob"))?.status === "failed");
  assert.equal((await repo.getRenderJobForOwner(first.jobId, "bob"))?.errorMessage, "Rendering failed before a finished file was saved. The original video was not changed.");
});

test("a queued render resumes from its durable record after a new scheduler is created", async () => {
  const { repo, storage } = library();
  const firstProcessQueue = createRenderScheduler(0); // simulate process exit before a worker claims the persisted row
  const first = await startExport(context(repo, storage, "bob", firstProcessQueue), { mediaId: "v1", settings });
  assert.equal((await repo.getRenderJobForOwner(first.jobId, "bob"))?.status, "queued");

  let executions = 0;
  const runner: ExportRunner = { async render() { executions++; return { succeeded: false, outputValidated: false, problems: ["stopped"], processingSeconds: 0, outputProbe: null }; } };
  const restarted = createRenderScheduler(1);
  const replay = await startExport(context(repo, storage, "bob", restarted), { mediaId: "v1", settings }, runner);
  assert.equal(replay.jobId, first.jobId);
  await until(async () => (await repo.getRenderJobForOwner(first.jobId, "bob"))?.status === "failed");
  assert.equal(executions, 1);
  const recovered = await repo.getRenderJobForOwner(first.jobId, "bob");
  assert.equal(recovered?.attempts, 1);
  assert.equal(recovered?.status, "failed");
});

test("the standalone worker reconstructs a persisted queued job and stores its failure state", async () => {
  const { repo, storage } = library();
  const plan = getPlan("free");
  const renderSettings = toRenderSettings(settings as EditingSettings, plan.features.maxResolution);
  const settingsHash = hashExportSettings("v1", renderSettings, null, null);
  const record: RenderJobRecord = {
    id: "restart-job", ownerId: "bob", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: "v1", progressPercent: 0,
    attempts: 0, idempotencyKey: `render:bob:v1:${settingsHash}`, lockedBy: null, lockExpiresAt: null, errorMessage: null,
    createdAt: NOW, finishedAt: null, settingsHash, payload: { version: 1, editingSettings: settings as EditingSettings, maxResolution: plan.features.maxResolution },
    pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
  };
  assert.equal((await repo.createRenderJob(record)).status, "created");
  const runner: ExportRunner = { async render() { return { succeeded: false, outputValidated: false, problems: ["controlled failure"], processingSeconds: 0.2, outputProbe: null }; } };
  assert.equal(await runNextPersistedRenderJob(context(repo, storage, "bob", createRenderScheduler(0)), "restart-worker", runner), "processed");
  const recovered = await repo.getRenderJobForOwner(record.id, "bob");
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.attempts, 1);
  assert.match(recovered?.errorMessage ?? "", /rendering failed/i);
});

test("completed render preview is private, inline, and supports bounded byte ranges", async () => {
  const { repo, storage } = library();
  const ctx = context(repo, storage, "bob");
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  storage.objects.set("private/rendered-preview", bytes);
  await repo.saveRenderOutput({ id: "preview-output", sourceMediaId: "v1", ownerId: "bob", storageKey: "private/rendered-preview", sizeBytes: bytes.length, settingsHash: "settings-hash", createdAt: NOW }, 10_000);

  const preview = await serveRenderPreview(ctx, { exportId: "preview-output", rangeHeader: null });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["Content-Type"], "video/mp4");
  assert.equal(preview.headers["Content-Disposition"], 'inline; filename="export.mp4"; filename*=UTF-8\'\'export.mp4');
  assert.equal(preview.headers["Cache-Control"], "private, no-store");
  const partial = await serveRenderPreview(ctx, { exportId: "preview-output", rangeHeader: "bytes=2-4" });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers["Content-Range"], "bytes 2-4/6");
  assert.deepEqual([...new Uint8Array(await new Response(partial.body).arrayBuffer())], [2, 3, 4]);
  await assert.rejects(() => serveRenderPreview({ ...ctx, userId: "eve" }, { exportId: "preview-output", rangeHeader: null }), (error: unknown) => error instanceof AppError && error.status === 404);
});

test("REAL FFMPEG: a short export is playable, keeps the original, and can be downloaded by its owner", { skip: !ffmpegAvailable && "ffmpeg/ffprobe not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clipforge-export-"));
  try {
    const source = path.join(dir, "source.mp4");
    const logo = path.join(dir, "logo.png");
    const background = path.join(dir, "bg.png");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source]).status, 0);
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xffff00:s=80x40", "-frames:v", "1", logo]).status, 0);
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xff0000:s=32x32", "-frames:v", "1", background]).status, 0);
    const { repo, storage } = library();
    const sourceKey = mediaKeyFor("bob", "v1");
    const original = readFileSync(source);
    storage.objects.set(sourceKey, original);
    repo.media.set("logo1", makeMedia({ id: "logo1", ownerId: "bob", kind: "image", title: "Logo", validation: "verified", width: 80, height: 40, mimeType: "image/png" }));
    repo.media.set("bg1", makeMedia({ id: "bg1", ownerId: "bob", kind: "image", title: "Backdrop", validation: "verified", width: 32, height: 32, mimeType: "image/png" }));
    repo.storageKeys.set("logo1", mediaKeyFor("bob", "logo1"));
    repo.storageKeys.set("bg1", mediaKeyFor("bob", "bg1"));
    storage.objects.set(mediaKeyFor("bob", "logo1"), readFileSync(logo));
    storage.objects.set(mediaKeyFor("bob", "bg1"), readFileSync(background));
    repo.media.set("v1", { ...repo.media.get("v1")!, durationMs: 1000, sizeBytes: original.length });
    const renders = createRenderScheduler(1);
    const ctx = context(repo, storage, "bob", renders);
    const job = await startExport(ctx, { mediaId: "v1", settings: { ...settings, border: { thicknessPx: 8, colorHex: "#00ff00" }, background: { kind: "image", mediaId: "bg1" }, logo: { mediaId: "logo1", widthFraction: 0.2, centerX: 0.5, centerY: 0.08, opacity: 1 } } });
    await until(() => { const status = renders.jobs.get(job.jobId)?.status; return status === "completed" || status === "failed"; });
    const finished = renders.jobs.get(job.jobId);
    assert.equal(finished?.status, "completed", finished?.message ?? "");
    const output = await repo.getRenderOutput(finished!.outputId!);
    assert.ok(output);
    assert.equal([...storage.objects.get(sourceKey)!].length, original.length);
    await storage.runWithCommittedFile(output.storageKey, async (filePath) => {
      const probed = await probeVideo(filePath);
      assert.deepEqual([probed.width, probed.height, probed.videoCodec], [720, 1280, "h264"]);
      assert.ok(Math.abs(probed.durationSeconds - 1) < 0.4);
      const top = await readPixel(filePath, 20, 20);
      assert.ok(top[0] > 180 && top[1] < 80, `background pixel ${top}`);
      const mark = await readPixel(filePath, 360, 100);
      assert.ok(mark[0] > 180 && mark[1] > 180, `logo pixel ${mark}`);
    });
    const served = await serveRender(ctx, { exportId: output.id });
    assert.equal(served.status, 200);
    assert.equal(served.headers["Content-Type"], "video/mp4");
    assert.equal(served.headers["Content-Length"], String(output.sizeBytes));
    await assert.rejects(() => serveRender({ ...ctx, userId: "eve" }, { exportId: output.id }), (error: unknown) => error instanceof AppError && error.status === 404);
    assert.equal(getPlan("free").features.maxResolution, "720p");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a finished export remains after a new database connection", { skip: !hasDatabase || !ffmpegAvailable ? "DATABASE_URL or ffmpeg is not available for this process" : false }, async () => {
  const stamp = randomUUID().replace(/-/g, "");
  const ownerId = `p5${stamp.slice(0, 20)}`;
  const otherId = `p5b${stamp.slice(0, 20)}`;
  const mediaId = `p5m${stamp.slice(0, 20)}`;
  const dir = mkdtempSync(path.join(tmpdir(), "clipforge-export-db-"));
  const source = path.join(dir, "source.mp4");
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "1", source]).status, 0);
  const storage = await LocalDiskMediaStorage.create(path.join(dir, "media"));
  const db = await createPrismaClient(databaseUrlAtStart as string);
  const closer = db as PrismaClientLike & { $disconnect(): Promise<void> };
  const remove = async (client: PrismaClientLike) => {
    await client.mediaDerivative.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await client.usageRecord.deleteMany({ where: { userId: { in: [ownerId, otherId] } } });
    await client.auditLog.deleteMany({ where: { actorId: { in: [ownerId, otherId] } } });
    await client.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await client.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  };
  try {
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@clipforge.test`, passwordHash: "scrypt$not-a-password", role: "user" } });
    await db.user.create({ data: { id: otherId, email: `${otherId}@clipforge.test`, passwordHash: "scrypt$not-a-password", role: "user" } });
    const repo = new PrismaRepository(db);
    const bytes = readFileSync(source);
    const key = mediaKeyFor(ownerId, mediaId);
    assert.equal(await repo.addMediaIfStorageWithin(makeMedia({ id: mediaId, ownerId, kind: "video", title: "Phase 5 clip", sizeBytes: bytes.length, durationMs: 1000, width: 160, height: 120, validation: "verified", mimeType: "video/mp4" }), { storageKey: key, thumbnailKey: null }, 50_000_000), true);
    await storage.importLocalFile(key, source);
    const renders = createRenderScheduler(1);
    let ids = 0;
    const ctx: RequestContext = { userId: ownerId, now: new Date(), repo, newId: () => `p5job${stamp.slice(0, 8)}${++ids}`, config: { coverSupport: "unknown" }, media: { storage, probe: null, maxUploadBytes: 200 * 1024 * 1024 }, renders };
    const job = await startExport(ctx, { mediaId, settings });
    await until(() => { const status = renders.jobs.get(job.jobId)?.status; return status === "completed" || status === "failed"; });
    assert.equal(renders.jobs.get(job.jobId)?.status, "completed", renders.jobs.get(job.jobId)?.message ?? "");
    const outputId = renders.jobs.get(job.jobId)?.outputId ?? "";
    await closer.$disconnect();
    const restarted = await createPrismaClient(databaseUrlAtStart as string);
    const restartedCloser = restarted as typeof closer;
    try {
      const second = new PrismaRepository(restarted);
      const row = await second.getRenderOutput(outputId);
      assert.equal(row?.ownerId, ownerId);
      assert.equal(row?.sourceMediaId, mediaId);
      const size = await storage.statSize(row!.storageKey);
      assert.equal(size, row?.sizeBytes);
      assert.equal(await storage.statSize(key), bytes.length);
      await storage.runWithCommittedFile(row!.storageKey, async (filePath) => { const probed = await probeVideo(filePath); assert.equal(probed.videoCodec, "h264"); });
      await assert.rejects(() => serveRender({ ...ctx, userId: otherId, repo: second }, { exportId: outputId }), (error: unknown) => error instanceof AppError && error.status === 404);
    } finally { await remove(restarted); await restartedCloser.$disconnect(); }
  } finally { await remove(db).catch(() => undefined); await closer.$disconnect().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});
