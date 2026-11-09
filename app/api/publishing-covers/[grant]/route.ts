import { authorizePublishingCover, HmacTemporaryMediaAccessAdapter } from "../../../../src/server/storage/temporary-media-access.ts";
import { buildContext, getRuntime } from "../../../../src/server/runtime.ts";

/** Serves only a selected owner JPEG cover using an expiring, cycle-item-scoped signature. */
export async function GET(request: Request, { params }: { params: Promise<{ grant: string }> }): Promise<Response> {
  const runtime = getRuntime();
  const adapter = runtime.publishingMediaAccess;
  if (!adapter || adapter.mode !== "provider") return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const now = runtime.now();
  const routeGrant = await params;
  const grant = adapter instanceof HmacTemporaryMediaAccessAdapter ? adapter.readCoverGrant(request.url, now) : null;
  if (!grant || request.url.length > 4096 || !request.url.includes(routeGrant.grant)) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const context = await buildContext(runtime, request);
  if (!context.media || context.media.unavailable) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const authorized = await authorizePublishingCover(context.repo, context.media.storage, { ownerId: grant.ownerId, cycleId: grant.cycleId, cycleItemId: grant.cycleItemId, now });
  if (authorized.status !== "authorized" || authorized.cover.mediaId !== grant.mediaId || !(await adapter.validateTemporaryCoverAccess(request.url, authorized.cover, now))) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const stored = await context.repo.getMediaStorageInfo(grant.mediaId);
  if (!stored || stored.mimeType !== "image/jpeg") return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const metadata = await context.media.storage.getPrivateMetadata(stored.storageKey).catch(() => null);
  if (!metadata || metadata.sizeBytes !== authorized.cover.sizeBytes || metadata.sizeBytes > 8_000_000) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const body = await context.media.storage.openRead(stored.storageKey);
  return new Response(body, { status: 200, headers: {
    "Content-Type": "image/jpeg", "Content-Length": String(metadata.sizeBytes), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": "*",
  } });
}
