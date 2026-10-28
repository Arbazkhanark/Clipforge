// Small display helpers shared by components. No React in here, so they are easy to test.
import type { CoverState, CycleItemStatus, SourceKind } from "../lib/domain/types.ts";

export const STATUS_LABELS: Record<CycleItemStatus, string> = {
  upcoming: "Upcoming", scheduled: "Scheduled", processing: "Processing", publishing: "Publishing",
  published: "Published", needs_review: "Needs review", failed: "Failed", cancelled: "Cancelled",
};

/** Honest wording: "saved" is never presented as "applied on Instagram". */
export const COVER_LABELS: Record<CoverState, string> = {
  none: "No custom cover",
  saved_internally: "Saved in ClipForge (not confirmed on Instagram)",
  applied_on_instagram: "Applied on Instagram",
};

export const SOURCE_LABELS: Record<SourceKind, string> = {
  owned: "Your video", shared_reference: "Shared with you", imported_copy: "Your imported copy",
};

export const REVIEW_REASON_LABELS: Record<string, string> = {
  source_removed: "The owner removed the source video.",
  ambiguous_publish_result: "We could not confirm whether this was published. Check Instagram before retrying.",
  worker_lost_during_publish: "Publishing was interrupted. Check Instagram before retrying.",
};

const GIB = 1024 ** 3;
/** Storage is measured in binary gigabytes (see docs/PLAN.md assumption 1). */
export function formatStorage(bytes: number): string {
  if (bytes >= 1024 * GIB) return `${+(bytes / (1024 * GIB)).toFixed(1)} TB`;
  if (bytes >= GIB) return `${+(bytes / GIB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${+(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} B`;
}

export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

export const formatCount = (n: number): string => new Intl.NumberFormat("en-IN").format(n);
