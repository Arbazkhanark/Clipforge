import { AppError, toHttpResult } from "./errors.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";
import { requireUser } from "./context.ts";
import { checkSameOrigin } from "./http.ts";

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

export function mediaVerificationRoute(runtime: () => Runtime = getRuntime) {
  return {
    GET: async (request: Request): Promise<Response> => {
      try {
        const ctx = await buildContext(runtime(), request); const ownerId = requireUser(ctx);
        const raw = new URL(request.url).searchParams.get("ids") ?? "";
        const ids = [...new Set(raw.split(",").filter(Boolean))];
        if (ids.length === 0 || ids.length > 50 || ids.some((id) => !SAFE_ID.test(id))) throw new AppError(422, "invalid_media_ids", "Choose valid media records to check.");
        const items = await ctx.repo.listMediaVerificationsForOwner(ownerId, ids);
        return Response.json({ items }, { headers: jsonHeaders });
      } catch (error) { const result = toHttpResult(error); return Response.json(result.body, { status: result.status, headers: jsonHeaders }); }
    },
    POST: async (request: Request): Promise<Response> => {
      if (checkSameOrigin(request)) return Response.json({ error: { code: "cross_site_request", message: "This request is not allowed." } }, { status: 403, headers: jsonHeaders });
      try {
        const ctx = await buildContext(runtime(), request); const ownerId = requireUser(ctx);
        let body: unknown; try { body = await request.json(); } catch { throw new AppError(422, "invalid_request", "The retry request is not valid."); }
        const mediaId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)["mediaId"] : null;
        if (typeof mediaId !== "string" || !SAFE_ID.test(mediaId)) throw new AppError(422, "invalid_media_id", "Choose a valid media record to retry.");
        const result = await ctx.repo.retryMediaVerification(ownerId, mediaId, ctx.now);
        if (result === "missing") throw new AppError(404, "not_found", "Media was not found.");
        if (result === "not_retryable") throw new AppError(409, "not_retryable", "This verification cannot be retried safely.");
        return Response.json({ status: result }, { status: 202, headers: jsonHeaders });
      } catch (error) { const result = toHttpResult(error); return Response.json(result.body, { status: result.status, headers: jsonHeaders }); }
    },
  };
}
