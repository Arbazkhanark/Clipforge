// Builds the preflight report for a cycle from repository data. Shared by the "start cycle" handler
// and the cycle screen, so both always show the same answer.
import { getPlan } from "../lib/billing/catalog.ts";
import { runPreflight, type PreflightReport } from "../lib/domain/preflight.ts";
import { canKeepUsingSourceForCycleItem } from "../lib/domain/sharing-permissions.ts";
import { monthStartUtc } from "../lib/domain/usage-accounting.ts";
import type { CycleItem, Decision } from "../lib/domain/types.ts";
import type { RequestContext } from "./context.ts";
import type { CycleRecord } from "./repository.ts";

export async function buildPreflightReport(ctx: RequestContext, userId: string, cycle: CycleRecord, items: CycleItem[], confirmFinalReview: boolean): Promise<PreflightReport> {
  const account = await ctx.repo.getSocialAccount(cycle.socialAccountId);
  const planId = await ctx.repo.getPlanIdForUser(userId);

  // Re-check every item's source RIGHT NOW (permission may have been revoked since it was added).
  const sourceAccessByItemId: Record<string, Decision> = {};
  for (const item of items) {
    const media = await ctx.repo.getMedia(item.mediaAssetId);
    const collection = item.sourceCollectionId ? await ctx.repo.getCollection(item.sourceCollectionId) : null;
    const grants = collection ? await ctx.repo.getGrants(collection.id) : [];
    sourceAccessByItemId[item.id] = canKeepUsingSourceForCycleItem(item, media, collection, grants, ctx.now);
  }
  return runPreflight({
    cycle: { ...cycle, finalReviewConfirmed: confirmFinalReview }, items,
    socialAccountStatus: account && account.userId === userId ? account.status : null,
    scheduledItemsPerMonthLimit: getPlan(planId).limits.scheduledItemsPerMonth,
    scheduledItemsUsedThisMonth: await ctx.repo.getScheduledItemsUsedThisMonth(userId, monthStartUtc(ctx.now)),
    coverSupport: ctx.config.coverSupport, sourceAccessByItemId,
    recentPublishTimes: await ctx.repo.getRecentPublishTimes(userId, new Date(ctx.now.getTime() - 24 * 3_600_000)),
  });
}
