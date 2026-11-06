// Read-side "view models" for the screens. Rules for everything in this file:
//  - signed-in user required, permissions checked on the server (a hidden button is not a control),
//  - only WHITELISTED fields are returned: no storage keys, no URLs, no other users' ids or emails,
//  - big lists are paged and loaded with few queries (no N+1).
import { getPlan, type PlanId } from "../lib/billing/catalog.ts";
import { describeUsageReset, monthStartUtc } from "../lib/domain/usage-accounting.ts";
import { getCollectionCapabilities } from "../lib/domain/sharing-permissions.ts";
import type { Capability, CollectionVisibility, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../lib/domain/types.ts";
import type { PreflightReport } from "../lib/domain/preflight.ts";
import { requireUser, type RequestContext } from "./context.ts";
import { notFound, validationFailed } from "./errors.ts";
import { describeStorage, type StorageDescription } from "./storage/media-storage.ts";
import { computePreviewLayout, isReservedTemplateName, parseEditingSettings, parseEditorQuery, videoSettingsName, type EditingSettings, type PreviewLayout } from "../lib/domain/editing-settings.ts";
import type { MaxResolution } from "../lib/render/ffmpeg-command.ts";
import { buildPreflightReport } from "./preflight-service.ts";
import type { CycleRecord } from "./repository.ts";

export interface MediaCard { id: string; title: string; kind: "video" | "image"; sizeBytes: number; durationMs: number | null; status: MediaAsset["status"]; /** "incomplete" = accepted by file signature only. */ validation: "verified" | "incomplete" | "unknown"; hasThumbnail: boolean; width: number | null; height: number | null; }
const toMediaCard = (m: MediaAsset): MediaCard => ({ id: m.id, title: m.title ?? "Untitled", kind: m.kind ?? "video", sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, status: m.status, validation: m.validation ?? "unknown", hasThumbnail: m.hasThumbnail === true, width: m.width ?? null, height: m.height ?? null });

export interface UsageLine { used: number; limit: number; }
export interface DashboardData {
  planId: PlanId; planName: string; timeZone: string; resetNotice: string;
  usage: { storage: UsageLine; processingMinutes: UsageLine; exports: UsageLine; scheduledItems: UsageLine };
  counts: { media: number; collections: number; cycles: number; runningCycles: number };
}

export async function getDashboardData(ctx: RequestContext, timeZone = "Asia/Kolkata"): Promise<DashboardData> {
  const userId = requireUser(ctx);
  const planId = await ctx.repo.getPlanIdForUser(userId);
  const plan = getPlan(planId);
  const monthStart = monthStartUtc(ctx.now);
  const [mediaPage, collections, cycles, storageUsed, monthly, scheduledUsed] = await Promise.all([
    ctx.repo.listMediaForOwner(userId, { limit: 1, offset: 0 }), ctx.repo.listCollectionsForOwner(userId), ctx.repo.listCyclesForOwner(userId),
    ctx.repo.getStorageUsedBytes(userId), ctx.repo.getMonthlyUsage(userId, monthStart), ctx.repo.getScheduledItemsUsedThisMonth(userId, monthStart),
  ]);
  return {
    planId, planName: plan.name, timeZone, resetNotice: describeUsageReset(ctx.now, timeZone),
    usage: {
      storage: { used: storageUsed, limit: plan.limits.storageBytes },
      processingMinutes: { used: Math.ceil(monthly.processingSeconds / 60), limit: plan.limits.processingMinutesPerMonth },
      exports: { used: monthly.exports, limit: plan.limits.exportsPerMonth },
      scheduledItems: { used: scheduledUsed, limit: plan.limits.scheduledItemsPerMonth },
    },
    counts: { media: mediaPage.total, collections: collections.length, cycles: cycles.length, runningCycles: cycles.filter((c) => c.status === "running").length },
  };
}

export const MEDIA_PAGE_SIZE = 24;
export interface MediaLibraryData { items: MediaCard[]; total: number; page: number; pageCount: number; pageSize: number; }

export async function getMediaLibrary(ctx: RequestContext, requestedPage: unknown): Promise<MediaLibraryData> {
  const userId = requireUser(ctx);
  const page = Number(requestedPage ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw validationFailed(["page must be a whole number from 1."]);
  const { items, total } = await ctx.repo.listMediaForOwner(userId, { limit: MEDIA_PAGE_SIZE, offset: (page - 1) * MEDIA_PAGE_SIZE });
  return { items: items.map(toMediaCard), total, page, pageSize: MEDIA_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE)) };
}

