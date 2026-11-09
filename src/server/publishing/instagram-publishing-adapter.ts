import type { PublishingAdapters, PublishingAdapterInput, ContainerCreationResult, ContainerPollResult, PublishingResult, PublishingVerificationResult, PublishingQuotaResult } from "./publishing-worker.ts";

export type InstagramAccessProvider = (ownerId: string, socialAccountId: string) => Promise<{ status: "ready"; accessToken: string } | { status: "unavailable" }>;
const GRAPH_ORIGIN = "https://graph.instagram.com";

function publicVideoUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hostname.endsWith(".invalid") && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1";
  } catch { return false; }
}
function safeCategory(response: Response): string { return response.status === 429 ? "rate_limited" : "api_error"; }
async function json(response: Response): Promise<Record<string, unknown> | null> {
  try { const value: unknown = await response.json(); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
function endpoint(version: string, path: string): URL { return new URL(`/${version}/${path}`, GRAPH_ORIGIN); }

/** Official Instagram Login publishing flow. This adapter only becomes usable when explicitly composed by the operator. */
export function createInstagramPublishingAdapters(args: {
  graphApiVersion: string;
  access: InstagramAccessProvider;
  fetchImpl?: typeof fetch;
}): PublishingAdapters {
  if (!/^v\d+\.\d+$/.test(args.graphApiVersion)) throw new TypeError("A pinned Instagram Graph API version is required.");
  const fetchImpl = args.fetchImpl ?? fetch;
  const getToken = async (input: PublishingAdapterInput): Promise<string | null> => {
    if (!input.instagramAccountId) return null;
    const token = await args.access(input.ownerId, input.socialAccountId);
    return token.status === "ready" ? token.accessToken : null;
  };
  return {
    async createContainer(input): Promise<ContainerCreationResult> {
      if (!input.instagramAccountId || !input.renderOutputId || input.renderOutputId !== input.selectedRenderOutputId || !publicVideoUrl(input.videoUrl)) return { kind: "definite_failure", category: "media_unavailable" };
      if ((input.coverSelected && !publicVideoUrl(input.coverUrl)) || (!input.coverSelected && input.coverUrl) || (input.thumbOffsetMs !== undefined && (!Number.isSafeInteger(input.thumbOffsetMs) || input.thumbOffsetMs < 0 || input.thumbOffsetMs > 900_000))) return { kind: "definite_failure", category: "media_unavailable" };
      const accessToken = await getToken(input);
      if (!accessToken) return { kind: "definite_failure", category: "account_ineligible" };
      const form = new URLSearchParams({ media_type: "REELS", video_url: input.videoUrl, caption: input.caption, share_to_feed: "true" });
      if (input.coverUrl) form.set("cover_url", input.coverUrl);
      if (input.thumbOffsetMs !== undefined) form.set("thumb_offset", String(input.thumbOffsetMs));
      let response: Response;
      try { response = await fetchImpl(endpoint(args.graphApiVersion, `${input.instagramAccountId}/media`), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${accessToken}` }, body: form, cache: "no-store" }); }
      catch { return { kind: "ambiguous" }; }
      const data = await json(response);
      const id = data?.["id"];
      if (response.ok && typeof id === "string" && id.length > 0 && id.length <= 256) return { kind: "created", containerId: id };
      // A server error can occur after Meta accepted the request; never retry such a create blindly.
      return response.status >= 500 ? { kind: "ambiguous" } : { kind: "definite_failure", category: safeCategory(response) };
    },
    async pollContainer(input): Promise<ContainerPollResult> {
      if (!input.containerId) return { kind: "definite_failure", category: "container_rejected" };
      const accessToken = await getToken(input);
      if (!accessToken) return { kind: "definite_failure", category: "account_ineligible" };
      const url = endpoint(args.graphApiVersion, input.containerId);
      url.searchParams.set("fields", "status_code,status");
      let response: Response;
      try { response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(10_000) }); }
      catch { return { kind: "ambiguous" }; }
      const data = await json(response);
      if (!response.ok) return response.status >= 500 ? { kind: "ambiguous" } : { kind: "definite_failure", category: safeCategory(response) };
      const status = data?.["status_code"];
      if (status === "FINISHED") return { kind: "ready" };
      if (status === "IN_PROGRESS") return { kind: "processing" };
      if (status === "ERROR" || status === "EXPIRED") return { kind: "definite_failure", category: "container_rejected" };
      return { kind: "ambiguous" };
    },
    async publishContainer(input): Promise<PublishingResult> {
      if (!input.instagramAccountId || !input.containerId) return { kind: "definite_failure", category: "publish_rejected" };
      const accessToken = await getToken(input);
      if (!accessToken) return { kind: "definite_failure", category: "account_ineligible" };
      const form = new URLSearchParams({ creation_id: input.containerId });
      let response: Response;
      try { response = await fetchImpl(endpoint(args.graphApiVersion, `${input.instagramAccountId}/media_publish`), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${accessToken}` }, body: form, cache: "no-store" }); }
      catch { return { kind: "ambiguous" }; }
      const data = await json(response);
      const id = data?.["id"];
      if (response.ok && typeof id === "string" && id.length > 0 && id.length <= 256) return { kind: "confirmed", instagramMediaId: id };
      return response.status >= 500 ? { kind: "ambiguous" } : { kind: "definite_failure", category: safeCategory(response) };
    },
    async verifyPublishingResult(_input): Promise<PublishingVerificationResult> {
      // Meta does not expose a safe, durable lookup by this app's idempotency key. Unknown is safer than a second publish.
      return { kind: "unknown" };
    },
    async checkPublishingQuota(input): Promise<PublishingQuotaResult> {
      if (!input.instagramAccountId) return { kind: "unknown" };
      const accessToken = await getToken(input);
      if (!accessToken) return { kind: "unknown" };
      const url = endpoint(args.graphApiVersion, `${input.instagramAccountId}/content_publishing_limit`);
      url.searchParams.set("fields", "quota_usage,config");
      let response: Response;
      try { response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" }); }
      catch { return { kind: "unknown" }; }
      if (!response.ok) return { kind: "unknown" };
      const data = await json(response);
      const records = data?.["data"];
      if (!Array.isArray(records) || records.length !== 1 || typeof records[0] !== "object" || records[0] === null || Array.isArray(records[0])) return { kind: "unknown" };
      const record = records[0] as Record<string, unknown>;
      const config = record["config"];
      if (typeof config !== "object" || config === null || Array.isArray(config)) return { kind: "unknown" };
      const quotaUsage = record["quota_usage"];
      const quotaTotal = (config as Record<string, unknown>)["quota_total"];
      const quotaDuration = (config as Record<string, unknown>)["quota_duration"];
      if (!Number.isSafeInteger(quotaUsage) || (quotaUsage as number) < 0 || !Number.isSafeInteger(quotaTotal) || (quotaTotal as number) < 1 || !Number.isSafeInteger(quotaDuration) || (quotaDuration as number) < 1) return { kind: "unknown" };
      const snapshot = { usage: quotaUsage as number, total: quotaTotal as number, durationSeconds: quotaDuration as number };
      return snapshot.usage >= snapshot.total ? { kind: "limit_reached", ...snapshot } : { kind: "available", ...snapshot };
    },
  };
}

export function isPublicInstagramMediaUrl(value: string | undefined): boolean { return publicVideoUrl(value); }
