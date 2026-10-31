// Plain HTML form posts -> the SAME tested handlers -> redirect back with a short flash code.
// No client-side JavaScript is needed. Protection is the same as for JSON routes: cross-site requests are
// refused (Origin / Sec-Fetch-Site), the body size is capped, and the redirect target is built only from
// validated ids and a fixed whitelist of messages.
import type { RequestContext } from "./context.ts";
import { AppError } from "./errors.ts";
import { buildFlashLocation, flashCodeForError } from "./flash.ts";
import { checkSameOrigin, MAX_JSON_BODY_BYTES } from "./http.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";

export interface FormFields { get(name: string): string | null; getAll(name: string): string[]; entries(): [string, string][]; }

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Returns the value only if it is a safe id; otherwise null. */
export const safeId = (value: string | null): string | null => (value !== null && ID.test(value) ? value : null);

export interface Redirect { path: string; code: string; counts?: Parameters<typeof buildFlashLocation>[3]; }

export interface FormSpec<R> {
  handler: (ctx: RequestContext, input: unknown) => Promise<R>;
  toInput: (fields: FormFields) => unknown;
  success: (result: R, fields: FormFields) => Redirect;
  /** Where to send the user when it fails (same page, with an error code). */
  failurePath: (fields: FormFields) => string;
}

export function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

async function readUrlEncoded(request: Request): Promise<FormFields> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded")) throw new AppError(415, "unsupported_media_type", "Unsupported form type.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BODY_BYTES) throw new AppError(413, "payload_too_large", "Too large.");
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) throw new AppError(413, "payload_too_large", "Too large.");
  const params = new URLSearchParams(text);
  return { get: (n) => params.get(n), getAll: (n) => params.getAll(n), entries: () => [...params.entries()] };
}

export function formRoute<R>(spec: FormSpec<R>, runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const crossSite = checkSameOrigin(request);
    if (crossSite) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
    let fields: FormFields = { get: () => null, getAll: () => [], entries: () => [] };
    try {
      fields = await readUrlEncoded(request);
      const ctx = await buildContext(runtime(), request);
      const result = await spec.handler(ctx, spec.toInput(fields));
      const target = spec.success(result, fields);
      return redirectResponse(buildFlashLocation(target.path, "notice", target.code, target.counts));
    } catch (error) {
      return redirectResponse(buildFlashLocation(spec.failurePath(fields), "error", flashCodeForError(error)));
    }
  };
}
