// Starts a render and returns immediately. FFmpeg runs in a child process afterwards, so the web
// request is not held open. A job is marked completed only after the output file is checked and stored.
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPlan } from "../../lib/billing/catalog.ts";
import type { MaxResolution } from "../../lib/render/ffmpeg-command.ts";
import { parseEditingSettings, toRenderSettings, trimDurationProblems, videoSettingsName, type EditingSettings } from "../../lib/domain/editing-settings.ts";
import { decideCanRenderSource } from "../../lib/domain/render-access.ts";
import { buildRenderUsage, monthStartUtc } from "../../lib/domain/usage-accounting.ts";
import { renderVideo, probeVideo, type RenderResult } from "../../lib/render/render-runner.ts";
import { publicRenderFailure, renderDiagnostic } from "../../lib/render/render-errors.ts";
import { hashExportSettings, MAX_RENDER_MS, RENDER_PROCESS_LIMIT, sourceRenderProblems } from "../../lib/render/render-limits.ts";
import type { RenderSettings } from "../../lib/render/ffmpeg-command.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, notFound, planLimit, validationFailed } from "../errors.ts";
import { renderKeyFor, type MediaStorage } from "../storage/media-storage.ts";
import type { RenderJobRecord } from "../repository.ts";

export type RenderJobStatus = "queued" | "processing" | "completed" | "failed";

export interface RenderJob {
  id: string;
  ownerId: string;
  sourceMediaId: string;
  status: RenderJobStatus;
  message: string | null;
  outputId: string | null;
  userLimit: number;
}

export interface ExportRunner {
  render(args: { inputPath: string; outputPath: string; logoPath?: string; backgroundImagePath?: string; settings: RenderSettings }): Promise<RenderResult>;
}

export const ffmpegExportRunner: ExportRunner = {
  render: (args) => renderVideo({ ...args, timeoutMs: MAX_RENDER_MS }),
};

interface PreparedExport {
  sourceKey: string;
  logoKey: string | null;
  backgroundKey: string | null;
  settings: RenderSettings;
  settingsHash: string;
  logoMediaId: string | null;
  backgroundMediaId: string | null;
}

interface PreparedJobContext { ctx: RequestContext; export: PreparedExport; runner: ExportRunner; record: RenderJobRecord | null; }

export class RenderScheduler {
  readonly jobs = new Map<string, RenderJob>();
  private active = 0;
  private waiting: RenderJob[] = [];
  constructor(private processLimit: number, private run: (job: RenderJob) => Promise<void>) {}

  enqueue(job: RenderJob): void {
    job.status = "queued";
    this.jobs.set(job.id, job);
    this.waiting.push(job);
    this.pump();
  }

  private userActive(ownerId: string): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.ownerId === ownerId && job.status === "processing") count++;
    return count;
  }

  private pump(): void {
    while (this.active < this.processLimit) {
      const index = this.waiting.findIndex((job) => this.userActive(job.ownerId) < job.userLimit);
      if (index < 0) return;
      const job = this.waiting.splice(index, 1)[0]!;
      this.active++;
      job.status = "processing";
      setImmediate(() => {
        void this.run(job).catch(() => {
          if (job.status !== "completed") { job.status = "failed"; job.message ??= "Rendering failed before a finished file was saved. The original video was not changed."; }
        }).finally(() => { this.active--; this.pump(); });
      });
    }
  }
}

