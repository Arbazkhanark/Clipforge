// Read-side "view models" for the screens. Rules for everything in this file:
//  - signed-in user required, permissions checked on the server (a hidden button is not a control),
//  - only WHITELISTED fields are returned: no storage keys, no URLs, no other users' ids or emails,
//  - big lists are paged and loaded with few queries (no N+1).
import { getPlan, type PlanId } from "../lib/billing/catalog.ts";
import { describeUsageReset, monthStartUtc } from "../lib/domain/usage-accounting.ts";
import { compareMedia, mediaMatchesSearch } from "../lib/domain/media-list.ts";
import { getCollectionCapabilities, hashShareToken, validateShareLink } from "../lib/domain/sharing-permissions.ts";
import { countActiveRecipients } from "../lib/domain/sharing-management.ts";
import type { Capability, CollectionPermissionGrant, CollectionVisibility, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../lib/domain/types.ts";
import { evaluateInstagramEligibility, missingInstagramScopes, normalizeInstagramScopes } from "../lib/integrations/instagram-eligibility.ts";
import type { PreflightReport } from "../lib/domain/preflight.ts";
import { consecutiveDefiniteFailures, itemsEligibleForRepeat, shouldPauseForAccount, type RepeatBehavior } from "../lib/domain/publish-workflow.ts";
import { requireUser, type RequestContext } from "./context.ts";
import { readCollectionListQuery, readCollectionVideoQuery, readMediaListQuery, type CollectionSort, type MediaListQuery } from "./library-query.ts";
import { notFound } from "./errors.ts";
import { describeStorage, type StorageDescription } from "./storage/media-storage.ts";
import { computePreviewLayout, DEFAULT_EDITING_SETTINGS, isReservedTemplateName, parseEditingSettings, parseEditorQuery, trimDurationProblems, videoSettingsName, type EditingSettings, type PreviewLayout } from "../lib/domain/editing-settings.ts";
import type { MaxResolution } from "../lib/render/ffmpeg-command.ts";
import { buildPreflightReport } from "./preflight-service.ts";
import { localDateKey, localDateOf } from "../lib/domain/schedule.ts";
import type { CycleRecord, Repository, RenderOutputRecord } from "./repository.ts";

export interface MediaCard { id: string; title: string; kind: "video" | "image"; sizeBytes: number; durationMs: number | null; status: MediaAsset["status"]; /** "incomplete" = accepted by file signature only. */ validation: "verified" | "incomplete" | "unknown"; hasThumbnail: boolean; width: number | null; height: number | null; }
const toMediaCard = (m: MediaAsset): MediaCard => ({ id: m.id, title: m.title ?? "Untitled", kind: m.kind ?? "video", sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, status: m.status, validation: m.validation ?? "unknown", hasThumbnail: m.hasThumbnail === true, width: m.width ?? null, height: m.height ?? null });

export interface UsageLine { used: number; limit: number; }
export interface DashboardData {
  planId: PlanId; planName: string; timeZone: string; resetNotice: string;
  usage: { storage: UsageLine; processingMinutes: UsageLine; exports: UsageLine; scheduledItems: UsageLine };
  counts: { media: number; collections: number; cycles: number; runningCycles: number };
  campaigns: CampaignSummary[]; statusFilter: CycleStatus | "all";
}

export interface CampaignSummary { id: string; name: string; status: CycleStatus; accountName: string | null; timeZone: string; totalItems: number; scheduledItems: number; nextScheduledAt: Date | null; createdAt: Date | null; }

export async function getDashboardData(ctx: RequestContext, timeZone = "Asia/Kolkata", requestedStatus?: unknown): Promise<DashboardData> {
  const userId = requireUser(ctx);
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const plan = getPlan(planId);
  const monthStart = monthStartUtc(ctx.now);
  const [mediaPage, collections, cycles, accounts, storageUsed, monthly, scheduledUsed] = await Promise.all([
    ctx.repo.listMediaForOwner(userId, { limit: 1, offset: 0 }), ctx.repo.listCollectionsForOwner(userId), ctx.repo.listCyclesForOwner(userId),
    ctx.repo.listSocialAccountsForOwner(userId),
    ctx.repo.getStorageUsedBytes(userId), ctx.repo.getMonthlyUsage(userId, monthStart), ctx.repo.getScheduledItemsUsedThisMonth(userId, monthStart),
  ]);
  const statusFilter: CycleStatus | "all" = typeof requestedStatus === "string" && ["draft", "running", "paused", "stopped", "completed"].includes(requestedStatus) ? requestedStatus as CycleStatus : "all";
  const accountNames = new Map(accounts.map((account) => [account.id, account.username?.trim() || "Instagram account"]));
  const campaigns = await Promise.all(cycles.map(async (cycle): Promise<CampaignSummary> => {
    const items = await ctx.repo.getCycleItems(cycle.id);
    const planned = items.filter((item) => (item.status === "upcoming" || item.status === "scheduled") && item.scheduledFor !== null).map((item) => item.scheduledFor as Date).sort((a, b) => a.getTime() - b.getTime());
    const account = accounts.find((candidate) => candidate.id === cycle.socialAccountId && candidate.userId === userId);
    return { id: cycle.id, name: cycle.name, status: cycle.status, accountName: account?.status === "connected" ? accountNames.get(account.id) ?? null : null, timeZone: cycle.scheduleSettings?.timeZone ?? cycle.timezone ?? timeZone, totalItems: items.length, scheduledItems: items.filter((item) => item.scheduledFor !== null).length, nextScheduledAt: planned.find((date) => date.getTime() >= ctx.now.getTime()) ?? null, createdAt: cycle.createdAt ?? null };
  }));
  return {
    planId, planName: plan.name, timeZone, resetNotice: describeUsageReset(ctx.now, timeZone),
    usage: {
      storage: { used: storageUsed, limit: plan.limits.storageBytes },
      processingMinutes: { used: Math.ceil(monthly.processingSeconds / 60), limit: plan.limits.processingMinutesPerMonth },
      exports: { used: monthly.exports, limit: plan.limits.exportsPerMonth },
      scheduledItems: { used: scheduledUsed, limit: plan.limits.scheduledItemsPerMonth },
    },
    counts: { media: mediaPage.total, collections: collections.length, cycles: cycles.length, runningCycles: cycles.filter((c) => c.status === "running").length },
    campaigns: campaigns.filter((campaign) => statusFilter === "all" || campaign.status === statusFilter), statusFilter,
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

export interface CollectionCard { id: string; name: string; description: string | null; videoCount: number; visibility: CollectionVisibility; archived: boolean; sharedByAnotherUser: boolean; capabilities: Capability[]; createdAt: Date | null; previewMediaId: string | null; }

async function toCollectionCard(ctx: RequestContext, userId: string, collection: VideoCollection): Promise<CollectionCard> {
  const grants = await ctx.repo.getGrants(collection.id);
  return {
    id: collection.id, name: collection.name ?? "Untitled collection", description: collection.description ?? null, videoCount: collection.mediaIds.length,
    visibility: collection.visibility, archived: collection.archived, sharedByAnotherUser: collection.ownerId !== userId,
    capabilities: [...getCollectionCapabilities(userId, collection, grants, ctx.now)],
    createdAt: collection.createdAt ?? null,
    previewMediaId: null,
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

export async function getCollectionsOverview(ctx: RequestContext, requested?: unknown): Promise<{ owned: CollectionCard[]; sharedWithMe: CollectionCard[]; accessRequests: { id: string; collectionId: string; requestedCapabilities: Capability[]; status: "pending" | "approved" | "rejected"; createdAt: Date; decidedAt: Date | null }[]; incomingAccessRequests: { id: string; collectionId: string; collectionName: string; requesterId: string; requestedCapabilities: Capability[]; createdAt: Date }[]; libraryChoices: MediaCard[]; search: string; sort: CollectionSort; filtered: boolean; tab: "mine" | "shared" | "requests" }> {
  const userId = requireUser(ctx);
  const query = readCollectionListQuery(requested);
  const needle = query.search.toLocaleLowerCase();
  const matches = (collection: VideoCollection) => needle.length === 0 || (collection.name ?? "").toLocaleLowerCase().includes(needle);
  const [owned, shared] = await Promise.all([ctx.repo.listCollectionsForOwner(userId), ctx.repo.listCollectionsSharedWith(userId, ctx.now)]);
  const [accessRequests, incomingByCollection] = await Promise.all([
    ctx.repo.listCollectionAccessRequestsForRequester(userId),
    Promise.all(owned.map(async (collection) => ({ collection, requests: await ctx.repo.listPendingCollectionAccessRequests(collection.id, userId) }))),
  ]);
  const incomingAccessRequests = incomingByCollection.flatMap(({ collection, requests }) => requests.map((request) => ({ id: request.id, collectionId: collection.id, collectionName: collection.name ?? "Untitled collection", requesterId: request.requesterId, requestedCapabilities: request.requestedCapabilities, createdAt: request.createdAt })));
  const visibleCollections = [...owned, ...shared];
  const previews = await ctx.repo.getMediaByIds([...new Set(visibleCollections.map((collection) => collection.mediaIds[0]).filter((id): id is string => Boolean(id)))]);
  const previewByCollection = new Map(visibleCollections.map((collection) => [collection.id, previews.find((media) => media.id === collection.mediaIds[0] && media.kind === "video" && media.hasThumbnail)?.id ?? null]));
  const libraryChoices = (await ctx.repo.listMediaForOwner(userId, { limit: 200, offset: 0, sort: "name" })).items.map(toMediaCard);
  const tabRaw = typeof requested === "object" && requested !== null && "tab" in requested ? (requested as { tab?: unknown }).tab : undefined;
  const tab: "mine" | "shared" | "requests" = tabRaw === "shared" || tabRaw === "requests" ? tabRaw : "mine";
  return {
    owned: await Promise.all(sortCollections(owned.filter(matches), query.sort).map(async (c) => ({ ...(await toCollectionCard(ctx, userId, c)), previewMediaId: previewByCollection.get(c.id) ?? null }))),
    sharedWithMe: await Promise.all(sortCollections(shared.filter(matches), query.sort).map(async (c) => ({ ...(await toCollectionCard(ctx, userId, c)), previewMediaId: previewByCollection.get(c.id) ?? null }))),
    accessRequests: accessRequests.map((request) => ({ id: request.id, collectionId: request.collectionId, requestedCapabilities: request.requestedCapabilities, status: request.status, createdAt: request.createdAt, decidedAt: request.decidedAt })),
    incomingAccessRequests, libraryChoices, search: query.search, sort: query.sort, filtered: query.filtered, tab,
  };
}

export interface CollectionDetail { collection: CollectionCard; videos: MediaCard[]; memberIds: string[]; itemSettings: { mediaAssetId: string; captionText: string; coverMediaId: string | null; version: number }[]; settingsVersion: number; captionMode: "individual" | "shared"; sharedCaptionText: string; coverMode: "individual" | "shared"; sharedCoverMediaId: string | null; coverChoices: MediaCard[]; permissions: { canUseInCycle: boolean; canImport: boolean; canRequestImport?: boolean; canDownload: boolean; isOwner: boolean }; importJobs?: { id: string; sourceMediaId: string; resultMediaAssetId: string; status: import("./repository.ts").MediaImportStatus; failureReason: string | null; createdAt: Date; updatedAt: Date }[]; pendingAccessRequests?: { id: string; requesterId: string; requestedCapabilities: Capability[]; createdAt: Date }[]; shareLinks?: import("./repository.ts").CollectionShareLinkSummary[]; sharingManagement?: { grants: { granteeId: string; capabilities: Capability[]; status: "active" | "revoked"; expiresAt: Date | null; grantedById: string | null }[]; activeRecipients: number; recipientLimit: number; expiringGrants: boolean; delegatedManagement: boolean }; /** Your own cycles that can still receive videos (for the "add to cycle" form). */ cycleChoices: { id: string; name: string }[]; /** The owner's own files, used to choose collection membership. Empty for everyone else. */ libraryChoices: MediaCard[]; libraryTruncated?: boolean; videoSearch?: string; videoSort?: MediaListQuery["sort"]; videoFiltered?: boolean; }

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
  let sharingManagement: CollectionDetail["sharingManagement"];
  let pendingAccessRequests: CollectionDetail["pendingAccessRequests"];
  let shareLinks: CollectionDetail["shareLinks"];
  if (collection.ownerId === userId) {
    const ownerPlan = getPlan(await ctx.repo.getPlanIdForUser(collection.ownerId, ctx.now));
    sharingManagement = {
      grants: grants.map((grant) => ({ granteeId: grant.granteeId, capabilities: grant.capabilities, status: grant.status, expiresAt: grant.expiresAt, grantedById: grant.grantedById ?? null })),
      activeRecipients: countActiveRecipients(collection.id, collection.ownerId, grants, ctx.now),
      recipientLimit: ownerPlan.sharing.maxRecipientsPerCollection,
      expiringGrants: ownerPlan.sharing.expiringGrants,
      delegatedManagement: ownerPlan.sharing.delegatedManagement,
    };
    pendingAccessRequests = (await ctx.repo.listPendingCollectionAccessRequests(collection.id, userId)).map((request) => ({ id: request.id, requesterId: request.requesterId, requestedCapabilities: request.requestedCapabilities, createdAt: request.createdAt }));
    shareLinks = await ctx.repo.listCollectionShareLinksForOwner(collection.id, userId);
  }
  const members = (await ctx.repo.getMediaByIds(collection.mediaIds)).filter((m) => m.status !== "deleted");
  const media = members.filter((m) => videoQuery.search.length === 0 || mediaMatchesSearch(m, videoQuery.search)).sort((a, b) => compareMedia(videoQuery.sort, a, b));
  const ownCycles = capabilities.has("use_in_cycle") ? await ctx.repo.listCyclesForOwner(userId) : [];
  const library = collection.ownerId === userId ? await ctx.repo.listMediaForOwner(userId, { limit: 200, offset: 0, sort: "name" }) : { items: [], total: 0 };
  const coverChoices = library.items.filter((item) => item.kind === "image" && item.status === "active").map(toMediaCard);
  const directImport = collection.ownerId !== userId && grants.some((grant) => grant.granteeId === userId && grant.status === "active" && grant.capabilities.includes("import_copy") && (grant.expiresAt === null || grant.expiresAt > ctx.now));
  const importJobs = directImport
    ? (await ctx.repo.listMediaImportJobsForOwner(userId)).filter((job) => job.sourceCollectionId === collection.id).map((job) => ({ id: job.id, sourceMediaId: job.sourceMediaId, resultMediaAssetId: job.resultMediaAssetId, status: job.status, failureReason: job.failureReason, createdAt: job.createdAt, updatedAt: job.updatedAt }))
    : [];
  return {
    cycleChoices: ownCycles.filter((c) => c.status === "draft" || c.status === "running" || c.status === "paused").map((c) => ({ id: c.id, name: c.name })),
    libraryChoices: library.items.map(toMediaCard),
    libraryTruncated: library.total > library.items.length,
    itemSettings: collection.ownerId === userId ? collection.items ?? collection.mediaIds.map((mediaAssetId) => ({ mediaAssetId, captionText: "", coverMediaId: null, version: 1 })) : [],
    settingsVersion: collection.ownerId === userId ? collection.settingsVersion ?? 1 : 1,
    captionMode: collection.ownerId === userId ? collection.captionMode ?? "individual" : "individual",
    sharedCaptionText: collection.ownerId === userId ? collection.sharedCaptionText ?? "" : "",
    coverMode: collection.ownerId === userId ? collection.coverMode ?? "individual" : "individual",
    sharedCoverMediaId: collection.ownerId === userId ? collection.sharedCoverMediaId ?? null : null,
    coverChoices,
    collection: await toCollectionCard(ctx, userId, collection), videos: media.map(toMediaCard), memberIds: members.map((m) => m.id),
    videoSearch: videoQuery.search, videoSort: videoQuery.sort, videoFiltered: videoQuery.filtered,
    permissions: { canUseInCycle: capabilities.has("use_in_cycle"), canImport: capabilities.has("import_copy"), canDownload: capabilities.has("download"), isOwner: collection.ownerId === userId },
    ...(sharingManagement ? { sharingManagement } : {}),
    ...(pendingAccessRequests ? { pendingAccessRequests } : {}),
    ...(shareLinks ? { shareLinks } : {}),
    ...(collection.ownerId !== userId ? { importJobs, permissions: { canUseInCycle: capabilities.has("use_in_cycle"), canImport: capabilities.has("import_copy"), canRequestImport: directImport, canDownload: capabilities.has("download"), isOwner: false } } : {}),
  };
}

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A signed-in recipient view. Every request re-hashes and checks the link and current collection state. */
export async function getSharedCollectionDetail(ctx: RequestContext, rawToken: string, requested?: unknown): Promise<CollectionDetail> {
  const userId = requireUser(ctx);
  if (!SHARE_TOKEN_PATTERN.test(rawToken)) throw notFound("Collection");
  const link = await ctx.repo.getCollectionShareLinkByTokenHash(hashShareToken(rawToken));
  if (!link || !validateShareLink({ tokenHash: link.tokenHash, revoked: link.revokedAt !== null, expiresAt: link.expiresAt }, rawToken, ctx.now).allowed) throw notFound("Collection");
  const collection = await ctx.repo.getCollection(link.collectionId);
  if (!collection || collection.ownerId !== link.createdById || collection.visibility !== "link" || collection.archived) throw notFound("Collection");
  const videoQuery = readCollectionVideoQuery(typeof requested === "object" && requested !== null ? requested : {});
  const effectiveLink: CollectionPermissionGrant = { collectionId: collection.id, granteeId: userId, capabilities: link.capabilities, status: "active", expiresAt: link.expiresAt, grantedById: link.createdById };
  const grants = [...await ctx.repo.getGrants(collection.id), effectiveLink];
  const capabilities = getCollectionCapabilities(userId, collection, grants, ctx.now);
  if (!capabilities.has("view")) throw notFound("Collection");
  const members = (await ctx.repo.getMediaByIds(collection.mediaIds)).filter((media) => media.status !== "deleted");
  const videos = members.filter((media) => videoQuery.search.length === 0 || mediaMatchesSearch(media, videoQuery.search)).sort((a, b) => compareMedia(videoQuery.sort, a, b));
  const ownCycles = capabilities.has("use_in_cycle") ? await ctx.repo.listCyclesForOwner(userId) : [];
  const collectionCard = await toCollectionCard(ctx, userId, collection);
  collectionCard.capabilities = [...capabilities];
  return {
    collection: collectionCard, videos: videos.map(toMediaCard), memberIds: members.map((media) => media.id),
    itemSettings: [], settingsVersion: 1, captionMode: "individual", sharedCaptionText: "", coverMode: "individual", sharedCoverMediaId: null, coverChoices: [],
    permissions: { canUseInCycle: capabilities.has("use_in_cycle"), canImport: capabilities.has("import_copy"), canRequestImport: false, canDownload: capabilities.has("download"), isOwner: false },
    cycleChoices: ownCycles.filter((cycle) => cycle.status === "draft" || cycle.status === "running" || cycle.status === "paused").map((cycle) => ({ id: cycle.id, name: cycle.name })),
    libraryChoices: [], videoSearch: videoQuery.search, videoSort: videoQuery.sort, videoFiltered: videoQuery.filtered,
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

export interface CycleDetail { cycle: Pick<CycleRecord, "id" | "name" | "status" | "scheduleSettings" | "timezone" | "orderMode">; scheduleStartDate: string; items: CycleItem[]; mediaTitles: Record<string, string>; mediaOrderData: Record<string, { title: string; sizeBytes: number; createdAt: string }>; renderOutputsByItemId: Record<string, RenderOutputRecord[]>; selectedRenderOutputAvailableByItemId: Record<string, boolean>; report: PreflightReport; /** Images the user owns that can be used as covers. */ coverChoices: MediaCard[]; /** True when only the final confirmation is missing (every other check passes). */ readyToConfirm: boolean; publishing: CyclePublishingStatus; }

export async function getCycleDetail(ctx: RequestContext, cycleId: string): Promise<CycleDetail> {
  const userId = requireUser(ctx);
  const cycle = await ctx.repo.getCycle(cycleId);
  if (!cycle || cycle.ownerId !== userId) throw notFound("Publishing cycle");
  const items = await ctx.repo.getCycleItems(cycleId);
  const media = await ctx.repo.getMediaByIds([...new Set(items.map((i) => i.mediaAssetId))]);
  const mediaTitles: Record<string, string> = {};
  const mediaOrderData: CycleDetail["mediaOrderData"] = {};
  for (const m of media) {
    mediaTitles[m.id] = m.title ?? "Untitled";
    mediaOrderData[m.id] = { title: m.title ?? "Untitled", sizeBytes: m.sizeBytes, createdAt: (m.createdAt ?? new Date(0)).toISOString() };
  }
  const renderOutputsByItemId: CycleDetail["renderOutputsByItemId"] = {};
  const selectedRenderOutputAvailableByItemId: Record<string, boolean> = {};
  const renderOutputsBySource = new Map<string, Awaited<ReturnType<Repository["listRenderOutputsForOwnerAndSource"]>>>();
  for (const item of items) {
    if (!renderOutputsBySource.has(item.mediaAssetId)) {
      const candidates = await ctx.repo.listRenderOutputsForOwnerAndSource(userId, item.mediaAssetId);
      const available = [];
      for (const candidate of candidates) {
        const output = await ctx.repo.getRenderOutput(candidate.id);
        const metadata = output && ctx.media && !ctx.media.unavailable ? await ctx.media.storage.getPrivateMetadata(output.storageKey).catch(() => null) : null;
        if (output?.ownerId === userId && output.sourceMediaId === item.mediaAssetId && metadata?.sizeBytes === candidate.sizeBytes) available.push(candidate);
      }
      renderOutputsBySource.set(item.mediaAssetId, available);
    }
    renderOutputsByItemId[item.id] = renderOutputsBySource.get(item.mediaAssetId) ?? [];
    if (item.selectedRenderOutputId) {
      const output = await ctx.repo.getRenderOutput(item.selectedRenderOutputId);
      const metadata = output && output.ownerId === userId && output.sourceMediaId === item.mediaAssetId && ctx.media && !ctx.media.unavailable
        ? await ctx.media.storage.getPrivateMetadata(output.storageKey).catch(() => null)
        : null;
      selectedRenderOutputAvailableByItemId[item.id] = !!output && output.ownerId === userId && output.sourceMediaId === item.mediaAssetId && !!metadata && metadata.sizeBytes === output.sizeBytes;
    } else selectedRenderOutputAvailableByItemId[item.id] = false;
  }
  // Shown as information only: the cycle is NOT started by viewing it.
  const report = await buildPreflightReport(ctx, userId, cycle, items, cycle.finalReviewConfirmed);
  const coverChoices = (await ctx.repo.listMediaForOwner(userId, { limit: 50, offset: 0, kind: "image" })).items.map(toMediaCard);
  const readyToConfirm = report.checks.every((c) => c.id === "final_review" || c.level === "ready" || c.level === "recommendation");
  const ownedAccount = accountBelongsTo(await ctx.repo.getSocialAccount(cycle.socialAccountId), userId);
  const jobs = await ctx.repo.listPublishingJobsForAccount(userId, cycle.socialAccountId);
  const definiteFailureStreak = consecutiveDefiniteFailures(jobs);
  const pause = ownedAccount ? shouldPauseForAccount({ status: ownedAccount.status, consecutiveDefiniteFailures: definiteFailureStreak }) : { pause: false, reason: null };
  const expiresAt = ownedAccount?.tokenExpiresAt ?? null;
  const publishing: CyclePublishingStatus = {
    repeatBehavior: cycle.repeatBehavior ?? "never",
    accountStatus: ownedAccount?.status ?? null,
    tokenExpiresAt: expiresAt ? expiresAt.toISOString().slice(0, 10) : null,
    tokenExpired: expiresAt !== null && expiresAt <= ctx.now,
    missingPermissions: ownedAccount ? missingInstagramScopes(ownedAccount.grantedScopes) : [],
    definiteFailureStreak,
    pauseReason: pause.pause ? pause.reason : null,
    eligibleUnpublishedCount: itemsEligibleForRepeat(items).length,
  };
  const timeZone = cycle.timezone ?? cycle.scheduleSettings?.timeZone ?? "Asia/Kolkata";
  return { cycle: { id: cycle.id, name: cycle.name, status: cycle.status, scheduleSettings: cycle.scheduleSettings ?? null, timezone: timeZone, orderMode: cycle.orderMode ?? cycle.scheduleSettings?.orderMode ?? "manual" }, scheduleStartDate: cycle.scheduleSettings?.startDate ?? localDateKey(localDateOf(timeZone, ctx.now)), items, mediaTitles, mediaOrderData, renderOutputsByItemId, selectedRenderOutputAvailableByItemId, report, coverChoices, readyToConfirm, publishing };
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
  status: "connected" | "token_expired" | "revoked" | "disconnected" | "unknown";
  accountType: string | null;
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  hasToken: boolean;
  eligibilityStatus: "connected_eligible" | "not_connected" | "missing_permissions" | "unsupported_personal" | "unsupported_account_type" | "expired_connection" | "reconnection_required";
}

/** Accounts for the Instagram page. Tokens and external ids are not included. */
export async function getInstagramAccounts(ctx: RequestContext): Promise<InstagramAccountCard[]> {
  const userId = requireUser(ctx);
  const accounts = await ctx.repo.listSocialAccountsForOwner(userId);
  return accounts.map((account) => {
    const grantedScopes = normalizeInstagramScopes(account.grantedScopes).scopes;
    const eligibility = evaluateInstagramEligibility({ platform: account.platform, status: account.status, accountType: account.accountType, grantedScopes, hasToken: account.hasToken, tokenExpiresAt: account.tokenExpiresAt, now: ctx.now });
    const status: InstagramAccountCard["status"] = ["connected", "token_expired", "revoked", "disconnected"].includes(account.status) ? account.status : "unknown";
    let eligibilityStatus: InstagramAccountCard["eligibilityStatus"];
    if (status === "token_expired") eligibilityStatus = "expired_connection";
    else if (status === "disconnected") eligibilityStatus = "not_connected";
    else if (status !== "connected") eligibilityStatus = "reconnection_required";
    else if (account.accountType === "PERSONAL") eligibilityStatus = "unsupported_personal";
    else if (eligibility.reason === "unsupported_account_type" || eligibility.reason === "unsupported_platform") eligibilityStatus = "unsupported_account_type";
    else if (eligibility.reason === "missing_permissions") eligibilityStatus = "missing_permissions";
    else if (eligibility.reason === "expired_token") eligibilityStatus = "expired_connection";
    else if (eligibility.eligible) eligibilityStatus = "connected_eligible";
    else eligibilityStatus = "reconnection_required";
    return {
      id: account.id,
      username: account.username ?? null,
      status,
      accountType: account.accountType ?? null,
      grantedScopes,
      tokenExpiresAt: account.tokenExpiresAt ? account.tokenExpiresAt.toISOString().slice(0, 10) : null,
      hasToken: account.hasToken === true,
      eligibilityStatus,
    };
  });
}

/** The user's own connected accounts for the "new cycle" form. External ids are never shown. */
export async function getCycleCreationOptions(ctx: RequestContext): Promise<{ accounts: { id: string; label: string }[] }> {
  const userId = requireUser(ctx);
  const accounts = await ctx.repo.listSocialAccountsForOwner(userId);
  return { accounts: accounts.filter((a) => a.status === "connected").map((a, index) => ({ id: a.id, label: `Connected account ${index + 1}` })) };
}

export interface MediaDetail { media: MediaCard; mimeType: string | null; addedAt: Date | null; status?: MediaAsset["status"]; deleteAfter?: Date | null; importedCopy?: boolean; }

/** Details of ONE of your own files. Someone else's file looks exactly like a missing one. */
export async function getMediaDetail(ctx: RequestContext, mediaId: string): Promise<MediaDetail> {
  const userId = requireUser(ctx);
  const media = await ctx.repo.getMedia(mediaId);
  if (!media || media.ownerId !== userId || media.status === "deleted") throw notFound("File");
  return { media: toMediaCard(media), mimeType: media.mimeType ?? null, addedAt: media.createdAt ?? null, status: media.status, deleteAfter: media.deleteAfter, importedCopy: Boolean(media.importedFromId) };
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

async function jobFor(ctx: RequestContext, userId: string, jobId: string | undefined, mediaId: string | undefined): Promise<EditorPageData["job"]> {
  if (!jobId) return null;
  const job = await ctx.repo.getRenderJobForOwner(jobId, userId);
  if (!job) return null;
  const status = job.status === "queued" ? "queued" : job.status === "running" ? "processing" : job.status === "succeeded" ? "completed" : "failed";
  const refreshPath = mediaId && (status === "queued" || status === "processing") ? `/editor?media=${encodeURIComponent(mediaId)}&job=${encodeURIComponent(job.id)}` : null;
  return { id: job.id, status, message: job.errorMessage, outputId: job.outputDerivativeId, refreshPath };
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
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const plan = getPlan(planId);
  const [storedTemplates, videos, images] = await Promise.all([ctx.repo.listTemplatesForOwner(userId), ctx.repo.listMediaForOwner(userId, { limit: 12, offset: 0, kind: "video" }), ctx.repo.listMediaForOwner(userId, { limit: 50, offset: 0, kind: "image" })]);
  const templates = storedTemplates.filter((template) => !isReservedTemplateName(template.name));
  const common = { videoChoices: videos.items.map(toMediaCard), logoChoices: images.items.map(toMediaCard), templates: templates.map((t) => ({ id: t.id, name: t.name, summary: describeSettings(t.settings) })), templateLimit: plan.limits.templates, maxResolution: plan.features.maxResolution, exports: await verifiedExports(ctx, userId), job: await jobFor(ctx, userId, typeof input.search?.["job"] === "string" ? input.search["job"] : undefined, input.mediaId) };
  if (!input.mediaId) return { ...common, source: null, settings: parseEditorQuery(undefined).settings, settingsSource: "saved" as const, problems: [], layout: null, assumedSourceSize: false, logoAspect: 1 };

  const media = await ctx.repo.getMedia(input.mediaId);
  if (!media || media.ownerId !== userId || media.status === "deleted" || (media.kind ?? "video") !== "video") throw notFound("Video");

  const savedRow = storedTemplates.find((template) => template.name === videoSettingsName(media.id));
  const savedParsed = savedRow ? parseEditingSettings(savedRow.settings) : { ok: true as const, settings: parseEditorQuery(undefined).settings };
  const savedSettings = savedParsed.ok ? savedParsed.settings : parseEditorQuery(undefined).settings;
  const templateId = typeof input.search?.["template"] === "string" ? input.search["template"] : undefined;
  const previewKeys = ["aspect", "zoom", "offsetX", "offsetY", "trimStart", "trimEnd", "bg", "bgColor", "bgImage", "blur", "borderPx", "borderColor", "logoMedia", "logoWidth", "logoX", "logoY", "logoOpacity"];
  const previewing = previewKeys.some((key) => typeof input.search?.[key] === "string");
  const fromTemplate = templateId && !previewing ? templates.find((t) => t.id === templateId)?.settings : undefined;
  const parsed = fromTemplate ? { settings: fromTemplate, problems: [] as string[] } : previewing ? parseEditorQuery(input.search) : { settings: savedSettings, problems: savedParsed.ok ? [] : ["Saved settings could not be read, so the defaults are shown."] };
  const settingsSource = fromTemplate ? "template" as const : previewing ? "preview" as const : "saved" as const;
  let { settings } = parsed; const problems = [...parsed.problems];
  if (typeof media.durationMs === "number" && media.durationMs > 0) {
    const trimProblems = trimDurationProblems(settings.trim, media.durationMs / 1000);
    if (trimProblems.length > 0) { problems.push(...trimProblems); settings = { ...settings, trim: DEFAULT_EDITING_SETTINGS.trim }; }
  }
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
