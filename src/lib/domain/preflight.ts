// Smart Publishing Assistant: pre-start checks for a publishing cycle.
// It only reports problems found by OUR OWN rules. It never invents platform limits;
// anything about Instagram that is not verified is phrased as "could not confirm".
import { validateCaption, type CoverSupport } from "./caption-cover-updates.ts";
import { isEditableItem } from "./cycle-state.ts";
import { INSTAGRAM_SCHEDULE_ESTIMATE, INSTAGRAM_VERIFIED, findPublishQuotaViolations } from "../integrations/instagram-capabilities.ts";
import { evaluateInstagramEligibility, missingInstagramScopes } from "../integrations/instagram-eligibility.ts";
import { REPEATED_DEFINITE_FAILURES_BEFORE_PAUSE, type RepeatBehavior } from "./publish-workflow.ts";
import type { CycleItem, Decision, PublishingCycle } from "./types.ts";

export type PreflightLevel = "ready" | "recommendation" | "action_required" | "blocked";
const LEVEL_SEVERITY: Record<PreflightLevel, number> = { ready: 0, recommendation: 1, action_required: 2, blocked: 3 };

export interface PreflightCheck {
  id: string;
  level: PreflightLevel;
  message: string;
  /** Items the message is about, so the UI can highlight them. */
  itemIds: string[];
}

export type PublishingMediaAccessStatus = "media_not_available" | "media_not_eligible" | "temporary_access_not_configured" | "temporary_access_expired" | "temporary_media_access_ready";
export interface PublishingMediaAccessState { status: PublishingMediaAccessStatus; publiclyReachable?: boolean; }

export interface PreflightInput {
  cycle: PublishingCycle;
  items: CycleItem[];
  socialAccountStatus: unknown;
  scheduledItemsPerMonthLimit: number;
  scheduledItemsUsedThisMonth: number;
  coverSupport: CoverSupport;
  /** Result of canKeepUsingSourceForCycleItem() for each item, computed by the server just now. */
  sourceAccessByItemId: Record<string, Decision>;
  /** Optional: times of posts already published recently (for the rolling 24-hour quota check). */
  recentPublishTimes?: Date[];
  /** Reference value for a non-blocking local schedule estimate; publishing worker performs the live account check. */
  publishLimitPer24h?: number;
  /**
   * Present when the server knows which Instagram account this cycle uses.
   * Omitted by older callers. A missing token does not block a local cycle start.
   */
  instagram?: {
    platform: unknown;
    now: Date;
    hasStoredToken: unknown;
    accountType: unknown;
    grantedScopes: unknown;
    tokenExpiresAt: Date | null;
    mediaByItemId: Record<string, { kind?: "video" | "image"; mimeType?: string; durationMs?: number | null; sizeBytes?: number }>;
    temporaryMediaAccessConfigured?: boolean;
    temporaryMediaAccessByItemId?: Record<string, PublishingMediaAccessState>;
    consecutiveDefiniteFailures: number;
    repeatBehavior: RepeatBehavior;
  };
}

export interface PreflightReport {
  overall: PreflightLevel;
  /** The cycle may start only when nothing is blocked or needs action. Recommendations never block. */
  canStart: boolean;
  checks: PreflightCheck[];
}

