// Connect and disconnect Instagram. The callback is a top-level redirect from Meta, so it is not same-origin checked.
// The HttpOnly state cookie is the CSRF check. Redirects use fixed codes and never include the code or token.
import { AppError } from "../errors.ts";
import { buildFlashLocation, type FlashErrorCode } from "../flash.ts";
import { checkSameOrigin } from "../http.ts";
import { readUrlEncoded, redirectResponse } from "../form-routes.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { useSecureCookies } from "../auth/auth-routes.ts";
import { encryptToken } from "./token-cipher.ts";
import {
  buildInstagramAuthorizationUrl, buildInstagramStateCookie, clearInstagramStateCookie, exchangeInstagramCode,
  instagramSafeEqual, readInstagramOAuthConfig, readInstagramStateCookie, createInstagramState,
  type InstagramExchangeResult, type InstagramOAuthConfig,
} from "./instagram-oauth.ts";

type RuntimeProvider = () => Runtime;
type Exchange = (args: { code: string; now: Date }) => Promise<InstagramExchangeResult>;

export interface InstagramRouteOptions {
  runtime?: RuntimeProvider;
  config?: InstagramOAuthConfig | null;
  now?: () => Date;
  exchange?: Exchange;
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9_\-./~]{1,512}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function withCookies(location: string, cookies: string[]): Response {
  const response = redirectResponse(location);
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function finish(secure: boolean, code: FlashErrorCode): Response {
  return withCookies(buildFlashLocation("/instagram", "error", code), [clearInstagramStateCookie(secure)]);
}

export const instagramStartRoute = (options: InstagramRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  const userId = await runtime.currentUserId(request);
  if (!userId) return finish(secure, "not_authenticated");
  const config = options.config === undefined ? readInstagramOAuthConfig() : options.config;
  if (!config) return finish(secure, "instagram_not_configured");
  const state = createInstagramState();
  return withCookies(buildInstagramAuthorizationUrl(config, state), [buildInstagramStateCookie(state, secure)]);
};

export const instagramCallbackRoute = (options: InstagramRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  const config = options.config === undefined ? readInstagramOAuthConfig() : options.config;
  if (!config) return finish(secure, "instagram_not_configured");
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error");
  if (providerError === "access_denied") return finish(secure, "instagram_cancelled");
  if (providerError) return finish(secure, "instagram_callback_error");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const cookieState = readInstagramStateCookie(request.headers.get("cookie"), secure);
  if (!cookieState || !STATE_PATTERN.test(state) || !instagramSafeEqual(cookieState, state)) return finish(secure, "instagram_invalid_state");
  if (!CODE_PATTERN.test(code)) return finish(secure, "instagram_callback_error");
  const userId = await runtime.currentUserId(request);
  if (!userId) return finish(secure, "not_authenticated");
  const now = (options.now ?? (() => new Date()))();
  let exchanged: InstagramExchangeResult;
  try {
    exchanged = options.exchange ? await options.exchange({ code, now }) : await exchangeInstagramCode({ config, code, now });
  } catch {
    return finish(secure, "instagram_callback_error");
  }
  if (!exchanged.ok) {
    const codeByReason = { expired_code: "instagram_expired_code", callback_error: "instagram_callback_error", missing_permission: "instagram_missing_permission", unsupported_account: "instagram_unsupported_account" } as const;
    return finish(secure, codeByReason[exchanged.reason]);
  }
  try {
    await runtime.repo.saveInstagramConnection({
      id: runtime.newId(), userId, externalAccountId: exchanged.profile.externalAccountId, username: exchanged.profile.username,
      accountType: exchanged.profile.accountType, grantedScopes: exchanged.profile.grantedScopes, tokenExpiresAt: exchanged.profile.tokenExpiresAt,
      encryptedAccessToken: encryptToken(config.tokenKey, exchanged.profile.accessToken),
    });
    await runtime.repo.appendAudit({ actorId: userId, action: "instagram.connected", entityType: "SocialAccount", entityId: exchanged.profile.externalAccountId });
  } catch (error) {
    if (error instanceof AppError && error.code === "database_unavailable") return finish(secure, "database_unavailable");
    return finish(secure, "instagram_callback_error");
  }
  return withCookies(buildFlashLocation("/instagram", "notice", "instagram_connected"), [clearInstagramStateCookie(secure)]);
};

export const instagramDisconnectRoute = (options: InstagramRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const userId = await runtime.currentUserId(request);
  if (!userId) return redirectResponse(buildFlashLocation("/instagram", "error", "not_authenticated"));
  let fields: { get(name: string): string | null };
  try { fields = await readUrlEncoded(request); }
  catch (error) {
    const code: FlashErrorCode = error instanceof AppError && error.code === "payload_too_large" ? "payload_too_large" : "validation_failed";
    return redirectResponse(buildFlashLocation("/instagram", "error", code));
  }
  const accountId = fields.get("accountId") ?? "";
  if (!ID_PATTERN.test(accountId) || fields.get("confirm") !== "yes") return redirectResponse(buildFlashLocation("/instagram", "error", "validation_failed"));
  let removed = false;
  try { removed = await runtime.repo.disconnectSocialAccount(userId, accountId); }
  catch (error) {
    if (error instanceof AppError && error.code === "database_unavailable") return redirectResponse(buildFlashLocation("/instagram", "error", "database_unavailable"));
    return redirectResponse(buildFlashLocation("/instagram", "error", "error"));
  }
  if (!removed) return redirectResponse(buildFlashLocation("/instagram", "error", "not_found"));
  await runtime.repo.appendAudit({ actorId: userId, action: "instagram.disconnected", entityType: "SocialAccount", entityId: accountId });
  return redirectResponse(buildFlashLocation("/instagram", "notice", "instagram_disconnected"));
};
