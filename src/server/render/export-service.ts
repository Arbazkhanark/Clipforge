// Starts a render and returns immediately. FFmpeg runs in a child process afterwards, so the web
// request is not held open. A job is marked completed only after the output file is checked and stored.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPlan } from "../../lib/billing/catalog.ts";
import { parseEditingSettings, toRenderSettings, videoSettingsName, type EditingSettings } from "../../lib/domain/editing-settings.ts";
import { decideCanRenderSource } from "../../lib/domain/render-access.ts";
import { buildRenderUsage, monthStartUtc } from "../../lib/domain/usage-accounting.ts";
import { renderVideo, probeVideo, type RenderResult } from "../../lib/render/render-runner.ts";
import { publicRenderFailure, renderDiagnostic } from "../../lib/render/render-errors.ts";
import { hashExportSettings, MAX_RENDER_MS, RENDER_PROCESS_LIMIT, sourceRenderProblems } from "../../lib/render/render-limits.ts";
import type { RenderSettings } from "../../lib/render/ffmpeg-command.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, notFound, planLimit, validationFailed } from "../errors.ts";
import { renderKeyFor, type MediaStorage } from "../storage/media-storage.ts";

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

const prepared = ((globalThis as typeof globalThis & { __clipforgePreparedExports?: WeakMap<RenderJob, { ctx: RequestContext; export: PreparedExport; runner: ExportRunner }> }).__clipforgePreparedExports ??= new WeakMap());

function failureMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT") return "FFmpeg is not available on this server. No export was saved.";
  return publicRenderFailure([error instanceof Error ? error.message : ""]);
}

async function recordFailure(ctx: RequestContext, job: RenderJob, message: string, category: string, detail: string): Promise<void> {
  job.status = "failed";
  job.message = message;
  console.error("render failed", category);
  await ctx.repo.appendAudit({ actorId: job.ownerId, action: "render.failed", entityType: "MediaAsset", entityId: job.sourceMediaId, metadata: { category, detail: renderDiagnostic([detail]) } }).catch(() => undefined);
}

async function withFile<T>(storage: MediaStorage, key: string | null, work: (filePath: string | undefined) => Promise<T>): Promise<T> {
  if (!key) return work(undefined);
  return storage.runWithCommittedFile(key, (filePath) => work(filePath));
}

export async function runExportJob(job: RenderJob): Promise<void> {
  const held = prepared.get(job);
  if (!held) { job.status = "failed"; job.message = "Rendering failed before a finished file was saved. The original video was not changed."; return; }
  const { ctx, export: spec, runner } = held;
  const storage = ctx.media?.storage;
  if (!storage || ctx.media?.unavailable) { job.status = "failed"; job.message = "The private media folder is not available. Nothing was rendered."; return; }
  const dir = await mkdtemp(path.join(tmpdir(), "clipforge-render-"));
  const outputPath = path.join(dir, "output.mp4");
  const outputId = ctx.newId();
  const storageKey = renderKeyFor(job.ownerId, outputId);
  let stored = false;
  try {
    const existing = await ctx.repo.findRenderOutput(job.ownerId, job.sourceMediaId, spec.settingsHash);
    if (existing) {
      const info = await ctx.repo.getRenderOutput(existing.id);
      const size = info ? await storage.statSize(info.storageKey) : null;
      if (info && size === info.sizeBytes) { job.status = "completed"; job.outputId = existing.id; job.message = "This export was already rendered."; return; }
      job.status = "failed"; job.message = "An earlier export for these settings is missing its file."; return;
    }
    const result = await withFile(storage, spec.backgroundKey, (backgroundImagePath) => withFile(storage, spec.logoKey, (logoPath) =>
      storage.runWithCommittedFile(spec.sourceKey, (inputPath) => runner.render({
        inputPath, outputPath, settings: spec.settings,
        ...(logoPath ? { logoPath } : {}), ...(backgroundImagePath ? { backgroundImagePath } : {}),
      }))));
    if (!result.succeeded || !result.outputValidated || !result.outputProbe) {
      await recordFailure(ctx, job, publicRenderFailure(result.problems), "render_output", result.problems.join(" "));
      return;
    }
    const size = await storage.importLocalFile(storageKey, outputPath);
    stored = true;
    const checked = await storage.runWithCommittedFile(storageKey, (filePath) => probeVideo(filePath));
    if (checked.width !== result.outputProbe.width || checked.height !== result.outputProbe.height || checked.videoCodec !== "h264") {
      job.status = "failed"; job.message = "The rendered file could not be checked, so it was not saved."; return;
    }
    const plan = getPlan(await ctx.repo.getPlanIdForUser(job.ownerId));
    const saved = await ctx.repo.saveRenderOutput({ id: outputId, sourceMediaId: job.sourceMediaId, ownerId: job.ownerId, storageKey, sizeBytes: size, settingsHash: spec.settingsHash, createdAt: ctx.now }, plan.limits.storageBytes);
    if (saved.status === "over_quota") { job.status = "failed"; job.message = "This export would pass your storage limit. It was not saved."; return; }
    if (saved.status === "duplicate") { await storage.deleteUnreferencedUpload(storageKey); stored = false; }
    const kept = await ctx.repo.getRenderOutput(saved.id);
    const confirmed = kept ? await storage.statSize(kept.storageKey) : null;
    if (!kept || confirmed !== kept.sizeBytes) { job.status = "failed"; job.message = "The rendered file could not be checked, so it was not saved."; return; }
    if (saved.status === "saved") await ctx.repo.addUsageRecords(buildRenderUsage({ consumerId: job.ownerId, renderJobId: saved.id, succeeded: true, outputValidated: true, processingSeconds: result.processingSeconds, outputSizeBytes: size, now: ctx.now }));
    job.status = "completed";
    job.outputId = saved.id;
    job.message = null;
    await ctx.repo.appendAudit({ actorId: job.ownerId, action: "render.completed", entityType: "MediaDerivative", entityId: saved.id, metadata: { sourceMediaId: job.sourceMediaId, aspect: spec.settings.aspect } });
  } catch (error) {
    await recordFailure(ctx, job, failureMessage(error), "render_exception", error instanceof Error ? error.message : "unknown");
  } finally {
    if (job.status !== "completed" && stored) await storage.deleteUnreferencedUpload(storageKey).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    prepared.delete(job);
  }
}