export function runPreflight(input: PreflightInput): PreflightReport {
  const { cycle, items, socialAccountStatus, sourceAccessByItemId } = input;
  const checks: PreflightCheck[] = [];
  const add = (id: string, level: PreflightLevel, message: string, itemIds: string[] = []) => checks.push({ id, level, message, itemIds });

  const upcomingItems = items.filter(isEditableItem);

  // 1. Account
  if (socialAccountStatus === null || socialAccountStatus === undefined) add("account", "blocked", "No social account is selected.");
  else if (socialAccountStatus !== "connected") add("account", "blocked", "The social account needs to be reconnected before publishing.");
  else add("account", "ready", "Social account is connected.");

  // 2. Something to publish
  if (upcomingItems.length === 0) add("items", "blocked", "There are no upcoming videos in this cycle.");

  // 3. Source access (permission, deletion, removal) - re-checked right now
  const lostAccess = upcomingItems.filter((i) => sourceAccessByItemId[i.id]?.allowed !== true);
  if (lostAccess.length > 0) add("source_access", "blocked", `${lostAccess.length} video(s) can no longer be used: ${sourceAccessByItemId[lostAccess[0]!.id]?.reason ?? "access could not be checked"}`, lostAccess.map((i) => i.id));

  // 4. Items that already need a human
  const needHuman = items.filter((i) => i.status === "needs_review" || i.status === "failed");
  if (needHuman.length > 0) add("needs_review", "action_required", `${needHuman.length} item(s) failed or need review before you continue.`, needHuman.map((i) => i.id));

  // 5. Plan allowance for scheduled items
  const remaining = input.scheduledItemsPerMonthLimit - input.scheduledItemsUsedThisMonth;
  if (upcomingItems.length > remaining) add("plan_limit", "action_required", `Your plan has ${Math.max(0, remaining)} scheduled item(s) left this month, but this cycle has ${upcomingItems.length}.`);

  // 6. Captions
  const badCaptions = upcomingItems.filter((i) => !validateCaption(i.captionText).valid);
  if (badCaptions.length > 0) add("caption_invalid", "action_required", `${badCaptions.length} caption(s) break the caption rules we check.`, badCaptions.map((i) => i.id));
  const emptyCaptions = upcomingItems.filter((i) => i.captionText.trim() === "");
  if (emptyCaptions.length > 0) add("caption_empty", "recommendation", `${emptyCaptions.length} upcoming item(s) have no caption.`, emptyCaptions.map((i) => i.id));

  // 7. Covers - honest about uncertainty
  const withCover = upcomingItems.filter((i) => i.coverMediaId !== null);
  if (withCover.length > 0 && input.coverSupport !== "supported") {
    add("cover_support", "recommendation", input.coverSupport === "unsupported"
      ? "Instagram does not accept custom covers for this publishing method. Your chosen covers are saved in ClipForge but will not appear on Instagram."
      : "We could not confirm that Instagram will accept custom covers. They are saved in ClipForge but not guaranteed to appear.", withCover.map((i) => i.id));
  }

  // 8. Duplicates
  const countByMedia = new Map<string, string[]>();
  for (const item of items.filter((i) => i.status !== "cancelled")) countByMedia.set(item.mediaAssetId, [...(countByMedia.get(item.mediaAssetId) ?? []), item.id]);
  const duplicateItemIds = [...countByMedia.values()].filter((ids) => ids.length > 1).flat();
  if (duplicateItemIds.length > 0) add("duplicates", "recommendation", "The same video appears more than once. Make sure the repeat is intended.", duplicateItemIds);

  // 9. Advisory schedule estimate only. The worker queries live account quota immediately before publish.
  const plannedTimes = upcomingItems.flatMap((i) => (i.scheduledFor ? [i.scheduledFor] : []));
  const quotaLimit = input.publishLimitPer24h ?? INSTAGRAM_SCHEDULE_ESTIMATE.publishLimitPer24h;
  const violations = findPublishQuotaViolations([...(input.recentPublishTimes ?? []), ...plannedTimes], quotaLimit);
  if (violations.length > 0) add("platform_quota", "recommendation", `This local estimate places ${violations[0]!.count} posts inside one 24-hour period using a ${quotaLimit}-post reference value. Published limits differ; the worker checks the account's live quota before each publish.`);

  // 10. Instagram account, token, permissions, and Reel media. Only when the server supplied account facts.
  const instagram = input.instagram;
  if (instagram) {
    const guide = `Instagram's Content Publishing guide (read ${INSTAGRAM_VERIFIED.readOn})`;
    const eligibility = evaluateInstagramEligibility({ platform: instagram.platform, status: socialAccountStatus, accountType: instagram.accountType, grantedScopes: instagram.grantedScopes, hasToken: instagram.hasStoredToken, tokenExpiresAt: instagram.tokenExpiresAt, now: instagram.now });
    if (!instagram.hasStoredToken) {
      add("instagram_token", "blocked", "No Instagram access token is stored. Reconnect the account before publishing.");
    } else add("instagram_token", "ready", "An encrypted Instagram access token is stored on the server.");
    if (!(instagram.tokenExpiresAt instanceof Date) || Number.isNaN(instagram.tokenExpiresAt.getTime())) add("instagram_token_expiry", "blocked", "This token has no valid expiry time, so ClipForge will not treat it as eligible.");
    else if (instagram.tokenExpiresAt <= instagram.now) add("instagram_token_expiry", "blocked", "The Instagram token has expired. Reconnect the account.");
    else if (instagram.tokenExpiresAt.getTime() - instagram.now.getTime() <= 7 * 24 * 60 * 60 * 1000) add("instagram_token_expiry", "recommendation", "The Instagram token expires within 7 days. That warning is a ClipForge reminder, not a Meta limit.");
    else add("instagram_token_expiry", "ready", "The stored Instagram token has not expired.");
    if (eligibility.reason === "unsupported_account_type") add("instagram_account_type", "blocked", `${guide} allows publishing only for supported professional accounts. ClipForge could not confirm a supported type.`);
    else add("instagram_account_type", "ready", "This is a supported Instagram professional account.");
    const missingScopes = missingInstagramScopes(instagram.grantedScopes);
    if (missingScopes.length > 0) add("instagram_permissions", "blocked", `Instagram Login is missing verified publishing permissions: ${missingScopes.join(", ")}.`);
    else add("instagram_permissions", "ready", "The required Instagram Login publishing permissions are present.");
    if (eligibility.reason === "not_connected" || eligibility.reason === "unsupported_platform") add("instagram_account_eligibility", "blocked", "This Instagram account is not in a supported connected state.");
    if (eligibility.eligible) add("instagram_eligibility", "ready", "The connected account meets ClipForge's stored eligibility checks.");
    if (instagram.hasStoredToken) {
      const wrongMedia = upcomingItems.filter((item) => {
        const media = instagram.mediaByItemId[item.id];
        if (!media) return true;
        if (media.kind !== "video") return true;
        return media.mimeType !== undefined && !media.mimeType.startsWith("video/");
      });
      if (wrongMedia.length > 0) add("instagram_media", "blocked", `${wrongMedia.length} item(s) are not a video. Reels publishing needs a video.`, wrongMedia.map((item) => item.id));
      const reels = INSTAGRAM_VERIFIED.reels;
      const badDuration = upcomingItems.filter((item) => {
        const durationMs = instagram.mediaByItemId[item.id]?.durationMs;
        if (durationMs == null) return false;
        return durationMs < reels.minDurationSeconds * 1000 || durationMs > reels.maxDurationSeconds * 1000;
      });
      if (badDuration.length > 0) add("instagram_duration", "blocked", `${badDuration.length} video(s) are outside the documented Reel duration of ${reels.minDurationSeconds} seconds to ${reels.maxDurationSeconds / 60} minutes (IG User Media, updated Sep 28, 2026).`, badDuration.map((item) => item.id));
      const unknownDuration = upcomingItems.filter((item) => {
        const media = instagram.mediaByItemId[item.id];
        return media?.kind === "video" && (media.durationMs === undefined || media.durationMs === null);
      });
      if (unknownDuration.length > 0) add("instagram_duration_unknown", "recommendation", "Duration is missing on a video, so the documented 3 second to 15 minute Reel limit could not be checked.", unknownDuration.map((item) => item.id));
      const oversized = upcomingItems.filter((item) => {
        const sizeBytes = instagram.mediaByItemId[item.id]?.sizeBytes;
        return sizeBytes !== undefined && sizeBytes > reels.maxFileBytes;
      });
      if (oversized.length > 0) add("instagram_file_size", "blocked", `${oversized.length} video(s) are over the documented 300MB Reel maximum. ClipForge counts that as ${reels.maxFileBytes} bytes because the page does not define MB.`, oversized.map((item) => item.id));
    }
    if (upcomingItems.length > 0 && instagram.temporaryMediaAccessConfigured !== true) {
      add("temporary_access_not_configured", "blocked", "Temporary media access is not configured. No media URL will be shared with Instagram.", upcomingItems.map((item) => item.id));
    }
    const mediaUnavailable: string[] = [];
    const mediaIneligible: string[] = [];
    const accessExpired: string[] = [];
    const accessNotConfigured: string[] = [];
    const temporaryReady: string[] = [];
    const notPubliclyReachable: string[] = [];
    const publiclyReachable: string[] = [];
    for (const item of upcomingItems) {
      const state = instagram.temporaryMediaAccessByItemId?.[item.id] ?? { status: "temporary_access_not_configured" as const, publiclyReachable: false };
      if (state.status === "media_not_available") mediaUnavailable.push(item.id);
      else if (state.status === "media_not_eligible") mediaIneligible.push(item.id);
      else if (state.status === "temporary_access_not_configured") accessNotConfigured.push(item.id);
      else if (state.status === "temporary_access_expired") accessExpired.push(item.id);
      else {
        temporaryReady.push(item.id);
        (state.publiclyReachable === true ? publiclyReachable : notPubliclyReachable).push(item.id);
      }
    }
    if (mediaUnavailable.length) add("publishing_media_unavailable", "blocked", `${mediaUnavailable.length} selected media file(s) are missing from private storage.`, mediaUnavailable);
    if (mediaIneligible.length) add("publishing_media_ineligible", "blocked", `${mediaIneligible.length} selected item(s) do not have an authorized rendered publishing output. Original uploads remain private.`, mediaIneligible);
    if (accessNotConfigured.length && instagram.temporaryMediaAccessConfigured === true) add("temporary_access_not_configured", "blocked", "Temporary media access is not configured for the selected output.", accessNotConfigured);
    if (accessExpired.length) add("temporary_access_expired", "blocked", `${accessExpired.length} temporary media access URL(s) expired. A fresh authorized URL is required.`, accessExpired);
    if (temporaryReady.length) add("temporary_media_access_ready", "ready", "Temporary access is ready for the selected rendered output.", temporaryReady);
    if (notPubliclyReachable.length) add("instagram_public_url", "blocked", "The temporary URL is a mock or otherwise not publicly reachable by Instagram. It cannot be used for publishing.", notPubliclyReachable);
    if (publiclyReachable.length) add("instagram_public_url", "ready", `${publiclyReachable.length} temporary media URL(s) are reported publicly reachable for the exact selected output.`, publiclyReachable);
    const failureCount = instagram.consecutiveDefiniteFailures;
    add("instagram_failures", failureCount >= REPEATED_DEFINITE_FAILURES_BEFORE_PAUSE ? "action_required" : "ready", `${failureCount} definite publishing failure${failureCount === 1 ? "" : "s"} in a row are stored on PublishingJob records for this account. ClipForge pauses new claims after ${REPEATED_DEFINITE_FAILURES_BEFORE_PAUSE}. That pause is our rule, not an Instagram quota.`);
    if (instagram.repeatBehavior === "automatic") add("repeat_mode", "recommendation", "Repeat mode is automatic. Another round can include only eligible unpublished items. Published, publishing, and processing items stay out. Saving this mode does not send a Reel.");
    else if (instagram.repeatBehavior === "ask") add("repeat_mode", "recommendation", "Repeat mode asks before another round. That round can include only eligible unpublished items. Published videos are not posted again.");
    else add("repeat_mode", "ready", "Repeat mode is off. This cycle will not start again on its own. A repeat can include only eligible unpublished items, and published videos are not posted again.");
  }

  // 11. Final review
  if (!cycle.finalReviewConfirmed) add("final_review", "action_required", "Please review and confirm the final list before starting.");

  const worst = checks.reduce<PreflightLevel>((level, c) => (LEVEL_SEVERITY[c.level] > LEVEL_SEVERITY[level] ? c.level : level), "ready");
  return { overall: worst, canStart: LEVEL_SEVERITY[worst] <= LEVEL_SEVERITY["recommendation"], checks };
}
