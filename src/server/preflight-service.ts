// Builds the preflight report for a cycle from repository data. Shared by the "start cycle" handler
// and the cycle screen, so both always show the same answer.
import { getPlan } from "../lib/billing/catalog.ts";
import { runPreflight, type PreflightReport } from "../lib/domain/preflight.ts";
import { consecutiveDefiniteFailures } from "../lib/domain/publish-workflow.ts";
import { canKeepUsingSourceForCycleItem } from "../lib/domain/sharing-permissions.ts";
import { monthStartUtc } from "../lib/domain/usage-accounting.ts";
import type { CycleItem, Decision } from "../lib/domain/types.ts";
import type { RequestContext } from "./context.ts";
import type { CycleRecord } from "./repository.ts";

export async function buildPreflightReport(ctx: RequestContext, userId: string, cycle: CycleRecord, items: CycleItem[], confirmFinalReview: boolean): Promise<PreflightReport> {
  const account = await ctx.repo.getSocialAccount(cycle.socialAccountId);
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);

  // Re-check every item's source RIGHT NOW (permission may have been revoked since it was added).
  const sourceAccessByItemId: Record<string, Decision> = {};
  const mediaByItemId: Record<string, { kind?: "video" | "image"; mimeType?: string; durationMs?: number | null; sizeBytes?: number }> = {};
  const temporaryMediaAccessByItemId: Record<string, import("../lib/domain/preflight.ts").PublishingMediaAccessState> = {};
  for (const item of items) {
    const media = await ctx.repo.getMedia(item.mediaAssetId);
    const collection = item.sourceCollectionId ? await ctx.repo.getCollection(item.sourceCollectionId) : null;
    const grants = collection ? await ctx.repo.getGrants(collection.id) : [];
    sourceAccessByItemId[item.id] = canKeepUsingSourceForCycleItem(item, media, collection, grants, ctx.now);
    const selectedOutput = item.selectedRenderOutputId ? await ctx.repo.getRenderOutput(item.selectedRenderOutputId) : null;
    const storedMetadata = selectedOutput && ctx.media && !ctx.media.unavailable
      ? await ctx.media.storage.getPrivateMetadata(selectedOutput.storageKey).catch(() => null)
      : null;
    const outputMatchesItem = selectedOutput?.ownerId === userId && selectedOutput.sourceMediaId === item.mediaAssetId;
    temporaryMediaAccessByItemId[item.id] = !item.selectedRenderOutputId
      ? { status: "media_not_eligible" }
      : !selectedOutput
        ? { status: "media_not_available" }
        : !outputMatchesItem
          ? { status: "media_not_eligible" }
          : !storedMetadata || storedMetadata.sizeBytes !== selectedOutput.sizeBytes
            ? { status: "media_not_available" }
            : ctx.publishingMediaAccess
              ? { status: "temporary_access_deferred" }
              : { status: "temporary_access_not_configured" };
    // Source eligibility is independent of whether a user has selected a render yet. Without this,
    // every valid video with no selected derivative was misreported as a non-video.
    if (media) mediaByItemId[item.id] = {
      kind: media.kind,
      mimeType: media.mimeType,
      ...(selectedOutput && outputMatchesItem ? {
        ...(media.durationMs != null ? { durationMs: media.durationMs } : {}),
        sizeBytes: selectedOutput.sizeBytes,
      } : {}),
    };
  }
  const ownedAccount = account && account.userId === userId ? account : null;
  const failureJobs = ownedAccount ? await ctx.repo.listPublishingJobsForAccount(userId, cycle.socialAccountId) : [];
  return runPreflight({
    cycle: { ...cycle, finalReviewConfirmed: confirmFinalReview }, items,
    socialAccountStatus: ownedAccount ? ownedAccount.status : null,
    scheduledItemsPerMonthLimit: getPlan(planId).limits.scheduledItemsPerMonth,
    scheduledItemsUsedThisMonth: await ctx.repo.getScheduledItemsUsedThisMonth(userId, monthStartUtc(ctx.now)),
    coverSupport: ctx.config.coverSupport, sourceAccessByItemId,
    recentPublishTimes: await ctx.repo.getRecentPublishTimes(userId, new Date(ctx.now.getTime() - 24 * 3_600_000)),
    ...(ownedAccount ? { instagram: {
      platform: ownedAccount.platform,
      now: ctx.now,
      hasStoredToken: ownedAccount.hasToken === true,
      accountType: ownedAccount.accountType ?? null,
      grantedScopes: ownedAccount.grantedScopes ?? [],
      tokenExpiresAt: ownedAccount.tokenExpiresAt ?? null,
      mediaByItemId,
      temporaryMediaAccessConfigured: ctx.publishingMediaAccess !== undefined,
      temporaryMediaAccessByItemId,
      consecutiveDefiniteFailures: consecutiveDefiniteFailures(failureJobs),
      repeatBehavior: cycle.repeatBehavior ?? "never",
    } } : {}),
  });
}
