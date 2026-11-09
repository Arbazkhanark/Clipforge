// Bulk style changes and bulk renders. Original files are never written. Each video keeps the settings that were not ticked.
import { createHash } from "node:crypto";
import { getPlan } from "../../lib/billing/catalog.ts";
import { applySettingsPatch, checkedPatch, parseBulkForm, samplePreviewSettings, type SettingsPatch } from "../../lib/domain/bulk-edit.ts";
import { DEFAULT_EDITING_SETTINGS, parseEditingSettings, videoSettingsName, type EditingSettings } from "../../lib/domain/editing-settings.ts";
import { sourceRenderProblems } from "../../lib/render/render-limits.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, notFound, planLimit, validationFailed } from "../errors.ts";
import type { EditingTemplateRecord } from "../repository.ts";
import { startExport, type ExportRunner, type RenderJob } from "../render/export-service.ts";

export interface BulkVideoPlan { mediaId: string; title: string; notes: string[]; before: EditingSettings | null; after: EditingSettings; applyStatus: "pending" | "applied" | "failed"; }
export interface BulkSkip { reason: string; }
export interface BulkDraft {
  id: string;
  ownerId: string;
  patch: SettingsPatch;
  lines: string[];
  videos: BulkVideoPlan[];
  skipped: BulkSkip[];
  applied: boolean;
  applyError?: string;
  styleName?: string;
  copyTemplateTrim: boolean;
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
    if (!media || media.ownerId !== userId || media.status !== "active") throw notFound("Selected video");
    if ((media.kind ?? "video") !== "video") throw validationFailed(["Every selected item must be an active video."]);
    const savedRow = templates.find((template) => template.name === videoSettingsName(media.id));
    const beforeParsed = savedRow ? parseEditingSettings(savedRow.settings) : null;
    if (beforeParsed && !beforeParsed.ok) throw validationFailed(["A selected video's saved settings are invalid. Open it in the editor and save valid settings first."]);
    const before = beforeParsed?.ok ? beforeParsed.settings : null;
    const merged = checkedPatch(before ?? DEFAULT_EDITING_SETTINGS, patch);
    if (!merged.ok) throw validationFailed(merged.problems);
    if (merged.settings.logo) {
      const image = await ctx.repo.getMedia(merged.settings.logo.mediaId);
      if (!image || image.ownerId !== userId || image.status !== "active" || image.kind !== "image") throw validationFailed(["The style's logo must be one of your active images."]);
    }
    if (merged.settings.background.kind === "image") {
      const image = await ctx.repo.getMedia(merged.settings.background.mediaId);
      if (!image || image.ownerId !== userId || image.status !== "active" || image.kind !== "image") throw validationFailed(["The style's background must be one of your active images."]);
    }
    videos.push({ mediaId: media.id, title: media.title ?? "Untitled", notes: merged.notes, before, after: merged.settings, applyStatus: "pending" });
  }
  return { videos, skipped };
}

export async function reviewBulkEdit(ctx: RequestContext, rawInput: unknown): Promise<{ draftId: string }> {
  const userId = requireUser(ctx);
  const parsed = readBulk(rawInput);
  let patch = parsed.patch;
  let styleName: string | undefined;
  if (parsed.styleTemplateId) {
    const style = (await ctx.repo.listTemplatesForOwner(userId)).find((template) => template.id === parsed.styleTemplateId && !template.name.startsWith("v:"));
    if (!style) throw notFound("Saved style");
    const validStyle = parseEditingSettings(style.settings);
    if (!validStyle.ok) throw validationFailed(["That saved style is invalid and cannot be applied."]);
    styleName = style.name;
    patch = patchFromStyle(validStyle.settings, parsed.copyTemplateTrim);
    parsed.lines = [`Saved style: ${style.name}`, parsed.copyTemplateTrim ? "Trim range: copied from the style" : "Trim range: preserved for each video"];
  }
  const plan = getPlan(await ctx.repo.getPlanIdForUser(userId, ctx.now));
  const { videos, skipped } = await classify(ctx, userId, parsed.mediaIds, patch);
  if (videos.length > plan.limits.batchSize) throw planLimit(`Your plan can edit ${plan.limits.batchSize} videos at a time. You selected ${videos.length}. Nothing was changed.`);
  if (videos.length === 0) throw validationFailed(["None of the selected items can be edited."]);
  const draft: BulkDraft = { id: ctx.newId(), ownerId: userId, patch, lines: parsed.lines, videos, skipped, applied: false, ...(styleName ? { styleName } : {}), copyTemplateTrim: parsed.copyTemplateTrim };
  drafts.set(draft.id, draft);
  return { draftId: draft.id };
}

