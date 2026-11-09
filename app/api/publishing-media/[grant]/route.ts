import { authorizeRenderedPublishingOutput, HmacTemporaryMediaAccessAdapter } from "../../../../src/server/storage/temporary-media-access.ts";
import { buildContext, getRuntime } from "../../../../src/server/runtime.ts";

export async function GET(request: Request, { params }: { params: Promise<{ grant: string }> }): Promise<Response> {
  const runtime = getRuntime();
  const adapter = runtime.publishingMediaAccess;
  if (!adapter || adapter.mode !== "provider") return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const now = runtime.now();
  const grant = adapter instanceof HmacTemporaryMediaAccessAdapter ? adapter.readGrant(request.url, now) : null;
  const routeGrant = await params;
  if (!grant || request.url.length > 4096 || !request.url.includes(routeGrant.grant)) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const context = await buildContext(runtime, request);
  if (!context.media || context.media.unavailable) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const authorized = await authorizeRenderedPublishingOutput(context.repo, context.media.storage, {
    ownerId: grant.ownerId, cycleId: grant.cycleId, cycleItemId: grant.cycleItemId, now,
  });
  if (authorized.status !== "authorized" || authorized.output.outputId !== grant.outputId || authorized.output.sourceMediaId !== grant.sourceMediaId) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await adapter.validateTemporaryAccess(request.url, authorized.output, now))) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const render = await context.repo.getRenderOutput(grant.outputId);
  if (!render) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const metadata = await context.media.storage.getPrivateMetadata(render.storageKey).catch(() => null);
  if (!metadata || metadata.sizeBytes !== authorized.output.sizeBytes) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const body = await context.media.storage.openRead(render.storageKey);
  return new Response(body, { status: 200, headers: {
    "Content-Type": "video/mp4", "Content-Length": String(metadata.sizeBytes), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": "*",
  } });
}
