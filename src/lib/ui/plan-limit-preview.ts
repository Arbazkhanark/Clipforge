/** Guard shared by the isolated visual preview route and its server-side shell handling. */
export const PLAN_LIMIT_PREVIEW_PATH = "/plan-limit-preview";
export const PLAN_LIMIT_PREVIEW_HEADER = "x-clipforge-plan-limit-preview";

export function planLimitPreviewEnabled(env: { NODE_ENV?: string; CLIPFORGE_DEMO_MODE?: string } = process.env): boolean {
  return env.NODE_ENV === "development" && env.CLIPFORGE_DEMO_MODE === "true";
}

export function isPlanLimitPreviewRequest(headerValue: string | null, env: { NODE_ENV?: string; CLIPFORGE_DEMO_MODE?: string } = process.env): boolean {
  return headerValue === "true" && planLimitPreviewEnabled(env);
}

/** Strip caller-controlled markers on every request, then add the marker only to the guarded preview path. */
export function planLimitPreviewRequestHeaders(
  incoming: Headers,
  pathname: string,
  env: { NODE_ENV?: string; CLIPFORGE_DEMO_MODE?: string } = process.env,
): Headers {
  const requestHeaders = new Headers(incoming);
  requestHeaders.delete(PLAN_LIMIT_PREVIEW_HEADER);
  if (pathname === PLAN_LIMIT_PREVIEW_PATH && planLimitPreviewEnabled(env)) {
    requestHeaders.set(PLAN_LIMIT_PREVIEW_HEADER, "true");
  }
  return requestHeaders;
}