export interface CollectionCard { id: string; name: string; description: string | null; videoCount: number; visibility: CollectionVisibility; archived: boolean; sharedByAnotherUser: boolean; capabilities: Capability[]; }

async function toCollectionCard(ctx: RequestContext, userId: string, collection: VideoCollection): Promise<CollectionCard> {
  const grants = await ctx.repo.getGrants(collection.id);
  return {
    id: collection.id, name: collection.name ?? "Untitled collection", description: collection.description ?? null, videoCount: collection.mediaIds.length,
    visibility: collection.visibility, archived: collection.archived, sharedByAnotherUser: collection.ownerId !== userId,
    capabilities: [...getCollectionCapabilities(userId, collection, grants, ctx.now)],
  };
}

export async function getCollectionsOverview(ctx: RequestContext): Promise<{ owned: CollectionCard[]; sharedWithMe: CollectionCard[] }> {
  const userId = requireUser(ctx);
  const [owned, shared] = await Promise.all([ctx.repo.listCollectionsForOwner(userId), ctx.repo.listCollectionsSharedWith(userId, ctx.now)]);
  return { owned: await Promise.all(owned.map((c) => toCollectionCard(ctx, userId, c))), sharedWithMe: await Promise.all(shared.map((c) => toCollectionCard(ctx, userId, c))) };
}

export interface CollectionDetail { collection: CollectionCard; videos: MediaCard[]; permissions: { canUseInCycle: boolean; canImport: boolean; canDownload: boolean; isOwner: boolean }; /** Your own cycles that can still receive videos (for the "add to cycle" form). */ cycleChoices: { id: string; name: string }[]; /** The owner's own files, used to choose collection membership. Empty for everyone else. */ libraryChoices: MediaCard[]; }

/** A collection you cannot view looks exactly like one that does not exist. */
export async function getCollectionDetail(ctx: RequestContext, collectionId: string): Promise<CollectionDetail> {
  const userId = requireUser(ctx);
  const collection = await ctx.repo.getCollection(collectionId);
  if (!collection) throw notFound("Collection");
  const grants = await ctx.repo.getGrants(collection.id);
  const capabilities = getCollectionCapabilities(userId, collection, grants, ctx.now);
  if (!capabilities.has("view")) throw notFound("Collection");
  const media = (await ctx.repo.getMediaByIds(collection.mediaIds)).filter((m) => m.status !== "deleted");
  const ownCycles = capabilities.has("use_in_cycle") ? await ctx.repo.listCyclesForOwner(userId) : [];
  const library = collection.ownerId === userId ? (await ctx.repo.listMediaForOwner(userId, { limit: 100, offset: 0 })).items : [];
  return {
    cycleChoices: ownCycles.filter((c) => c.status === "draft" || c.status === "running" || c.status === "paused").map((c) => ({ id: c.id, name: c.name })),
    libraryChoices: library.map(toMediaCard),
    collection: await toCollectionCard(ctx, userId, collection), videos: media.map(toMediaCard),
    permissions: { canUseInCycle: capabilities.has("use_in_cycle"), canImport: capabilities.has("import_copy"), canDownload: capabilities.has("download"), isOwner: collection.ownerId === userId },
  };
}

