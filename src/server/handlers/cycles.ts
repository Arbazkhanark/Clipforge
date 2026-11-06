// Creating cycles, mixing/unmixing videos, and starting a cycle.
import { getPlan } from "../../lib/billing/catalog.ts";
import { checkLimit } from "../../lib/billing/entitlements.ts";
import { mixVideosIntoCycle, unmixItems, type MixCandidate, type MixRejection } from "../../lib/domain/mix-unmix.ts";
import type { PreflightReport } from "../../lib/domain/preflight.ts";
import { startCycle as startCycleRule } from "../../lib/domain/cycle-state.ts";
import type { RepeatBehavior } from "../../lib/domain/publish-workflow.ts";
import type { CollectionPermissionGrant, CycleItem, VideoCollection } from "../../lib/domain/types.ts";
import { buildPreflightReport } from "../preflight-service.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, forbidden, notFound, planLimit } from "../errors.ts";
import { Problems, readBoolean, readId, readIdList, readObject, readText } from "../validation.ts";

async function loadOwnedCycle(ctx: RequestContext, userId: string, cycleId: string) {
  const cycle = await ctx.repo.getCycle(cycleId);
  if (!cycle || cycle.ownerId !== userId) throw notFound("Publishing cycle");
  return cycle;
}

export async function createCycle(ctx: RequestContext, rawInput: unknown): Promise<{ cycleId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 });
  const socialAccountId = readId(input, "socialAccountId", problems);
  problems.throwIfAny();

  const account = await ctx.repo.getSocialAccount(socialAccountId);
  if (!account || account.userId !== userId) throw notFound("Social account");

  const planId = await ctx.repo.getPlanIdForUser(userId);
  const limit = checkLimit(planId, "activeCampaigns", await ctx.repo.countActiveCycles(userId), 1);
  if (!limit.allowed) throw planLimit(limit.message);

  const cycleId = ctx.newId();
  await ctx.repo.createCycle({ id: cycleId, ownerId: userId, status: "draft", finalReviewConfirmed: false, name: name.trim(), socialAccountId });
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.created", entityType: "PublishingCycle", entityId: cycleId });
  return { cycleId };
}

export async function setCycleRepeat(ctx: RequestContext, rawInput: unknown): Promise<{ repeatBehavior: RepeatBehavior }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const repeatBehavior = input["repeatBehavior"];
  if (repeatBehavior !== "never" && repeatBehavior !== "ask" && repeatBehavior !== "automatic") {
    problems.add("repeatBehavior must be never, ask, or automatic.");
    problems.throwIfAny();
    throw new Error("unreachable");
  }
  problems.throwIfAny();
  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status === "stopped" || cycle.status === "completed") throw forbidden("This cycle has ended.");
  const saved = await ctx.repo.updateCycleRepeat(cycleId, userId, repeatBehavior);
  if (!saved) throw notFound("Publishing cycle");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.repeat_updated", entityType: "PublishingCycle", entityId: cycleId, metadata: { repeatBehavior } });
  return { repeatBehavior };
}

