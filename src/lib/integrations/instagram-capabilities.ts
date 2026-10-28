// What we KNOW about Instagram's official publishing API, and what we do NOT know.
// Source: Meta's official "Content Publishing" guide and "IG User Media" reference
//   https://developers.facebook.com/docs/instagram-platform/content-publishing
//   https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
// Read on 2026-10-28. Re-check before launch: Meta changes this API often.
//
// Nothing here calls Instagram. No Instagram integration works yet (no OAuth, no credentials, no calls).

export const INSTAGRAM_VERIFIED = {
  readOn: "2026-10-28",
  /** Posts can only be created for Instagram PROFESSIONAL accounts. Passwords are never used - OAuth only. */
  accountTypes: "Instagram professional accounts",
  /** Flow: POST /{ig-id}/media (container) -> GET /{container-id}?fields=status_code -> POST /{ig-id}/media_publish. */
  flow: ["create_container", "poll_status", "media_publish"] as const,
  /** "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period", enforced at media_publish. */
  publishLimitPer24h: 100,
  /** The same page also says "50 published posts within a 24-hour period" in the carousel section: the docs disagree. */
  publishLimitDocConflict: "A carousel section of the same guide mentions 50 per 24h. Ask GET /{ig-id}/content_publishing_limit at runtime.",
  /** Meta recommends apps enforce the limit themselves, especially when scheduling posts for later. */
  appShouldEnforceLimit: true,
  /** Containers expire after 24 hours; an account may create 400 containers per rolling 24 hours. */
  containerLifetimeHours: 24,
  containersPer24h: 400,
  /** Meta recommends polling a container's status once a minute, for no more than 5 minutes. */
  statusPollIntervalSeconds: 60,
  statusPollMaxMinutes: 5,
  /** "We cURL media ... the media must be hosted on a publicly accessible server at the time of the attempt." */
  mediaMustBePubliclyFetchableAtPublishTime: true,
  /** "JPEG is the only image format supported." (photo posts) */
  photoFormat: "JPEG",
  /** Reels containers accept media_type=REELS, video_url, cover_url and thumb_offset (IG User Media reference). */
  reelsCoverParameters: ["cover_url", "thumb_offset"] as const,
  /** Not supported by the API: shopping tags, branded content tags, filters. */
  unsupportedFeatures: ["shopping tags", "branded content tags", "filters"] as const,
  /** Two login paths exist, with different permissions. */
  loginPaths: {
    instagramLogin: { host: "graph.instagram.com", permissions: ["instagram_business_basic", "instagram_business_content_publish"] },
    facebookLogin: { host: "graph.facebook.com", permissions: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"] },
  },
  /** Pages needing Page Publishing Authorization (PPA) cannot be published to until PPA is completed. */
  pagePublishingAuthorizationMayBeRequired: true,
} as const;

/** Things we have NOT confirmed from an official source. Do not rely on any of these. */
export const INSTAGRAM_UNVERIFIED: readonly string[] = [
  "Reels video requirements (maximum duration, file size, codec/container, aspect ratio): only third-party blogs were read.",
  "Maximum caption length and hashtag count (our 2,200 / 30 are from memory).",
  "Cover image requirements (format, size, dimensions) and whether cover_url or thumb_offset wins when both are sent.",
  "Whether Creator accounts (as opposed to Business) may publish.",
  "App Review / Advanced Access requirements before non-test users can connect.",
  "Which Graph API version to use (examples in the docs show v25.0 and v26.0).",
  "Whether resumable upload is usable for us (the guide says it is only for apps using Facebook Login for Business).",
];

/** Reels can carry a custom cover through the API parameters; details above are unverified. Photo posts have no cover concept. */
export function instagramCoverSupport(kind: "reel" | "photo"): "supported" | "unsupported" {
  return kind === "reel" ? "supported" : "unsupported";
}

// ---------- Publishing quota (rolling 24 hours) ----------
export interface QuotaViolation { windowEnd: Date; count: number; limit: number; }

/**
 * Finds moments where MORE than `limit` posts would fall inside one rolling 24-hour window.
 * Pass planned times and (optionally) times of posts already published recently.
 */
export function findPublishQuotaViolations(publishTimes: Date[], limit: number = INSTAGRAM_VERIFIED.publishLimitPer24h): QuotaViolation[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const sorted = publishTimes.map((d) => d.getTime()).sort((a, b) => a - b);
  const violations: QuotaViolation[] = [];
  let windowStart = 0;
  for (let end = 0; end < sorted.length; end++) {
    while ((sorted[end] as number) - (sorted[windowStart] as number) >= DAY_MS) windowStart++;
    const count = end - windowStart + 1;
    if (count > limit) violations.push({ windowEnd: new Date(sorted[end] as number), count, limit });
  }
  return violations;
}

// ---------- Containers ----------
/** Containers expire after 24h, so create one shortly BEFORE publishing - never days ahead. */
export function isContainerCreationAllowedNow(scheduledFor: Date, now: Date, leadMinutes = 30): boolean {
  const hoursLeft = (scheduledFor.getTime() - now.getTime()) / 3_600_000;
  if (leadMinutes * 60_000 >= INSTAGRAM_VERIFIED.containerLifetimeHours * 3_600_000) throw new RangeError("Lead time must be shorter than the container lifetime.");
  return hoursLeft * 60 <= leadMinutes;
}

export type ContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

/**
 * What to do for each documented container status. Also resolves AMBIGUOUS publish results safely:
 * only "PUBLISHED" proves the post is live; we never guess.
 */
export function nextActionForContainerStatus(status: string): "wait" | "publish_now" | "mark_published" | "mark_failed" | "recreate_container" | "needs_review" {
  switch (status) {
    case "IN_PROGRESS": return "wait";
    case "FINISHED": return "publish_now";
    case "PUBLISHED": return "mark_published";
    case "ERROR": return "mark_failed";
    case "EXPIRED": return "recreate_container";
    default: return "needs_review"; // a status the docs did not list: ask a human
  }
}