export async function applyBulkEdit(ctx: RequestContext, rawInput: unknown): Promise<{ draftId: string; updated: number; skipped: number }> {
  const userId = requireUser(ctx);
  const draftId = readId(rawInput, "draftId");
  const draft = drafts.get(draftId);
  if (!draft || draft.ownerId !== userId) throw notFound("Bulk edit");
  if (draft.applied) return { draftId, updated: draft.videos.length, skipped: draft.skipped.length };
  // A reviewed draft is not a reservation of its original plan allowance. Promotions may
  // expire or be revoked between review and application, so authorize the write at commit time.
  const currentPlanId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const currentBatchLimit = getPlan(currentPlanId).limits.batchSize;
  if (draft.videos.length > currentBatchLimit) {
    draft.applyError = `Your current plan can edit ${currentBatchLimit} videos at a time. No settings were changed.`;
    draft.videos.forEach((video) => { video.applyStatus = "failed"; });
    throw planLimit(`Your current plan can edit ${currentBatchLimit} videos at a time. This draft contains ${draft.videos.length}. Nothing was changed.`);
  }
  const templates = draft.videos.map((video) => ({ id: ctx.newId(), ownerId: userId, name: videoSettingsName(video.mediaId), settings: video.after, createdAt: ctx.now }));
  const operationFingerprint = createHash("sha256").update(JSON.stringify({ ownerId: userId, videos: [...draft.videos].sort((a, b) => a.mediaId.localeCompare(b.mediaId)).map((video) => [video.mediaId, video.before, video.after]) })).digest("hex");
  const requiredImageIds = [...new Set(draft.videos.flatMap((video) => [video.after.logo?.mediaId, video.after.background.kind === "image" ? video.after.background.mediaId : undefined].filter((id): id is string => Boolean(id))))];
  try {
    const result = await ctx.repo.applyVideoSettingsBatch({ ownerId: userId, operationId: draft.id, operationFingerprint, templates, expectedSettings: draft.videos.map((video) => ({ name: videoSettingsName(video.mediaId), settings: video.before })), requiredImageIds, audit: { actorId: userId, action: "editor.bulk_applied", entityType: "BulkEditDraft", entityId: draft.id, metadata: { operationFingerprint, updated: draft.videos.length, fields: draft.lines } } });
    if (result === "not_owned") throw notFound("Selected video");
    if (result === "conflict") throw conflict("This bulk edit conflicts with an earlier operation. Review the videos and try again.");
    draft.applied = true; draft.applyError = undefined; draft.videos.forEach((video) => { video.applyStatus = "applied"; });
  } catch (error) {
    draft.applyError = "No video settings were changed. The bulk edit could not be applied; review the selection and try again.";
    draft.videos.forEach((video) => { video.applyStatus = "failed"; });
    throw error;
  }
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

function readBulk(rawInput: unknown): { mediaIds: string[]; patch: SettingsPatch; lines: string[]; styleTemplateId?: string; copyTemplateTrim: boolean } {
  if (typeof rawInput !== "object" || rawInput === null) throw validationFailed(["The bulk edit is not valid."]);
  const input = rawInput as Record<string, unknown>;
  const get = (key: string): string | undefined => typeof input[key] === "string" ? input[key] : undefined;
  const getAll = (key: string): string[] => Array.isArray(input[key]) ? (input[key] as unknown[]).filter((value): value is string => typeof value === "string") : get(key) ? [get(key)!] : [];
  const parsed = parseBulkForm(get, getAll);
  if (!parsed.ok) throw validationFailed(parsed.problems);
  return parsed;
}

function patchFromStyle(settings: EditingSettings, copyTrim: boolean): SettingsPatch {
  return {
    aspect: settings.aspect,
    backgroundKind: settings.background.kind,
    ...(settings.background.kind === "solid" ? { solidColor: settings.background.colorHex } : {}),
    ...(settings.background.kind === "image" ? { backgroundImageId: settings.background.mediaId } : {}),
    ...(settings.background.kind === "blur" ? { blurStrength: settings.background.strength } : {}),
    zoom: settings.zoom, offsetX: settings.offsetX, offsetY: settings.offsetY,
    borderEnabled: settings.border.thicknessPx > 0, borderColor: settings.border.colorHex, borderThickness: settings.border.thicknessPx,
    ...(settings.logo ? { logoMediaId: settings.logo.mediaId, logoPosition: { centerX: settings.logo.centerX, centerY: settings.logo.centerY }, logoSize: settings.logo.widthFraction, logoOpacity: settings.logo.opacity } : { clearLogo: true }),
    ...(copyTrim ? { trim: { ...settings.trim } } : {}),
  };
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
