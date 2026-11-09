import { AppError } from "./errors.ts";
import { checkSameOrigin } from "./http.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";
import { readUrlEncoded } from "./form-routes.ts";
import { createCollectionShareLink } from "./handlers/sharing.ts";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};
function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`, { status, headers });
}

/** Creation response displays the bearer URL once, in a non-cacheable POST response, never in logs or flash URLs. */
export function createCollectionShareLinkRoute(runtime: () => Runtime = getRuntime) {
  return async (request: Request): Promise<Response> => {
    const crossSite = checkSameOrigin(request);
    if (crossSite) return page("Share link not created", "<p>This request was refused.</p>", 403);
    try {
      const fields = await readUrlEncoded(request);
      const ctx = await buildContext(runtime(), request);
      const result = await createCollectionShareLink(ctx, {
        collectionId: fields.get("collectionId") ?? "",
        capabilities: fields.getAll("capabilities"),
        expiresAt: fields.get("expiresAt") || null,
      });
      const path = escapeHtml(result.path);
      return page("Share link created", `<p>Copy this link now. For your security, ClipForge will not show it again.</p><p><a href="${path}">${path}</a></p><p><a href="/collections/${escapeHtml(result.collectionId)}">Return to collection</a></p>`);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : "The share link could not be created. Nothing was saved.";
      return page("Share link not created", `<p>${escapeHtml(message)}</p><p><a href="/collections">Return to collections</a></p>`, status);
    }
  };
}
