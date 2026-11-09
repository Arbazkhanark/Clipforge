// Starts Google sign-in and handles the callback.
// The callback is a top-level redirect from Google, so it is not checked with the same-origin rule.
// The state cookie is the CSRF check. Error redirects use fixed codes and never include the code, state, or token.
import { AppError } from "../errors.ts";
import { buildFlashLocation, type FlashErrorCode } from "../flash.ts";
import { readUrlEncoded, redirectResponse } from "../form-routes.ts";
import { checkSameOrigin } from "../http.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import type { GoogleProfile } from "./auth-service.ts";
import { useSecureCookies } from "./auth-routes.ts";
import { buildClearedOAuthCookie, buildGoogleAuthorizationUrl, buildOAuthCookie, createOAuthState, createPkcePair, exchangeGoogleCode, readGoogleOAuthConfig, readOAuthCookie, safeEqual, type GoogleExchangeResult, type GoogleOAuthConfig } from "./google-oauth.ts";
import { buildSessionCookie, readSessionToken } from "./tokens.ts";
import { safeCustomerReturnPath } from "./return-path.ts";

type RuntimeProvider = () => Runtime;
type Exchange = (args: { code: string; codeVerifier: string; now: Date }) => Promise<GoogleExchangeResult>;

export interface GoogleRouteOptions {
  runtime?: RuntimeProvider;
  /** undefined reads the environment. null means Google is not configured. */
  config?: GoogleOAuthConfig | null;
  now?: () => Date;
  exchange?: Exchange;
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9_\-./~]{1,2048}$/;

function withCookies(location: string, cookies: string[]): Response {
  const response = redirectResponse(location);
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function clearedOAuthCookies(secure: boolean): string[] {
  return [buildClearedOAuthCookie("state", secure), buildClearedOAuthCookie("pkce", secure), buildClearedOAuthCookie("link", secure), buildClearedOAuthCookie("return", secure)];
}

export const googleStartRoute = (options: GoogleRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  if (!runtime.auth) return withCookies(buildFlashLocation("/login", "error", "auth_not_available"), clearedOAuthCookies(secure));
  const config = options.config === undefined ? readGoogleOAuthConfig() : options.config;
  if (!config) return withCookies(buildFlashLocation("/login", "error", "google_not_configured"), clearedOAuthCookies(secure));
  let intent = "login";
  let formReturnTo: unknown;
  try { const fields = await readUrlEncoded(request); intent = fields.get("intent") ?? "login"; formReturnTo = fields.get("returnTo"); }
  catch (error) {
    const code: FlashErrorCode = error instanceof AppError && error.code === "payload_too_large" ? "payload_too_large" : "error";
    return withCookies(buildFlashLocation("/login", "error", code), clearedOAuthCookies(secure));
  }
  const link = intent === "link";
  let sessionUserId: string | null = null;
  if (link) {
    try { sessionUserId = await runtime.auth.getSessionUserId(readSessionToken(request.headers.get("cookie"))); }
    catch (error) {
      const code: FlashErrorCode = error instanceof AppError && error.code === "database_unavailable" ? "database_unavailable" : "error";
      return withCookies(buildFlashLocation("/login", "error", code), clearedOAuthCookies(secure));
    }
  }
  if (link && !sessionUserId) return withCookies(buildFlashLocation("/login", "error", "not_authenticated"), clearedOAuthCookies(secure));
  const state = createOAuthState();
  const pkce = createPkcePair();
  let returnTo = "/dashboard";
  if (!link) {
    returnTo = safeCustomerReturnPath(formReturnTo);
  }
  const returnCookieValue = Buffer.from(returnTo, "utf8").toString("base64url");
  const cookies = [
    buildOAuthCookie("state", state, secure),
    buildOAuthCookie("pkce", pkce.verifier, secure),
    link ? buildOAuthCookie("link", "1", secure) : buildClearedOAuthCookie("link", secure),
    link ? buildClearedOAuthCookie("return", secure) : buildOAuthCookie("return", returnCookieValue, secure),
  ];
  return withCookies(buildGoogleAuthorizationUrl(config, state, pkce.challenge), cookies);
};

export const googleCallbackRoute = (options: GoogleRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  const finish = (code: FlashErrorCode, sessionCookie?: string) => withCookies(buildFlashLocation("/login", "error", code), [...clearedOAuthCookies(secure), ...(sessionCookie ? [sessionCookie] : [])]);
  if (!runtime.auth) return finish("auth_not_available");
  const config = options.config === undefined ? readGoogleOAuthConfig() : options.config;
  if (!config) return finish("google_not_configured");
  const url = new URL(request.url);
  const googleError = url.searchParams.get("error");
  if (googleError === "access_denied") return finish("google_cancelled");
  if (googleError) return finish("google_callback_error");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const cookieState = readOAuthCookie(request.headers.get("cookie"), "state", secure);
  const verifier = readOAuthCookie(request.headers.get("cookie"), "pkce", secure);
  if (!cookieState || !verifier || !STATE_PATTERN.test(state) || !safeEqual(cookieState, state)) return finish("google_invalid_state");
  if (!CODE_PATTERN.test(code)) return finish("google_callback_error");
  const linking = readOAuthCookie(request.headers.get("cookie"), "link", secure) === "1";
  const encodedReturnTo = readOAuthCookie(request.headers.get("cookie"), "return", secure);
  let returnTo = "/dashboard";
  if (encodedReturnTo) {
    try { returnTo = safeCustomerReturnPath(Buffer.from(encodedReturnTo, "base64url").toString("utf8")); }
    catch { returnTo = "/dashboard"; }
  }
  let linkUserId: string | null = null;
  try { linkUserId = linking ? await runtime.auth.getSessionUserId(readSessionToken(request.headers.get("cookie"))) : null; }
  catch (error) { return finish(error instanceof AppError && error.code === "database_unavailable" ? "database_unavailable" : "google_callback_error"); }
  if (linking && !linkUserId) return finish("google_link_mismatch");
  const now = (options.now ?? (() => new Date()))();
  let exchanged: GoogleExchangeResult;
  try {
    exchanged = options.exchange
      ? await options.exchange({ code, codeVerifier: verifier, now })
      : await exchangeGoogleCode({ config, code, codeVerifier: verifier, now });
  } catch { return finish("google_callback_error"); }
  if (!exchanged.ok) return finish(exchanged.reason === "expired_code" ? "google_expired_code" : "google_callback_error");
  const profile: GoogleProfile = exchanged.profile;
  let result;
  try { result = await runtime.auth.completeGoogleSignIn(profile, linkUserId); }
  catch (error) { return finish(error instanceof AppError && error.code === "database_unavailable" ? "database_unavailable" : "google_callback_error"); }
  if (!result.ok) return finish(result.code);
  const location = linking ? buildFlashLocation("/dashboard", "notice", "google_connected") : returnTo;
  return withCookies(location, [...clearedOAuthCookies(secure), buildSessionCookie(result.sessionToken, result.expiresAt, now, secure)]);
};
