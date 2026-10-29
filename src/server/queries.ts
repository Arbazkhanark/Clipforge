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
import { buildPreflightReport } from "./preflight-service.ts";
import type { CycleRecord } from "./repository.ts";

export interface MediaCard { id: string; title: string; kind: "video" | "image"; sizeBytes: number; durationMs: number | null; status: MediaAsset["status"]; }
const toMediaCard = (m: MediaAsset): MediaCard => ({ id: m.id, title: m.title ?? "Untitled", kind: m.kind ?? "video", sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? null, status: m.status });

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

export interface CollectionDetail { collection: CollectionCard; videos: MediaCard[]; permissions: { canUseInCycle: boolean; canImport: boolean; canDownload: boolean; isOwner: boolean }; }

/** A collection you cannot view looks exactly like one that does not exist. */
export async function getCollectionDetail(ctx: RequestContext, collectionId: string): Promise<CollectionDetail> {
  const userId = requireUser(ctx);
  const collection = await ctx.repo.getCollection(collectionId);
  if (!collection) throw notFound("Collection");
  const grants = await ctx.repo.getGrants(collection.id);
  const capabilities = getCollectionCapabilities(userId, collection, grants, ctx.now);
  if (!capabilities.has("view")) throw notFound("Collection");
  const media = (await ctx.repo.getMediaByIds(collection.mediaIds)).filter((m) => m.status !== "deleted");
  return {
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

export interface CycleDetail { cycle: Pick<CycleRecord, "id" | "name" | "status">; items: CycleItem[]; mediaTitles: Record<string, string>; report: PreflightReport; }

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
  return { cycle: { id: cycle.id, name: cycle.name, status: cycle.status }, items, mediaTitles, report };
}