async function ownImage(ctx: RequestContext, userId: string, mediaId: string, label: string): Promise<string> {
  const image = await ctx.repo.getMedia(mediaId);
  if (!image || image.ownerId !== userId || image.status !== "active" || image.kind !== "image") throw validationFailed([`${label} must be one of your own images.`]);
  const info = await ctx.repo.getMediaStorageInfo(image.id);
  if (!info?.storageKey) throw validationFailed([`${label} file is missing.`]);
  return info.storageKey;
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
  const info = await ctx.repo.getMediaStorageInfo(media.id);
  if (!info?.storageKey) throw notFound("Video");

  const plan = getPlan(await ctx.repo.getPlanIdForUser(userId));
  const usedExports = await ctx.repo.countRenderOutputsSince(userId, monthStartUtc(ctx.now));
  const inFlight = [...ctx.renders.jobs.values()].filter((job) => job.ownerId === userId && (job.status === "queued" || job.status === "processing")).length;
  if (usedExports + inFlight >= plan.limits.exportsPerMonth) throw planLimit(`Your plan allows ${plan.limits.exportsPerMonth} exports this month.`);
  const month = await ctx.repo.getMonthlyUsage(userId, monthStartUtc(ctx.now));
  if (month.processingSeconds + Math.ceil((media.durationMs ?? 0) / 1000) > plan.limits.processingMinutesPerMonth * 60) throw planLimit("Your plan's processing time for this month is used up.");

  let logoKey: string | null = null;
  if (settings.logo) logoKey = await ownImage(ctx, userId, settings.logo.mediaId, "The logo");
  let backgroundKey: string | null = null;
  if (settings.background.kind === "image") backgroundKey = await ownImage(ctx, userId, settings.background.mediaId, "The background image");
  if (media.ownerId === userId) await ctx.repo.saveVideoSettings({ id: ctx.newId(), ownerId: userId, name: videoSettingsName(media.id), settings, createdAt: ctx.now });
  const renderSettings = toRenderSettings(settings, plan.features.maxResolution);
  const spec: PreparedExport = {
    sourceKey: info.storageKey, logoKey, backgroundKey, settings: renderSettings,
    settingsHash: hashExportSettings(media.id, renderSettings, settings.logo?.mediaId ?? null, settings.background.kind === "image" ? settings.background.mediaId : null),
    logoMediaId: settings.logo?.mediaId ?? null, backgroundMediaId: settings.background.kind === "image" ? settings.background.mediaId : null,
  };
  const job: RenderJob = { id: ctx.newId(), ownerId: userId, sourceMediaId: media.id, status: "queued", message: null, outputId: null, userLimit: plan.limits.concurrentJobs };
  prepared.set(job, { ctx, export: spec, runner });
  ctx.renders.enqueue(job);
  return { jobId: job.id };
}

export function createRenderScheduler(processLimit = RENDER_PROCESS_LIMIT): RenderScheduler {
  return new RenderScheduler(processLimit, runExportJob);
}