const prepared = ((globalThis as typeof globalThis & { __clipforgePreparedExports?: WeakMap<RenderJob, PreparedJobContext> }).__clipforgePreparedExports ??= new WeakMap());
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : typeof value === "object" && value !== null ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}` : JSON.stringify(value) ?? "undefined";
/** Keep legacy full-video job payloads byte-for-byte compatible; parser defaults supply the new full-range trim. */
function persistedEditingSettings(settings: EditingSettings): EditingSettings | Omit<EditingSettings, "trim"> {
  if (settings.trim.startSeconds === 0 && settings.trim.endSeconds === null) {
    const { trim: _trim, ...legacyShape } = settings;
    return legacyShape;
  }
  return settings;
}

function failureMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") return "FFmpeg is not available on this server. No export was saved.";
  return publicRenderFailure([error instanceof Error ? error.message : ""]);
}

async function recordFailure(ctx: RequestContext, job: RenderJob, message: string, category: string, detail: string, record: RenderJobRecord | null): Promise<void> {
  job.status = "failed";
  job.message = message;
  if (record?.lockToken) await ctx.repo.failRenderJob(record.id, record.ownerId, record.lockToken, new Date(), message).catch(() => false);
  console.error("render failed", category);
  await ctx.repo.appendAudit({ actorId: job.ownerId, action: "render.failed", entityType: "MediaAsset", entityId: job.sourceMediaId, metadata: { category, detail: renderDiagnostic([detail]) } }).catch(() => undefined);
}

async function withFile<T>(storage: MediaStorage, key: string | null, work: (filePath: string | undefined) => Promise<T>): Promise<T> {
  if (!key) return work(undefined);
  return storage.runWithCommittedFile(key, (filePath) => work(filePath));
}

async function runClaimedRenderJob(job: RenderJob, claimed: RenderJobRecord): Promise<void> {
  const held = prepared.get(job);
  if (!held) { job.status = "failed"; job.message = "Rendering failed before a finished file was saved. The original video was not changed."; return; }
  const lockToken = claimed.lockToken;
  if (!lockToken) { job.status = "failed"; job.message = "This render attempt no longer has a valid worker lease."; return; }
  const { ctx, export: spec, runner } = held;
  held.record = claimed;
  job.status = "processing";
  const fence = { id: claimed.id, ownerId: claimed.ownerId, lockToken };
  const heartbeat = setInterval(() => {
    void ctx.repo.heartbeatRenderJob(claimed.id, claimed.ownerId, lockToken, new Date(), 90).catch(() => false);
  }, 20_000);
  heartbeat.unref?.();
  const storage = ctx.media?.storage;
  if (!storage || ctx.media?.unavailable) {
    await recordFailure(ctx, job, "The private media folder is not available. Nothing was rendered.", "storage_unavailable", "storage unavailable", claimed);
    clearInterval(heartbeat); prepared.delete(job); return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "clipforge-render-"));
  const outputPath = path.join(dir, "output.mp4");
  const outputId = claimed.pendingOutputId;
  if (!outputId) {
    await recordFailure(ctx, job, "The render could not reserve a safe output file.", "render_job_invalid", "pending output id missing", claimed);
    clearInterval(heartbeat); await rm(dir, { recursive: true, force: true }); prepared.delete(job); return;
  }
  const storageKey = renderKeyFor(job.ownerId, outputId);
  let stored = false;
  try {
    const existing = await ctx.repo.findRenderOutput(job.ownerId, job.sourceMediaId, spec.settingsHash);
    if (existing) {
      const info = await ctx.repo.getRenderOutput(existing.id);
      const size = info ? await storage.statSize(info.storageKey) : null;
      if (info && size === info.sizeBytes && await ctx.repo.completeRenderJob(job.id, job.ownerId, fence.lockToken, new Date(), existing.id)) { job.status = "completed"; job.outputId = existing.id; job.message = "This export was already rendered."; return; }
      await recordFailure(ctx, job, "An earlier export for these settings is missing its file.", "render_previous_output_missing", "existing output unavailable", claimed); return;
    }
    const result = await withFile(storage, spec.backgroundKey, (backgroundImagePath) => withFile(storage, spec.logoKey, (logoPath) =>
      storage.runWithCommittedFile(spec.sourceKey, (inputPath) => runner.render({
        inputPath, outputPath, settings: spec.settings,
        ...(logoPath ? { logoPath } : {}), ...(backgroundImagePath ? { backgroundImagePath } : {}),
      }))));
    if (!result.succeeded || !result.outputValidated || !result.outputProbe) {
      await recordFailure(ctx, job, publicRenderFailure(result.problems), "render_output", result.problems.join(" "), claimed);
      return;
    }
    const size = await storage.importLocalFile(storageKey, outputPath);
    stored = true;
    const checked = await storage.runWithCommittedFile(storageKey, (filePath) => probeVideo(filePath));
    if (checked.width !== result.outputProbe.width || checked.height !== result.outputProbe.height || checked.videoCodec !== "h264") {
      await recordFailure(ctx, job, "The rendered file could not be checked, so it was not saved.", "render_output_check", "output could not be probed", claimed); return;
    }
    const plan = getPlan(await ctx.repo.getPlanIdForUser(job.ownerId, ctx.now));
    const saved = await ctx.repo.saveRenderOutput({ id: outputId, sourceMediaId: job.sourceMediaId, ownerId: job.ownerId, storageKey, sizeBytes: size, settingsHash: spec.settingsHash, createdAt: new Date() }, plan.limits.storageBytes, fence);
    if (saved.status === "stale_job") { job.status = "failed"; job.message = "This render attempt was superseded. No output from it was saved."; return; }
    if (saved.status === "over_quota") { await recordFailure(ctx, job, "This export would pass your storage limit. It was not saved.", "render_storage_quota", "storage quota exceeded", claimed); return; }
    if (saved.status === "duplicate") { await storage.deleteUnreferencedUpload(storageKey); stored = false; }
    if (saved.status === "saved") stored = false; // the file is now referenced by MediaDerivative and must not be cleaned up
    const kept = await ctx.repo.getRenderOutput(saved.id);
    const confirmed = kept ? await storage.statSize(kept.storageKey) : null;
    if (!kept || confirmed !== kept.sizeBytes) { await recordFailure(ctx, job, "The rendered file could not be checked, so it was not saved.", "render_output_check", "output size mismatch", claimed); return; }
    if (saved.status === "saved") await ctx.repo.addUsageRecords(buildRenderUsage({ consumerId: job.ownerId, renderJobId: saved.id, succeeded: true, outputValidated: true, processingSeconds: result.processingSeconds, outputSizeBytes: size, now: ctx.now }));
    if (!(await ctx.repo.completeRenderJob(job.id, job.ownerId, fence.lockToken, new Date(), saved.id))) { job.status = "failed"; job.message = "This render attempt was superseded. The saved file remains available in exports."; return; }
    job.status = "completed";
    job.outputId = saved.id;
    job.message = null;
    await ctx.repo.appendAudit({ actorId: job.ownerId, action: "render.completed", entityType: "MediaDerivative", entityId: saved.id, metadata: { sourceMediaId: job.sourceMediaId, aspect: spec.settings.aspect } });
  } catch (error) {
    await recordFailure(ctx, job, failureMessage(error), "render_exception", error instanceof Error ? error.message : "unknown", claimed);
  } finally {
    if (job.status !== "completed" && stored) await storage.deleteUnreferencedUpload(storageKey).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    clearInterval(heartbeat);
    prepared.delete(job);
  }
}

export async function runExportJob(job: RenderJob): Promise<void> {
  const held = prepared.get(job);
  if (!held) { job.status = "failed"; job.message = "Rendering failed before a finished file was saved. The original video was not changed."; return; }
  const claimed = await held.ctx.repo.claimNextRenderJob({ workerId: `render-${randomUUID()}`, now: new Date(), leaseSeconds: 90, jobId: job.id });
  if (!claimed?.lockToken) { job.status = "failed"; job.message = "This render is already being handled or is no longer available."; return; }
  await runClaimedRenderJob(job, claimed);
}

async function ownImage(ctx: RequestContext, userId: string, mediaId: string, label: string): Promise<string> {
  const image = await ctx.repo.getMedia(mediaId);
  if (!image || image.ownerId !== userId || image.status !== "active" || image.kind !== "image") throw validationFailed([`${label} must be one of your own images.`]);
  const info = await ctx.repo.getMediaStorageInfo(image.id);
  if (!info?.storageKey) throw validationFailed([`${label} file is missing.`]);
  return info.storageKey;
}

/** Claims and executes one durable render row. A separate worker process can call this after a web-process restart. */
export async function runNextPersistedRenderJob(ctx: RequestContext, workerId: string, runner: ExportRunner = ffmpegExportRunner): Promise<"idle" | "processed"> {
  const claimed = await ctx.repo.claimNextRenderJob({ workerId, now: new Date(), leaseSeconds: 90 });
  if (!claimed) return "idle";
  if (!claimed.lockToken || !claimed.mediaAssetId) return "processed";
  const failInvalid = async (message: string) => { await ctx.repo.failRenderJob(claimed.id, claimed.ownerId, claimed.lockToken!, new Date(), message); };
  const payload = typeof claimed.payload === "object" && claimed.payload !== null && !Array.isArray(claimed.payload) ? claimed.payload as Record<string, unknown> : null;
  const parsed = parseEditingSettings(payload?.["editingSettings"]);
  const maxResolution = payload?.["maxResolution"];
  if (payload?.["version"] !== 1 || !parsed.ok || (maxResolution !== "720p" && maxResolution !== "1080p" && maxResolution !== "original")) {
    await failInvalid("This saved render request could not be safely recovered. Submit it again from the editor."); return "processed";
  }
  const media = await ctx.repo.getMedia(claimed.mediaAssetId);
  if (!media || media.status !== "active" || (media.kind ?? "video") !== "video" || sourceRenderProblems(media).length > 0) {
    await failInvalid("The source video is no longer available for rendering."); return "processed";
  }
  const trimProblems = trimDurationProblems(parsed.settings.trim, (media.durationMs ?? 0) / 1000);
  if (trimProblems.length > 0) { await failInvalid(trimProblems[0]!); return "processed"; }
  const collections = media.ownerId === claimed.ownerId ? [] : await ctx.repo.listCollectionsContainingMedia(media.id);
  const containing = await Promise.all(collections.map(async (collection) => ({ collection, grants: await ctx.repo.getGrants(collection.id) })));
  if (!decideCanRenderSource({ userId: claimed.ownerId, media, containing, now: new Date() }).allowed) {
    await failInvalid("Access to the source video is no longer available."); return "processed";
  }
  const info = await ctx.repo.getMediaStorageInfo(media.id);
  if (!info?.storageKey) { await failInvalid("The source video file is missing."); return "processed"; }
  const plan = getPlan(await ctx.repo.getPlanIdForUser(claimed.ownerId, new Date()));
  if (plan.features.maxResolution !== maxResolution) { await failInvalid("Your plan changed before rendering. Submit the export again to apply current limits."); return "processed"; }
  const settings = parsed.settings;
  let logoKey: string | null = null, backgroundKey: string | null = null;
  try {
    if (settings.logo) logoKey = await ownImage(ctx, claimed.ownerId, settings.logo.mediaId, "The logo");
    if (settings.background.kind === "image") backgroundKey = await ownImage(ctx, claimed.ownerId, settings.background.mediaId, "The background image");
  } catch {
    await failInvalid("A logo or background image is no longer available."); return "processed";
  }
  const renderSettings = toRenderSettings(settings, maxResolution as MaxResolution);
  const settingsHash = hashExportSettings(media.id, renderSettings, settings.logo?.mediaId ?? null, settings.background.kind === "image" ? settings.background.mediaId : null);
  if (settingsHash !== claimed.settingsHash) { await failInvalid("The saved render settings failed validation. Submit the export again."); return "processed"; }
  if (!ctx.media || ctx.media.unavailable) { await failInvalid("The private media folder is not available. Nothing was rendered."); return "processed"; }
  const job: RenderJob = { id: claimed.id, ownerId: claimed.ownerId, sourceMediaId: media.id, status: "processing", message: null, outputId: null, userLimit: plan.limits.concurrentJobs };
  prepared.set(job, { ctx, runner, record: claimed, export: { sourceKey: info.storageKey, logoKey, backgroundKey, settings: renderSettings, settingsHash, logoMediaId: settings.logo?.mediaId ?? null, backgroundMediaId: settings.background.kind === "image" ? settings.background.mediaId : null } });
  await runClaimedRenderJob(job, claimed);
  return "processed";
}

export async function startExport(ctx: RequestContext, rawInput: unknown, runner: ExportRunner = ffmpegExportRunner): Promise<{ jobId: string }> {
  const userId = requireUser(ctx);
  if (!ctx.renders) throw new AppError(503, "not_configured", "Rendering is not available in this build.");
  if (!ctx.media || ctx.media.unavailable) throw new AppError(503, "storage_unavailable", "The private media folder is not available. Nothing was rendered.");
  if (typeof rawInput !== "object" || rawInput === null) throw validationFailed(["The render request is not valid."]);
  const input = rawInput as Record<string, unknown>;
  const mediaId = input["mediaId"];
  if (typeof mediaId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) throw validationFailed(["Choose a video."]);
  let settingsInput = input["settings"];
  if (typeof input["templateId"] === "string" && input["templateId"] !== "" && input["useTemplate"] === true) {
    const templates = await ctx.repo.listTemplatesForOwner(userId);
    const template = templates.find((item) => item.id === input["templateId"]);
    if (!template) throw validationFailed(["That template was not found."]);
    settingsInput = template.settings;
  }
  const parsed = parseEditingSettings(settingsInput);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  const settings: EditingSettings = parsed.settings;

  const media = await ctx.repo.getMedia(mediaId);
  if (!media) throw notFound("Video");
  const collections = media.ownerId === userId ? [] : await ctx.repo.listCollectionsContainingMedia(media.id);
  const containing = await Promise.all(collections.map(async (collection) => ({ collection, grants: await ctx.repo.getGrants(collection.id) })));
  if (!decideCanRenderSource({ userId, media, containing, now: ctx.now }).allowed) throw notFound("Video");
  const sourceProblems = sourceRenderProblems(media);
  if (sourceProblems.length > 0) throw validationFailed(sourceProblems);
  const trimProblems = trimDurationProblems(settings.trim, (media.durationMs ?? 0) / 1000);
  if (trimProblems.length > 0) throw validationFailed(trimProblems);
  const durationSeconds = (media.durationMs ?? 0) / 1000;
  const normalizedSettings = settings.trim.startSeconds === 0 && settings.trim.endSeconds === durationSeconds
    ? { ...settings, trim: { startSeconds: 0, endSeconds: null } }
    : settings;
  const info = await ctx.repo.getMediaStorageInfo(media.id);
  if (!info?.storageKey) throw notFound("Video");

  let logoKey: string | null = null;
  if (settings.logo) logoKey = await ownImage(ctx, userId, settings.logo.mediaId, "The logo");
  let backgroundKey: string | null = null;
  if (settings.background.kind === "image") backgroundKey = await ownImage(ctx, userId, settings.background.mediaId, "The background image");
  const plan = getPlan(await ctx.repo.getPlanIdForUser(userId, ctx.now));
  const renderSettings = toRenderSettings(normalizedSettings, plan.features.maxResolution);
  const spec: PreparedExport = {
    sourceKey: info.storageKey, logoKey, backgroundKey, settings: renderSettings,
    settingsHash: hashExportSettings(media.id, renderSettings, settings.logo?.mediaId ?? null, settings.background.kind === "image" ? settings.background.mediaId : null),
    logoMediaId: settings.logo?.mediaId ?? null, backgroundMediaId: settings.background.kind === "image" ? settings.background.mediaId : null,
  };
  const idempotencyKey = `render:${userId}:${media.id}:${spec.settingsHash}`;
  const payload = { version: 1, editingSettings: persistedEditingSettings(normalizedSettings), maxResolution: plan.features.maxResolution };
  const resumeRecord = (record: RenderJobRecord): string => {
    const inProcess = ctx.renders!.jobs.get(record.id);
    if (inProcess && (inProcess.status === "queued" || inProcess.status === "processing")) return inProcess.id;
    const stale = record.status === "running" && record.lockExpiresAt !== null && record.lockExpiresAt <= new Date();
    if (record.status === "queued" || stale) {
      const job: RenderJob = { id: record.id, ownerId: userId, sourceMediaId: media.id, status: "queued", message: null, outputId: null, userLimit: plan.limits.concurrentJobs };
      prepared.set(job, { ctx, export: spec, runner, record });
      ctx.renders!.enqueue(job);
    }
    return record.id;
  };
  const existing = await ctx.repo.getRenderJobByIdempotencyKey(idempotencyKey, userId);
  if (existing) {
    if (existing.mediaAssetId !== media.id || existing.settingsHash !== spec.settingsHash || stableJson(existing.payload) !== stableJson(payload)) throw conflict("A render request with this key has different settings.");
    return { jobId: resumeRecord(existing) };
  }

  const usedExports = await ctx.repo.countRenderOutputsSince(userId, monthStartUtc(ctx.now));
  const persistedJobs = await ctx.repo.listRenderJobsForOwner(userId);
  const inFlight = persistedJobs.filter((job) => job.status === "queued" || (job.status === "running" && job.lockExpiresAt !== null && job.lockExpiresAt > new Date())).length;
  if (usedExports + inFlight >= plan.limits.exportsPerMonth) throw planLimit(`Your plan allows ${plan.limits.exportsPerMonth} exports this month.`);
  const month = await ctx.repo.getMonthlyUsage(userId, monthStartUtc(ctx.now));
  if (month.processingSeconds + Math.ceil((media.durationMs ?? 0) / 1000) > plan.limits.processingMinutesPerMonth * 60) throw planLimit("Your plan's processing time for this month is used up.");
  if (media.ownerId === userId) await ctx.repo.saveVideoSettings({ id: ctx.newId(), ownerId: userId, name: videoSettingsName(media.id), settings, createdAt: ctx.now });
  const id = ctx.newId();
  const record: RenderJobRecord = {
    id, ownerId: userId, kind: "render", status: "queued", cycleItemId: null, mediaAssetId: media.id, progressPercent: 0, attempts: 0,
    idempotencyKey, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: ctx.now, finishedAt: null, settingsHash: spec.settingsHash,
    payload, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
  };
  const created = await ctx.repo.createRenderJob(record);
  if (created.status === "conflict") throw conflict("This render request conflicts with an existing job.");
  if (created.status === "existing") return { jobId: resumeRecord(created.job) };
  const job: RenderJob = { id, ownerId: userId, sourceMediaId: media.id, status: "queued", message: null, outputId: null, userLimit: plan.limits.concurrentJobs };
  prepared.set(job, { ctx, export: spec, runner, record: created.job });
  ctx.renders.enqueue(job);
  return { jobId: id };
}

export function createRenderScheduler(processLimit = RENDER_PROCESS_LIMIT): RenderScheduler {
  return new RenderScheduler(processLimit, runExportJob);
}
