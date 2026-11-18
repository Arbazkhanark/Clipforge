import { jsonRoute } from "../../../../src/server/http.ts";
import { checkSameOrigin } from "../../../../src/server/http.ts";
import { buildContext, getRuntime } from "../../../../src/server/runtime.ts";
import { toHttpResult } from "../../../../src/server/errors.ts";
import { getOwnedMediaDeletionPreview, requestPermanentOwnedMediaDeletion } from "../../../../src/server/handlers/media-import.ts";

export const POST = jsonRoute(requestPermanentOwnedMediaDeletion);

export async function GET(request: Request): Promise<Response> {
  try {
    const crossSite = checkSameOrigin(request); if (crossSite) throw crossSite;
    const ctx = await buildContext(getRuntime(), request);
    const mediaId = new URL(request.url).searchParams.get("mediaId");
    return Response.json(await getOwnedMediaDeletionPreview(ctx, mediaId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = toHttpResult(error);
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
}
