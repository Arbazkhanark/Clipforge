// Bulk style changes and bulk renders. Original files are never written. Each video keeps the settings that were not ticked.
import { getPlan } from "../../lib/billing/catalog.ts";
import { applySettingsPatch, checkedPatch, parseBulkForm, samplePreviewSettings, type SettingsPatch } from "../../lib/domain/bulk-edit.ts";
import { DEFAULT_EDITING_SETTINGS, parseEditingSettings, videoSettingsName, type EditingSettings } from "../../lib/domain/editing-settings.ts";
import { sourceRenderProblems } from "../../lib/render/render-limits.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, notFound, planLimit, validationFailed } from "../errors.ts";
import type { EditingTemplateRecord } from "../repository.ts";
import { startExport, type ExportRunner, type RenderJob } from "../render/export-service.ts";

export interface BulkVideoPlan { mediaId: string; title: string; notes: string[]; after: EditingSettings; }
export interface BulkSkip { reason: string; }
export interface BulkDraft {
  id: string;
  ownerId: string;
  patch: SettingsPatch;
  lines: string[];
  videos: BulkVideoPlan[];
  skipped: BulkSkip[];
  applied: boolean;
}
export interface RenderBatchItem { mediaId: string; title: string; jobId: string | null; refused: string | null; }
export interface RenderBatch { id: string; ownerId: string; key: string; items: RenderBatchItem[]; }

type BulkMemory = { drafts: Map<string, BulkDraft>; batches: Map<string, RenderBatch>; batchByKey: Map<string, string> };
const holder = globalThis as typeof globalThis & { __clipforgeBulk?: BulkMemory };
holder.__clipforgeBulk ??= { drafts: new Map(), batches: new Map(), batchByKey: new Map() };
const memory: BulkMemory = holder.__clipforgeBulk;
const drafts = memory.drafts;
const batches = memory.batches;
const batchByKey = memory.batchByKey;

export function clearBulkStateForTests(): void { drafts.clear(); batches.clear(); batchByKey.clear(); }
export function getBulkDraft(id: string): BulkDraft | undefined { return drafts.get(id); }
export function getRenderBatch(id: string): RenderBatch | undefined { return batches.get(id); }

function savedFrom(templates: EditingTemplateRecord[], mediaId: string): EditingSettings {
  const row = templates.find((template) => template.name === videoSettingsName(mediaId));
  if (!row) return DEFAULT_EDITING_SETTINGS;
  const parsed = parseEditingSettings(row.settings);
  return parsed.ok ? parsed.settings : DEFAULT_EDITING_SETTINGS;
}

async function classify(ctx: RequestContext, userId: string, mediaIds: string[], patch: SettingsPatch): Promise<{ videos: BulkVideoPlan[]; skipped: BulkSkip[] }> {
  const templates = await ctx.repo.listTemplatesForOwner(userId);
  const videos: BulkVideoPlan[] = [];
  const skipped: BulkSkip[] = [];
  for (const mediaId of mediaIds) {
    const media = await ctx.repo.getMedia(mediaId);
    if (!media || media.ownerId !== userId || media.status === "deleted") { skipped.push({ reason: "Not available" }); continue; }
    if ((media.kind ?? "video") !== "video") { skipped.push({ reason: `${media.title ?? "An image"} is an image, so it cannot take video settings.` }); continue; }
    const merged = checkedPatch(savedFrom(templates, media.id), patch);
    if (!merged.ok) throw validationFailed(merged.problems);
    videos.push({ mediaId: media.id, title: media.title ?? "Untitled", notes: merged.notes, after: merged.settings });
  }
  return { videos, skipped };
}

export async function reviewBulkEdit(ctx: RequestContext, rawInput: unknown): Promise<{ draftId: string }> {
  const userId = requireUser(ctx);
  const parsed = readBulk(rawInput);
  const plan = getPlan(await ctx.repo.getPlanIdForUser(userId));
  const { videos, skipped } = await classify(ctx, userId, parsed.mediaIds, parsed.patch);
  if (videos.length > plan.limits.batchSize) throw planLimit(`Your plan can edit ${plan.limits.batchSize} videos at a time. You selected ${videos.length}. Nothing was changed.`);
  if (videos.length === 0) throw validationFailed(["None of the selected items can be edited."]);
  const draft: BulkDraft = { id: ctx.newId(), ownerId: userId, patch: parsed.patch, lines: parsed.lines, videos, skipped, applied: false };
  drafts.set(draft.id, draft);
  return { draftId: draft.id };
}