export async function mixIntoCycle(ctx: RequestContext, rawInput: unknown): Promise<{ added: number; rejected: MixRejection[] }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const rawVideos = input["videos"];
  const confirmedDuplicateMediaIds = readIdList(input, "confirmedDuplicateMediaIds", problems, { max: 200 });
  const requested: { mediaAssetId: string; collectionId: string; isImportedCopy: boolean }[] = [];
  if (!Array.isArray(rawVideos) || rawVideos.length < 1 || rawVideos.length > 200) problems.add("videos must be a list of 1 to 200 entries.");
  else for (const entry of rawVideos) {
    const entryProblems = new Problems();
    const entryObject = readObject(entry, entryProblems, "Each video");
    const mediaAssetId = readId(entryObject, "mediaAssetId", entryProblems);
    const collectionId = readId(entryObject, "collectionId", entryProblems);
    const isImportedCopy = readBoolean(entryObject, "isImportedCopy", entryProblems, false);
    try { entryProblems.throwIfAny(); requested.push({ mediaAssetId, collectionId, isImportedCopy }); } catch { problems.add("Each video needs a valid mediaAssetId and collectionId."); break; }
  }
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status === "stopped" || cycle.status === "completed") throw forbidden("This cycle has ended; start a new one to add videos.");

  const planId = await ctx.repo.getPlanIdForUser(userId);
  const plan = getPlan(planId);
  const batch = checkLimit(planId, "batchSize", 0, requested.length);
  if (!batch.allowed) throw planLimit(`Your plan allows adding up to ${batch.limit} videos at a time.`);

  // Load every video + collection. Anything missing or unreachable is rejected WITHOUT saying which part was missing.
  const candidates: MixCandidate[] = [];
  const unavailable: MixRejection[] = [];
  const grantsByCollection = new Map<string, CollectionPermissionGrant[]>();
  const collectionCache = new Map<string, VideoCollection | null>();
  for (const video of requested) {
    if (!collectionCache.has(video.collectionId)) collectionCache.set(video.collectionId, await ctx.repo.getCollection(video.collectionId));
    const collection = collectionCache.get(video.collectionId) ?? null;
    const media = await ctx.repo.getMedia(video.mediaAssetId);
    if (!collection || !media) { unavailable.push({ mediaAssetId: video.mediaAssetId, reason: "This video is not available to you." }); continue; }
    if (!grantsByCollection.has(collection.id)) grantsByCollection.set(collection.id, await ctx.repo.getGrants(collection.id));
    candidates.push({ media, collection, isImportedCopy: video.isImportedCopy });
  }
  const existingItems = await ctx.repo.getCycleItems(cycleId);
  const allGrants = [...grantsByCollection.values()].flat();

  const mixed = mixVideosIntoCycle({ userId, candidates, existingItems, grants: allGrants, planFeatures: plan.features, confirmedDuplicateMediaIds, now: ctx.now });
  const newItems: CycleItem[] = mixed.accepted.map((draft) => ({
    id: ctx.newId(), cycleId, cycleOwnerId: userId, mediaAssetId: draft.mediaAssetId, sourceKind: draft.sourceKind, sourceCollectionId: draft.sourceCollectionId,
    status: "upcoming", position: draft.position, version: 1, scheduledFor: null, captionText: "", captionSource: "none",
    coverMediaId: null, coverIsCustom: false, coverState: "none", lockedBy: null, lockExpiresAt: null, reviewReason: null,
  }));
  if (newItems.length > 0) await ctx.repo.addCycleItems(newItems);
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.videos_mixed", entityType: "PublishingCycle", entityId: cycleId, metadata: { added: newItems.length, rejected: mixed.rejected.length + unavailable.length } });
  return { added: newItems.length, rejected: [...unavailable, ...mixed.rejected] };
}

export async function unmixFromCycle(ctx: RequestContext, rawInput: unknown): Promise<{ removedItemIds: string[]; blocked: { itemId: string; reason: string }[] }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const itemIds = readIdList(input, "itemIds", problems, { min: 1, max: 500 });
  problems.throwIfAny();

  await loadOwnedCycle(ctx, userId, cycleId);
  const items = await ctx.repo.getCycleItems(cycleId);
  const outcome = unmixItems(items, itemIds);

  const beforeById = new Map(items.map((i) => [i.id, i]));
  const updates = outcome.items.filter((i) => outcome.removedItemIds.includes(i.id)).map((item) => ({ item, expectedVersion: (beforeById.get(item.id) as CycleItem).version }));
  const saved = updates.length > 0 ? await ctx.repo.saveCycleItemsIfVersionMatches(updates) : [];
  const savedIds = new Set(saved.filter((s) => s.saved).map((s) => s.itemId));
  const blocked = [...outcome.blocked, ...outcome.removedItemIds.filter((id) => !savedIds.has(id)).map((itemId) => ({ itemId, reason: "This item changed while removing it (it may have just started publishing). Reload to see its status." }))];
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.videos_unmixed", entityType: "PublishingCycle", entityId: cycleId, metadata: { removed: savedIds.size, blocked: blocked.length } });
  return { removedItemIds: [...savedIds], blocked };
}

export async function startPublishingCycle(ctx: RequestContext, rawInput: unknown): Promise<{ status: "running"; report: PreflightReport }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const confirmFinalReview = readBoolean(input, "confirmFinalReview", problems, false);
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  const items = await ctx.repo.getCycleItems(cycleId);
  const report = await buildPreflightReport(ctx, userId, cycle, items, confirmFinalReview);
  if (!report.canStart) throw new AppError(409, "preflight_failed", "This cycle cannot start yet.", { report });

  const rule = startCycleRule({ ...cycle, finalReviewConfirmed: confirmFinalReview }, items);
  if (!rule.ok) throw conflict(rule.reason);
  // Compare-and-set: if two requests start the same cycle, exactly one wins.
  const won = await ctx.repo.transitionCycleStatus(cycleId, "draft", "running", true);
  if (!won) throw conflict("This cycle was already started or changed. Reload to see its current state.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.started", entityType: "PublishingCycle", entityId: cycleId, metadata: { items: items.length } });
  return { status: "running", report };
}