export interface CycleCard { id: string; name: string; status: CycleStatus; totalItems: number; upcoming: number; published: number; needsAttention: number; }

export async function getCyclesOverview(ctx: RequestContext): Promise<CycleCard[]> {
  const userId = requireUser(ctx);
  const cycles = await ctx.repo.listCyclesForOwner(userId);
  return Promise.all(cycles.map(async (cycle) => {
    const items = await ctx.repo.getCycleItems(cycle.id);
    return {
      id: cycle.id, name: cycle.name, status: cycle.status, totalItems: items.length,
      upcoming: items.filter((i) => i.status === "upcoming" || i.status === "scheduled").length,
      published: items.filter((i) => i.status === "published").length,
      needsAttention: items.filter((i) => i.status === "needs_review" || i.status === "failed").length,
    };
  }));
}

export interface CycleDetail { cycle: Pick<CycleRecord, "id" | "name" | "status">; items: CycleItem[]; mediaTitles: Record<string, string>; report: PreflightReport; /** Images the user owns that can be used as covers. */ coverChoices: MediaCard[]; /** True when only the final confirmation is missing (every other check passes). */ readyToConfirm: boolean; }

export async function getCycleDetail(ctx: RequestContext, cycleId: string): Promise<CycleDetail> {
  const userId = requireUser(ctx);
  const cycle = await ctx.repo.getCycle(cycleId);
  if (!cycle || cycle.ownerId !== userId) throw notFound("Publishing cycle");
  const items = await ctx.repo.getCycleItems(cycleId);
  const media = await ctx.repo.getMediaByIds([...new Set(items.map((i) => i.mediaAssetId))]);
  const mediaTitles: Record<string, string> = {};
  for (const m of media) mediaTitles[m.id] = m.title ?? "Untitled";
  // Shown as information only: the cycle is NOT started by viewing it.
  const report = await buildPreflightReport(ctx, userId, cycle, items, cycle.finalReviewConfirmed);
  const coverChoices = (await ctx.repo.listMediaForOwner(userId, { limit: 50, offset: 0, kind: "image" })).items.map(toMediaCard);
  const readyToConfirm = report.checks.every((c) => c.id === "final_review" || c.level === "ready" || c.level === "recommendation");
  return { cycle: { id: cycle.id, name: cycle.name, status: cycle.status }, items, mediaTitles, report, coverChoices, readyToConfirm };
}

export interface UploadInfo { available: boolean; storage: StorageDescription; storageKind: "memory" | "local-disk" | "s3" | null; maxMegabytes: number; }

/** What the upload form needs. `available` is false when no storage is configured: the form then explains instead of failing. */
export function getUploadInfo(ctx: RequestContext): UploadInfo {
  requireUser(ctx);
  if (ctx.media?.unavailable) return { available: false, storage: { label: "Private folder unavailable", persistent: false, warning: ctx.media.unavailable }, storageKind: null, maxMegabytes: Math.floor(ctx.media.maxUploadBytes / (1024 * 1024)) };
  const kind = ctx.media?.storage.kind ?? null;
  return { available: ctx.media !== undefined, storage: describeStorage(kind), storageKind: kind, maxMegabytes: ctx.media ? Math.floor(ctx.media.maxUploadBytes / (1024 * 1024)) : 0 };
}

/** The user's own connected accounts for the "new cycle" form. External ids are never shown. */
export async function getCycleCreationOptions(ctx: RequestContext): Promise<{ accounts: { id: string; label: string }[] }> {
  const userId = requireUser(ctx);
  const accounts = await ctx.repo.listSocialAccountsForOwner(userId);
  return { accounts: accounts.filter((a) => a.status === "connected").map((a, index) => ({ id: a.id, label: `Connected account ${index + 1}` })) };
}

export interface MediaDetail { media: MediaCard; mimeType: string | null; addedAt: Date | null; }