export async function applyBulkEdit(ctx: RequestContext, rawInput: unknown): Promise<{ draftId: string; updated: number; skipped: number }> {
  const userId = requireUser(ctx);
  const draftId = readId(rawInput, "draftId");
  const draft = drafts.get(draftId);
  if (!draft || draft.ownerId !== userId) throw notFound("Bulk edit");
  if (draft.applied) return { draftId, updated: draft.videos.length, skipped: draft.skipped.length };
  for (const video of draft.videos) {
    const media = await ctx.repo.getMedia(video.mediaId);
    if (!media || media.ownerId !== userId || media.status !== "active" || (media.kind ?? "video") !== "video") throw notFound("Video");
    await ctx.repo.saveVideoSettings({ id: ctx.newId(), ownerId: userId, name: videoSettingsName(video.mediaId), settings: video.after, createdAt: ctx.now });
  }
  draft.applied = true;
  await ctx.repo.appendAudit({ actorId: userId, action: "editor.bulk_applied", entityType: "User", entityId: userId, metadata: { updated: draft.videos.length, skipped: draft.skipped.length, fields: draft.lines } });
  return { draftId, updated: draft.videos.length, skipped: draft.skipped.length };
}

export async function startBulkRender(ctx: RequestContext, rawInput: unknown, runner?: ExportRunner): Promise<{ batchId: string }> {
  const userId = requireUser(ctx);
  const draftId = readId(rawInput, "draftId");
  const draft = drafts.get(draftId);
  if (!draft || draft.ownerId !== userId || !draft.applied) throw notFound("Bulk edit");
  const key = `${userId}:${draft.videos.map((video) => video.mediaId).sort().join(",")}`;
  const existingId = batchByKey.get(key);
  const existing = existingId ? batches.get(existingId) : undefined;
  if (existing && existing.ownerId === userId) return { batchId: existing.id };
  const templates = await ctx.repo.listTemplatesForOwner(userId);
  const items: RenderBatchItem[] = [];
  for (const video of draft.videos) {
    const media = await ctx.repo.getMedia(video.mediaId);
    if (!media || media.ownerId !== userId || media.status !== "active" || (media.kind ?? "video") !== "video") {
      items.push({ mediaId: video.mediaId, title: video.title, jobId: null, refused: "Not available" });
      continue;
    }
    const problems = sourceRenderProblems(media);
    if (problems.length > 0) { items.push({ mediaId: video.mediaId, title: video.title, jobId: null, refused: problems[0]! }); continue; }
    try {
      const started = await startExport(ctx, { mediaId: video.mediaId, settings: savedFrom(templates, video.mediaId) }, runner);
      items.push({ mediaId: video.mediaId, title: video.title, jobId: started.jobId, refused: null });
    } catch (error) {
      items.push({ mediaId: video.mediaId, title: video.title, jobId: null, refused: safeError(error) });
    }
  }
  const batch: RenderBatch = { id: ctx.newId(), ownerId: userId, key, items };
  batches.set(batch.id, batch);
  batchByKey.set(key, batch.id);
  return { batchId: batch.id };
}

export function batchJobs(ctx: RequestContext, batch: RenderBatch): { title: string; mediaId: string; status: RenderJob["status"] | "refused"; message: string | null; outputId: string | null }[] {
  return batch.items.map((item) => {
    if (!item.jobId) return { title: item.title, mediaId: item.mediaId, status: "refused" as const, message: item.refused, outputId: null };
    const job = ctx.renders?.jobs.get(item.jobId);
    if (!job || job.ownerId !== batch.ownerId) return { title: item.title, mediaId: item.mediaId, status: "refused" as const, message: "That render is not available.", outputId: null };
    return { title: item.title, mediaId: item.mediaId, status: job.status, message: job.message, outputId: job.outputId };
  });
}

function readBulk(rawInput: unknown): { mediaIds: string[]; patch: SettingsPatch; lines: string[] } {
  if (typeof rawInput !== "object" || rawInput === null) throw validationFailed(["The bulk edit is not valid."]);
  const input = rawInput as Record<string, unknown>;
  const get = (key: string): string | undefined => typeof input[key] === "string" ? input[key] : undefined;
  const getAll = (key: string): string[] => Array.isArray(input[key]) ? (input[key] as unknown[]).filter((value): value is string => typeof value === "string") : get(key) ? [get(key)!] : [];
  const parsed = parseBulkForm(get, getAll);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  return parsed;
}

function safeError(error: unknown): string {
  if (error instanceof AppError) {
    const details = error.details as { errors?: unknown } | undefined;
    if (details && Array.isArray(details.errors) && details.errors.every((item) => typeof item === "string")) return details.errors.join(" ");
    return error.message;
  }
  return "This video was not rendered.";
}

function readId(rawInput: unknown, key: string): string {
  if (typeof rawInput !== "object" || rawInput === null) throw validationFailed(["The request is not valid."]);
  const value = (rawInput as Record<string, unknown>)[key];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw validationFailed(["That edit could not be found."]);
  return value;
}

export { applySettingsPatch, samplePreviewSettings };
