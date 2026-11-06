// Read-side "view models" for the screens. Rules for everything in this file:
//  - signed-in user required, permissions checked on the server (a hidden button is not a control),
//  - only WHITELISTED fields are returned: no storage keys, no URLs, no other users' ids or emails,
//  - big lists are paged and loaded with few queries (no N+1).
import { getPlan, type PlanId } from "../lib/billing/catalog.ts";
import { describeUsageReset, monthStartUtc } from "../lib/domain/usage-accounting.ts";
import { compareMedia, mediaMatchesSearch } from "../lib/domain/media-list.ts";
import { getCollectionCapabilities } from "../lib/domain/sharing-permissions.ts";
import type { Capability, CollectionVisibility, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../lib/domain/types.ts";
import { INSTAGRAM_VERIFIED } from "../lib/integrations/instagram-capabilities.ts";
import type { PreflightReport } from "../lib/domain/preflight.ts";
import { consecutiveDefiniteFailures, itemsEligibleForRepeat, shouldPauseForAccount, type RepeatBehavior } from "../lib/domain/publish-workflow.ts";
import { requireUser, type RequestContext } from "./context.ts";
import { readCollectionListQuery, readCollectionVideoQuery, readMediaListQuery, type CollectionSort, type MediaListQuery } from "./library-query.ts";
import { notFound } from "./errors.ts";
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
export interface MediaLibraryData { items: MediaCard[]; total: number; page: number; pageCount: number; pageSize: number; search?: string; sort?: MediaListQuery["sort"]; kind?: "all" | "video" | "image"; filtered?: boolean; }

export async function getMediaLibrary(ctx: RequestContext, requested: unknown): Promise<MediaLibraryData> {
  const userId = requireUser(ctx);
  const query = readMediaListQuery(typeof requested === "object" && requested !== null ? requested : { page: requested });
  const { items, total } = await ctx.repo.listMediaForOwner(userId, { limit: MEDIA_PAGE_SIZE, offset: (query.page - 1) * MEDIA_PAGE_SIZE, ...(query.kind ? { kind: query.kind } : {}), ...(query.search ? { search: query.search } : {}), sort: query.sort });
  return { items: items.map(toMediaCard), total, page: query.page, pageSize: MEDIA_PAGE_SIZE, pageCount: Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE)), search: query.search, sort: query.sort, kind: query.kind ?? "all", filtered: query.filtered };
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

function sortCollections(list: VideoCollection[], sort: CollectionSort): VideoCollection[] {
  const idOnly = (a: VideoCollection, b: VideoCollection) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const timeOnly = (a: VideoCollection, b: VideoCollection) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
  const byName = (a: VideoCollection, b: VideoCollection) => {
    const left = a.name ?? "";
    const right = b.name ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return idOnly(a, b);
  };
  const byTime = (a: VideoCollection, b: VideoCollection) => timeOnly(a, b) || idOnly(a, b);
  return [...list].sort(sort === "name" ? byName : sort === "oldest" ? byTime : (a, b) => timeOnly(b, a) || idOnly(a, b));
}

export async function getCollectionsOverview(ctx: RequestContext, requested?: unknown): Promise<{ owned: CollectionCard[]; sharedWithMe: CollectionCard[]; search: string; sort: CollectionSort; filtered: boolean }> {
  const userId = requireUser(ctx);
  const query = readCollectionListQuery(requested);
  const needle = query.search.toLocaleLowerCase();
  const matches = (collection: VideoCollection) => needle.length === 0 || (collection.name ?? "").toLocaleLowerCase().includes(needle);
  const [owned, shared] = await Promise.all([ctx.repo.listCollectionsForOwner(userId), ctx.repo.listCollectionsSharedWith(userId, ctx.now)]);
  return {
    owned: await Promise.all(sortCollections(owned.filter(matches), query.sort).map((c) => toCollectionCard(ctx, userId, c))),
    sharedWithMe: await Promise.all(sortCollections(shared.filter(matches), query.sort).map((c) => toCollectionCard(ctx, userId, c))),
    search: query.search, sort: query.sort, filtered: query.filtered,
  };
}

export interface CollectionDetail { collection: CollectionCard; videos: MediaCard[]; memberIds: string[]; permissions: { canUseInCycle: boolean; canImport: boolean; canDownload: boolean; isOwner: boolean }; /** Your own cycles that can still receive videos (for the "add to cycle" form). */ cycleChoices: { id: string; name: string }[]; /** The owner's own files, used to choose collection membership. Empty for everyone else. */ libraryChoices: MediaCard[]; libraryTruncated?: boolean; videoSearch?: string; videoSort?: MediaListQuery["sort"]; videoFiltered?: boolean; }

const COLLECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A collection you cannot view looks exactly like one that does not exist. */
export async function getCollectionDetail(ctx: RequestContext, collectionId: string, requested?: unknown): Promise<CollectionDetail> {
  const userId = requireUser(ctx);
  if (!COLLECTION_ID_PATTERN.test(collectionId)) throw notFound("Collection");
  const videoQuery = readCollectionVideoQuery(requested);
  const collection = await ctx.repo.getCollection(collectionId);
  if (!collection) throw notFound("Collection");
  const grants = await ctx.repo.getGrants(collection.id);
  const capabilities = getCollectionCapabilities(userId, collection, grants, ctx.now);
  if (!capabilities.has("view")) throw notFound("Collection");
  const members = (await ctx.repo.getMediaByIds(collection.mediaIds)).filter((m) => m.status !== "deleted");
  const media = members.filter((m) => videoQuery.search.length === 0 || mediaMatchesSearch(m, videoQuery.search)).sort((a, b) => compareMedia(videoQuery.sort, a, b));
  const ownCycles = capabilities.has("use_in_cycle") ? await ctx.repo.listCyclesForOwner(userId) : [];
  const library = collection.ownerId === userId ? await ctx.repo.listMediaForOwner(userId, { limit: 200, offset: 0, sort: "name" }) : { items: [], total: 0 };
  return {
    cycleChoices: ownCycles.filter((c) => c.status === "draft" || c.status === "running" || c.status === "paused").map((c) => ({ id: c.id, name: c.name })),
    libraryChoices: library.items.map(toMediaCard),
    libraryTruncated: library.total > library.items.length,
    collection: await toCollectionCard(ctx, userId, collection), videos: media.map(toMediaCard), memberIds: members.map((m) => m.id),
    videoSearch: videoQuery.search, videoSort: videoQuery.sort, videoFiltered: videoQuery.filtered,
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

export interface CyclePublishingStatus {
  repeatBehavior: RepeatBehavior;
  accountStatus: "connected" | "token_expired" | "revoked" | "disconnected" | null;
  tokenExpiresAt: string | null;
  tokenExpired: boolean;
  missingPermissions: string[];
  definiteFailureStreak: number;
  pauseReason: string | null;
  eligibleUnpublishedCount: number;
}

export interface CycleDetail { cycle: Pick<CycleRecord, "id" | "name" | "status">; items: CycleItem[]; mediaTitles: Record<string, string>; report: PreflightReport; /** Images the user owns that can be used as covers. */ coverChoices: MediaCard[]; /** True when only the final confirmation is missing (every other check passes). */ readyToConfirm: boolean; publishing: CyclePublishingStatus; }

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
  const ownedAccount = accountBelongsTo(await ctx.repo.getSocialAccount(cycle.socialAccountId), userId);
  const jobs = await ctx.repo.listPublishingJobsForAccount(userId, cycle.socialAccountId);
  const definiteFailureStreak = consecutiveDefiniteFailures(jobs);
  const pause = ownedAccount ? shouldPauseForAccount({ status: ownedAccount.status, consecutiveDefiniteFailures: definiteFailureStreak }) : { pause: false, reason: null };
  const requiredScopes = INSTAGRAM_VERIFIED.loginPaths.instagramLogin.permissions;
  const grantedScopes = ownedAccount?.grantedScopes ?? [];
  const expiresAt = ownedAccount?.tokenExpiresAt ?? null;
  const publishing: CyclePublishingStatus = {
    repeatBehavior: cycle.repeatBehavior ?? "never",
    accountStatus: ownedAccount?.status ?? null,
    tokenExpiresAt: expiresAt ? expiresAt.toISOString().slice(0, 10) : null,
    tokenExpired: expiresAt !== null && expiresAt <= ctx.now,
    missingPermissions: ownedAccount ? requiredScopes.filter((scope) => !grantedScopes.includes(scope)) : [],
    definiteFailureStreak,
    pauseReason: pause.pause ? pause.reason : null,
    eligibleUnpublishedCount: itemsEligibleForRepeat(items).length,
  };
  return { cycle: { id: cycle.id, name: cycle.name, status: cycle.status }, items, mediaTitles, report, coverChoices, readyToConfirm, publishing };
}

function accountBelongsTo(account: Awaited<ReturnType<RequestContext["repo"]["getSocialAccount"]>>, userId: string) {
  return account && account.userId === userId ? account : null;
}

export interface UploadInfo { available: boolean; storage: StorageDescription; storageKind: "memory" | "local-disk" | "s3" | null; maxMegabytes: number; }

/** What the upload form needs. `available` is false when no storage is configured: the form then explains instead of failing. */
export function getUploadInfo(ctx: RequestContext): UploadInfo {
  requireUser(ctx);
  if (ctx.media?.unavailable) return { available: false, storage: { label: "Private folder unavailable", persistent: false, warning: ctx.media.unavailable }, storageKind: null, maxMegabytes: Math.floor(ctx.media.maxUploadBytes / (1024 * 1024)) };
  const kind = ctx.media?.storage.kind ?? null;
  return { available: ctx.media !== undefined, storage: describeStorage(kind), storageKind: kind, maxMegabytes: ctx.media ? Math.floor(ctx.media.maxUploadBytes / (1024 * 1024)) : 0 };
}

export interface InstagramAccountCard {
  id: string;
  username: string | null;
  status: "connected" | "token_expired" | "revoked" | "disconnected";
  accountType: string | null;
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  hasToken: boolean;
}

/** Accounts for the Instagram page. Tokens and external ids are not included. */
export async function getInstagramAccounts(ctx: RequestContext): Promise<InstagramAccountCard[]> {
  const userId = requireUser(ctx);
  const accounts = await ctx.repo.listSocialAccountsForOwner(userId);
  return accounts.map((account) => ({
    id: account.id,
    username: account.username ?? null,
    status: account.status,
    accountType: account.accountType ?? null,
    grantedScopes: account.grantedScopes ?? [],
    tokenExpiresAt: account.tokenExpiresAt ? account.tokenExpiresAt.toISOString().slice(0, 10) : null,
    hasToken: account.hasToken === true,
  }));
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