/** Details of ONE of your own files. Someone else's file looks exactly like a missing one. */
export async function getMediaDetail(ctx: RequestContext, mediaId: string): Promise<MediaDetail> {
  const userId = requireUser(ctx);
  const media = await ctx.repo.getMedia(mediaId);
  if (!media || media.ownerId !== userId || media.status === "deleted") throw notFound("File");
  return { media: toMediaCard(media), mimeType: media.mimeType ?? null, addedAt: media.createdAt ?? null };
}

export interface TemplateCard { id: string; name: string; summary: string; }
export interface EditorPageData {
  /** The video being edited, or null (then the page lets you choose one). */
  source: MediaCard | null;
  videoChoices: MediaCard[];
  logoChoices: MediaCard[];
  settings: EditingSettings;
  problems: string[];
  layout: PreviewLayout | null;
  /** true when the file's real size is unknown, so the sketch assumes a 16:9 picture. */
  assumedSourceSize: boolean;
  templates: TemplateCard[];
  templateLimit: number;
  maxResolution: MaxResolution;
  logoAspect: number;
  /** Where the settings on screen came from. A preview or template is not saved until the user saves or renders. */
  settingsSource: "saved" | "preview" | "template";
  /** Finished exports whose files were checked. */
  exports: { id: string; sourceTitle: string; aspect: string; createdOn: string }[];
  /** The render started from this page, if it is still known in this process. */
  job: { id: string; status: "queued" | "processing" | "completed" | "failed"; message: string | null; outputId: string | null; refreshPath: string | null } | null;
}

async function verifiedExports(ctx: RequestContext, userId: string): Promise<EditorPageData["exports"]> {
  const rows = await ctx.repo.listRenderOutputsForOwner(userId);
  const audits = await ctx.repo.listAuditsForEntities("MediaDerivative", rows.map((row) => row.id));
  const ready: EditorPageData["exports"] = [];
  for (const row of rows) {
    const info = await ctx.repo.getRenderOutput(row.id);
    if (!info) continue;
    if (ctx.media && !ctx.media.unavailable) {
      const size = await ctx.media.storage.statSize(info.storageKey);
      if (size !== info.sizeBytes) continue;
    }
    const source = await ctx.repo.getMedia(row.sourceMediaId);
    const aspect = audits.find((entry) => entry.entityId === row.id && entry.action === "render.completed")?.metadata?.["aspect"];
    ready.push({ id: row.id, sourceTitle: source?.title ?? "Untitled video", aspect: typeof aspect === "string" ? aspect : "Saved export", createdOn: row.createdAt.toISOString().slice(0, 10) });
  }
  return ready;
}

function jobFor(ctx: RequestContext, userId: string, jobId: string | undefined, mediaId: string | undefined): EditorPageData["job"] {
  if (!jobId || !ctx.renders) return null;
  const job = ctx.renders.jobs.get(jobId);
  if (!job || job.ownerId !== userId) return null;
  const refreshPath = mediaId && (job.status === "queued" || job.status === "processing") ? `/editor?media=${encodeURIComponent(mediaId)}&job=${encodeURIComponent(job.id)}` : null;
  return { id: job.id, status: job.status, message: job.message, outputId: job.outputId, refreshPath };
}

const describeSettings = (s: EditingSettings): string => {
  const background = s.background.kind === "solid" ? `solid ${s.background.colorHex}` : s.background.kind === "image" ? "image background" : "blurred background";
  return `${s.aspect}, ${background}, zoom ${s.zoom}${s.border.thicknessPx > 0 ? `, ${s.border.thicknessPx}px border` : ""}${s.logo ? ", logo" : ""}`;
};

/**
 * Everything the editor page shows. The video must be YOURS (someone else's looks like a missing one).
 * Settings come from the page's query string and are checked with the same rules as the renderer; bad values are
 * reported and the defaults are used instead. Nothing here changes any media.
 */
