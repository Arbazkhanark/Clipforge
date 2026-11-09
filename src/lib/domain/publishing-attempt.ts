import type { PublishingJobStage } from "../../server/repository.ts";

const NEXT: Record<PublishingJobStage, PublishingJobStage[]> = {
  queued: ["claimed", "cancelled"],
  claimed: ["container_creation_pending", "failed", "needs_manual_review"],
  container_creation_pending: ["container_processing", "failed", "needs_manual_review"],
  container_processing: ["ready_to_publish", "failed", "needs_manual_review"],
  ready_to_publish: ["publishing", "failed", "needs_manual_review"],
  publishing: ["published", "failed", "needs_manual_review"],
  published: [], failed: [], needs_manual_review: [], cancelled: [],
};

export const canTransitionPublishingAttempt = (from: PublishingJobStage, to: PublishingJobStage): boolean => NEXT[from].includes(to);
export const isActivePublishingAttempt = (stage: PublishingJobStage): boolean =>
  ["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"].includes(stage);

const SAFE_ERRORS: Record<string, string> = {
  account_ineligible: "The connected account did not meet publishing checks.",
  permission_missing: "Required publishing permissions were not available.",
  media_unavailable: "The selected media could not be verified.",
  rate_limited: "The request was deferred by a rate limit.",
  container_rejected: "The media container was not accepted.",
  container_timeout: "The media container result could not be confirmed.",
  publish_rejected: "The publish request was not accepted.",
  publish_timeout: "The publish result could not be confirmed.",
  api_error: "The publishing request failed.",
  worker_lease_expired: "The worker lease expired; the external outcome was not verified.",
  unknown: "The publishing attempt needs review.",
};

/** Discards caller/provider text entirely; persisted diagnostics are fixed, non-sensitive summaries. */
export function safePublishingError(category: string | null | undefined): { category: string; details: string } {
  const safeCategory = category && Object.hasOwn(SAFE_ERRORS, category) ? category : "unknown";
  return { category: safeCategory, details: SAFE_ERRORS[safeCategory]! };
}

export function publishingOutcomeForStage(stage: PublishingJobStage): "in_progress" | "success" | "definite_failure" | "ambiguous" {
  if (stage === "published") return "success";
  if (stage === "failed") return "definite_failure";
  if (stage === "needs_manual_review") return "ambiguous";
  return "in_progress";
}
