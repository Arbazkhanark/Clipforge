// Smart Publishing Assistant: pre-start checks for a publishing cycle.
// It only reports problems found by OUR OWN rules. It never invents platform limits;
// anything about Instagram that is not verified is phrased as "could not confirm".
import { validateCaption, type CoverSupport } from "./caption-cover-updates.ts";
import { isEditableItem } from "./cycle-state.ts";
import { INSTAGRAM_VERIFIED, findPublishQuotaViolations } from "../integrations/instagram-capabilities.ts";
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

export interface PreflightInput {
  cycle: PublishingCycle;
  items: CycleItem[];
  socialAccountStatus: "connected" | "token_expired" | "revoked" | "disconnected" | null;
  scheduledItemsPerMonthLimit: number;
  scheduledItemsUsedThisMonth: number;
  coverSupport: CoverSupport;
  /** Result of canKeepUsingSourceForCycleItem() for each item, computed by the server just now. */
  sourceAccessByItemId: Record<string, Decision>;
  /** Optional: times of posts already published recently (for the rolling 24-hour quota check). */
  recentPublishTimes?: Date[];
  /** Maximum API-published posts per rolling 24h. Defaults to the documented 100; override from the live content_publishing_limit later. */
  publishLimitPer24h?: number;
  /**
   * Present when the server knows which Instagram account this cycle uses.
   * Omitted by older callers. A missing token does not block a local cycle start.
   */
  instagram?: {
    now: Date;
    hasStoredToken: boolean;
    accountType: "BUSINESS" | "MEDIA_CREATOR" | "PERSONAL" | "UNKNOWN" | null;
    grantedScopes: string[];
    tokenExpiresAt: Date | null;
    mediaByItemId: Record<string, { kind?: "video" | "image"; mimeType?: string; durationMs?: number | null; sizeBytes?: number }>;
    publicMediaUrlAvailable: boolean;
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
  if (socialAccountStatus === null) add("account", "blocked", "No social account is selected.");
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

  // 9. Instagram's documented rolling 24-hour publishing limit (Meta recommends apps enforce it themselves)
  const plannedTimes = upcomingItems.flatMap((i) => (i.scheduledFor ? [i.scheduledFor] : []));
  const quotaLimit = input.publishLimitPer24h ?? INSTAGRAM_VERIFIED.publishLimitPer24h;
  const violations = findPublishQuotaViolations([...(input.recentPublishTimes ?? []), ...plannedTimes], quotaLimit);
  if (violations.length > 0) add("platform_quota", "action_required", `This schedule would put ${violations[0]!.count} posts inside one 24-hour period; Instagram's documented limit is ${quotaLimit}. Spread the schedule out.`);

  // 10. Instagram account, token, permissions, and Reel media. Only when the server supplied account facts.
  const instagram = input.instagram;
  if (instagram) {
    const guide = `Instagram's Content Publishing guide (read ${INSTAGRAM_VERIFIED.readOn})`;
    if (!instagram.hasStoredToken) {
      add("instagram_token", "recommendation", "No Instagram access token is stored. Starting this cycle updates ClipForge only and does not publish a Reel.");
    } else {
      if (instagram.tokenExpiresAt === null || Number.isNaN(instagram.tokenExpiresAt.getTime())) add("instagram_token_expiry", "action_required", "This token has no expiry time, so ClipForge will not treat it as valid for publishing.");
      else if (instagram.tokenExpiresAt <= instagram.now) add("instagram_token_expiry", "blocked", "The Instagram token has expired. Reconnect the account.");
      else if (instagram.tokenExpiresAt.getTime() - instagram.now.getTime() <= 7 * 24 * 60 * 60 * 1000) add("instagram_token_expiry", "recommendation", "The Instagram token expires within 7 days. That warning is a ClipForge reminder, not a Meta limit.");
      else add("instagram_token_expiry", "ready", "The stored Instagram token has not expired.");
      if (instagram.accountType === "PERSONAL") add("instagram_account_type", "blocked", `${guide} allows publishing only for professional accounts. This account is personal.`);
      else if (instagram.accountType === "BUSINESS" || instagram.accountType === "MEDIA_CREATOR") add("instagram_account_type", "ready", "This is an Instagram professional account, which the Content Publishing guide allows.");
      else add("instagram_account_type", "action_required", `${guide} allows publishing only for professional accounts. ClipForge could not confirm this account type.`);
      const missingScopes = INSTAGRAM_VERIFIED.loginPaths.instagramLogin.permissions.filter((scope) => !instagram.grantedScopes.includes(scope));
      if (missingScopes.length > 0) add("instagram_permissions", "blocked", `Instagram Login is missing ${missingScopes.join(", ")}. Those are the permissions named in the Content Publishing guide for this login path.`);
      else add("instagram_permissions", "ready", "The Instagram Login publishing permissions are present.");
      if (!instagram.publicMediaUrlAvailable) add("instagram_public_url", "blocked", `${guide} requires the video to be on a publicly reachable URL when the container is created. ClipForge does not publish a public media URL, so this Reel cannot be sent.`);
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
