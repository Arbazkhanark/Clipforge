// Smart Publishing Assistant: pre-start checks for a publishing cycle.
// It only reports problems found by OUR OWN rules. It never invents platform limits;
// anything about Instagram that is not verified is phrased as "could not confirm".
import { validateCaption, type CoverSupport } from "./caption-cover-updates.ts";
import { isEditableItem } from "./cycle-state.ts";
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

  // 9. Final review
  if (!cycle.finalReviewConfirmed) add("final_review", "action_required", "Please review and confirm the final list before starting.");

  const worst = checks.reduce<PreflightLevel>((level, c) => (LEVEL_SEVERITY[c.level] > LEVEL_SEVERITY[level] ? c.level : level), "ready");
  return { overall: worst, canStart: LEVEL_SEVERITY[worst] <= LEVEL_SEVERITY["recommendation"], checks };
}
