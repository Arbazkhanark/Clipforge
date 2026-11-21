import { buildContext, getRuntime } from "../../../../src/server/runtime.ts";
import { checkSameOrigin, jsonRoute } from "../../../../src/server/http.ts";
import { toHttpResult } from "../../../../src/server/errors.ts";
import { getEditedMediaRetentionStatus, requestEditedMediaRetention } from "../../../../src/server/handlers/media-retention.ts";

export const POST = jsonRoute(requestEditedMediaRetention);

export async function GET(request: Request): Promise<Response> {
  try {
    const crossSite = checkSameOrigin(request);
    if (crossSite) throw crossSite;
    const ctx = await buildContext(getRuntime(), request);
    const url = new URL(request.url);
    const result = await getEditedMediaRetentionStatus(ctx, url.searchParams.get("mediaId"), url.searchParams.get("outputId"));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = toHttpResult(error);
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
}