export async function getEditorPageData(ctx: RequestContext, input: { mediaId: string | undefined; search: Record<string, string | string[] | undefined> | undefined }): Promise<EditorPageData> {
  const userId = requireUser(ctx);
  const planId = await ctx.repo.getPlanIdForUser(userId);
  const plan = getPlan(planId);
  const [storedTemplates, videos, images] = await Promise.all([ctx.repo.listTemplatesForOwner(userId), ctx.repo.listMediaForOwner(userId, { limit: 12, offset: 0, kind: "video" }), ctx.repo.listMediaForOwner(userId, { limit: 50, offset: 0, kind: "image" })]);
  const templates = storedTemplates.filter((template) => !isReservedTemplateName(template.name));
  const common = { videoChoices: videos.items.map(toMediaCard), logoChoices: images.items.map(toMediaCard), templates: templates.map((t) => ({ id: t.id, name: t.name, summary: describeSettings(t.settings) })), templateLimit: plan.limits.templates, maxResolution: plan.features.maxResolution, exports: await verifiedExports(ctx, userId), job: jobFor(ctx, userId, typeof input.search?.["job"] === "string" ? input.search["job"] : undefined, input.mediaId) };
  if (!input.mediaId) return { ...common, source: null, settings: parseEditorQuery(undefined).settings, settingsSource: "saved" as const, problems: [], layout: null, assumedSourceSize: false, logoAspect: 1 };

  const media = await ctx.repo.getMedia(input.mediaId);
  if (!media || media.ownerId !== userId || media.status === "deleted" || (media.kind ?? "video") !== "video") throw notFound("Video");

  const savedRow = storedTemplates.find((template) => template.name === videoSettingsName(media.id));
  const savedParsed = savedRow ? parseEditingSettings(savedRow.settings) : { ok: true as const, settings: parseEditorQuery(undefined).settings };
  const savedSettings = savedParsed.ok ? savedParsed.settings : parseEditorQuery(undefined).settings;
  const templateId = typeof input.search?.["template"] === "string" ? input.search["template"] : undefined;
  const previewKeys = ["aspect", "zoom", "offsetX", "offsetY", "bg", "bgColor", "bgImage", "blur", "borderPx", "borderColor", "logoMedia", "logoWidth", "logoX", "logoY", "logoOpacity"];
  const previewing = previewKeys.some((key) => typeof input.search?.[key] === "string");
  const fromTemplate = templateId && !previewing ? templates.find((t) => t.id === templateId)?.settings : undefined;
  const parsed = fromTemplate ? { settings: fromTemplate, problems: [] as string[] } : previewing ? parseEditorQuery(input.search) : { settings: savedSettings, problems: savedParsed.ok ? [] : ["Saved settings could not be read, so the defaults are shown."] };
  const settingsSource = fromTemplate ? "template" as const : previewing ? "preview" as const : "saved" as const;
  let { settings } = parsed; const problems = [...parsed.problems];
  let logoAspect = 1;
  if (settings.logo) {
    const logo = images.items.find((m) => m.id === settings.logo!.mediaId);
    if (!logo) { problems.push("The logo must be one of your own images; it was removed from the preview."); settings = { ...settings, logo: null }; }
    else if (logo.width && logo.height) logoAspect = logo.width / logo.height;
  }
  const background = settings.background;
  if (background.kind === "image" && !images.items.some((m) => m.id === background.mediaId)) {
    problems.push("The background image must be one of your own images; it was removed from the preview.");
    settings = { ...settings, background: { kind: "blur", strength: 20 } };
  }
  const assumedSourceSize = !(media.width && media.height);
  const layout = computePreviewLayout(settings, { width: media.width ?? 1920, height: media.height ?? 1080 }, logoAspect, plan.features.maxResolution);
  return { ...common, source: toMediaCard(media), settings, settingsSource, problems, layout, assumedSourceSize, logoAspect };
}
