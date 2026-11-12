// Connect and disconnect Instagram. The callback is a top-level redirect from Meta, so it is not same-origin checked.
// The HttpOnly state cookie is the CSRF check. Redirects use fixed codes and never include the code or token.
import { AppError } from "../errors.ts";
import { buildFlashLocation, type FlashErrorCode } from "../flash.ts";
import { checkSameOrigin } from "../http.ts";
import { readUrlEncoded, redirectResponse } from "../form-routes.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { useSecureCookies } from "../auth/auth-routes.ts";
import { readSessionToken } from "../auth/tokens.ts";
import type { Environment } from "../environment.ts";
import { encryptToken } from "./token-cipher.ts";
import { isValidInstagramConnectionProfile } from "../../lib/integrations/instagram-eligibility.ts";
import { buildInstagramDiagnosticCookie, clearInstagramDiagnosticCookie, type InstagramDiagnosticResult } from "./instagram-diagnostic.ts";
import {
  buildInstagramAuthorizationUrl, buildInstagramStateCookie, clearInstagramStateCookie, exchangeInstagramCode,
  instagramSafeEqual, instagramStateCookieName, readInstagramOAuthConfig, readInstagramStateCookie, createInstagramState,
  type InstagramExchangeResult, type InstagramOAuthConfig,
} from "./instagram-oauth.ts";

type RuntimeProvider = () => Runtime;
type Exchange = (args: { code: string; now: Date }) => Promise<InstagramExchangeResult>;

export interface InstagramRouteOptions {
  runtime?: RuntimeProvider;
  config?: InstagramOAuthConfig | null;
  now?: () => Date;
  exchange?: Exchange;
  /** Test seam; production routes use process.env and cannot override NODE_ENV. */
  environment?: Environment;
  /** Receives only fixed event/reason labels; never state, code, cookies, or provider payloads. */
  diagnosticLogger?: { warn(entry: { event: string; reason: string }): void };
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_PATTERN = /^[A-Za-z0-9_\-./~]{1,512}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function withCookies(location: string, cookies: string[]): Response {
  const response = redirectResponse(location);
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function finish(secure: boolean, code: FlashErrorCode, state?: string): Response {
  return withCookies(buildFlashLocation("/instagram", "error", code), [clearInstagramStateCookie(secure, state)]);
}

function logOAuthState(options: InstagramRouteOptions, event: string, reason: string): void {
  const entry = { event, reason };
  if (options.diagnosticLogger) options.diagnosticLogger.warn(entry);
  else console.warn(JSON.stringify(entry));
}

function diagnosticModeEnabled(environment: Environment): boolean {
  return environment["NODE_ENV"] !== "production" && environment["INSTAGRAM_OAUTH_DIAGNOSTIC_MODE"] === "true";
}

function diagnosticResultForFailure(reason: string): InstagramDiagnosticResult | null {
  const base = { tokenExchange: "succeeded" as const, identityComparison: "not_verified" as const };
  if (reason.startsWith("long_lived_token_exchange_") || reason === "long_lived_token_response_invalid") return {
    outcome: "long_lived_token_exchange_failed",
    ...base,
    longLivedTokenExchange: "failed",
    profileRequest: "not_run",
  };
  if (reason.startsWith("profile_lookup_") || reason === "profile_response_invalid") return {
    outcome: "profile_request_failed",
    ...base,
    longLivedTokenExchange: "succeeded",
    profileRequest: "failed",
  };
  if (reason === "profile_identity_missing") return {
    outcome: "profile_identity_missing",
    ...base,
    longLivedTokenExchange: "succeeded",
    profileRequest: "succeeded",
  };
  if (reason === "profile_identity_malformed") return {
    outcome: "profile_identity_malformed",
    ...base,
    longLivedTokenExchange: "succeeded",
    profileRequest: "succeeded",
  };
  return null;
}

export const instagramStartRoute = (options: InstagramRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  const userId = await runtime.currentUserId(request);
  if (!userId) return finish(secure, "not_authenticated");
  const config = options.config === undefined ? readInstagramOAuthConfig() : options.config;
  if (!config || !runtime.instagramOAuthStates) return finish(secure, "instagram_not_configured");
  const state = createInstagramState();
  try { await runtime.instagramOAuthStates.issue(state, userId, (options.now ?? (() => new Date()))()); }
  catch { logOAuthState(options, "instagram_oauth_state_issue_failed", "state_store_write_failed"); return finish(secure, "instagram_callback_error"); }
  return withCookies(buildInstagramAuthorizationUrl(config, state), [buildInstagramStateCookie(state, secure)]);
};

export const instagramCallbackRoute = (options: InstagramRouteOptions = {}) => async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method not allowed.", { status: 405, headers: { "Cache-Control": "no-store" } });
  const runtime = (options.runtime ?? getRuntime)();
  const secure = useSecureCookies(request);
  const config = options.config === undefined ? readInstagramOAuthConfig() : options.config;
  const environment = options.environment ?? process.env;
  const diagnosticEnabled = diagnosticModeEnabled(environment);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const finishCallback = (code: FlashErrorCode) => {
    const response = finish(secure, code, state);
    if (diagnosticEnabled) response.headers.append("Set-Cookie", clearInstagramDiagnosticCookie(secure));
    return response;
  };
  if (!url.searchParams.has("state")) {
    logOAuthState(options, "instagram_oauth_state_rejected", "state_parameter_missing");
    return finishCallback("instagram_invalid_state");
  }
  if (!STATE_PATTERN.test(state)) {
    logOAuthState(options, "instagram_oauth_state_rejected", "state_parameter_malformed");
    return finishCallback("instagram_invalid_state");
  }
  const cookieHeader = request.headers.get("cookie");
  const cookieState = readInstagramStateCookie(cookieHeader, secure, state);
  if (!cookieState) {
    const cookieName = instagramStateCookieName(state, secure);
    const cookieWasPresent = (cookieHeader ?? "").split(";").some((part) => part.trim().startsWith(`${cookieName}=`));
    logOAuthState(options, "instagram_oauth_state_rejected", cookieWasPresent ? "state_cookie_malformed" : "state_cookie_missing");
    return finishCallback("instagram_invalid_state");
  }
  if (!instagramSafeEqual(cookieState, state)) {
    logOAuthState(options, "instagram_oauth_state_rejected", "state_cookie_query_mismatch");
    return finishCallback("instagram_invalid_state");
  }
  const now = (options.now ?? (() => new Date()))();
  if (!runtime.instagramOAuthStates) {
    logOAuthState(options, "instagram_oauth_state_rejected", "state_store_unavailable");
    return finishCallback("instagram_not_configured");
  }
  let consumed: Awaited<ReturnType<NonNullable<Runtime["instagramOAuthStates"]>["consume"]>>;
  try { consumed = await runtime.instagramOAuthStates.consume(state, now); }
  catch {
    logOAuthState(options, "instagram_oauth_state_lookup_failed", "state_store_database_error");
    return finishCallback("database_unavailable");
  }
  if (consumed.status !== "consumed") {
    const reason = consumed.status === "not_found" ? "state_hash_not_found" : consumed.status === "expired" ? "state_record_expired" : consumed.status === "already_consumed" ? "state_record_already_consumed" : "state_consume_race_lost";
    logOAuthState(options, "instagram_oauth_state_rejected", reason);
    return finishCallback("instagram_invalid_state");
  }
  const userId = await runtime.currentUserId(request);
  if (!userId || userId !== consumed.userId) {
    logOAuthState(options, "instagram_oauth_state_rejected", "session_user_mismatch");
    return finishCallback("not_authenticated");
  }
  const providerError = url.searchParams.get("error");
  if (providerError === "access_denied") return finishCallback("instagram_cancelled");
  if (providerError) {
    logOAuthState(options, "instagram_oauth_callback_rejected", "provider_returned_error");
    return finishCallback("instagram_callback_error");
  }
  if (!config) return finishCallback("instagram_not_configured");
  const finishDiagnosticResult = (result: InstagramDiagnosticResult): Response => {
    const sessionToken = readSessionToken(cookieHeader);
    if (!diagnosticEnabled || !sessionToken) return finishCallback("instagram_callback_error");
    const cookie = buildInstagramDiagnosticCookie({ result, sessionToken, tokenKey: config.tokenKey, secure, now });
    return withCookies("/instagram", [clearInstagramStateCookie(secure, state), cookie]);
  };
  const code = url.searchParams.get("code") ?? "";
  if (!CODE_PATTERN.test(code)) {
    logOAuthState(options, "instagram_oauth_callback_rejected", "authorization_code_missing_or_malformed");
    return finishCallback("instagram_callback_error");
  }
  let exchanged: InstagramExchangeResult;
  try {
    exchanged = options.exchange ? await options.exchange({ code, now }) : await exchangeInstagramCode({ config, code, now });
  } catch {
    logOAuthState(options, "instagram_oauth_exchange_failed", "exchange_unexpected_failure");
    return finishCallback("instagram_callback_error");
  }
  if (!exchanged.ok) {
    logOAuthState(options, "instagram_oauth_exchange_failed", exchanged.reason);
    const diagnosticResult = diagnosticResultForFailure(exchanged.reason);
    // This runs only after the state cookie, one-time consumption, and session
    // binding have succeeded. No account or provider token is persisted after
    // any failed exchange/profile validation stage.
    if (diagnosticEnabled && diagnosticResult) return finishDiagnosticResult(diagnosticResult);
    // Normal production/fail-closed error handling remains unchanged below.
    const codeByReason = {
      expired_code: "instagram_expired_code",
      authorization_code_exchange_network_error: "instagram_callback_error",
      authorization_code_exchange_rejected: "instagram_callback_error",
      authorization_code_response_invalid: "instagram_callback_error",
      authorization_code_permissions_invalid: "instagram_missing_permission",
      long_lived_token_exchange_network_error: "instagram_callback_error",
      long_lived_token_exchange_rejected: "instagram_callback_error",
      long_lived_token_response_invalid: "instagram_callback_error",
      profile_lookup_network_error: "instagram_callback_error",
      profile_lookup_rejected: "instagram_callback_error",
      profile_response_invalid: "instagram_callback_error",
      profile_identity_missing: "instagram_callback_error",
      profile_identity_malformed: "instagram_callback_error",
      unsupported_account: "instagram_unsupported_account",
      profile_username_invalid: "instagram_callback_error",
      token_expiry_invalid: "instagram_callback_error",
    } as const;
    return finishCallback(codeByReason[exchanged.reason]);
  }
  if (diagnosticEnabled) return finishDiagnosticResult({
    outcome: "profile_identity_verified_diagnostic_only",
    tokenExchange: "succeeded",
    identityComparison: "not_verified",
    longLivedTokenExchange: "succeeded",
    profileRequest: "succeeded",
  });
  if (!isValidInstagramConnectionProfile(exchanged.profile, now)) {
    logOAuthState(options, "instagram_oauth_profile_rejected", "profile_not_eligible");
    return finishCallback("instagram_unsupported_account");
  }
  let persistenceStage: "connection_prepare" | "plan_activation" | "account_link" | "audit_write" = "connection_prepare";
  try {
    const connection = {
      id: runtime.newId(), userId, externalAccountId: exchanged.profile.externalAccountId, username: exchanged.profile.username,
      accountType: exchanged.profile.accountType, grantedScopes: exchanged.profile.grantedScopes, tokenExpiresAt: exchanged.profile.tokenExpiresAt,
      encryptedAccessToken: encryptToken(config.tokenKey, exchanged.profile.accessToken),
    };
    persistenceStage = "plan_activation";
    await runtime.repo.getPlanIdForUser(userId, now); // activates any now-eligible queued grant before the locked account-cap check
    persistenceStage = "account_link";
    const saved = await runtime.repo.saveInstagramConnectionWithinLimit(connection, now);
    if (saved.status === "limit") return finishCallback("plan_limit");
    persistenceStage = "audit_write";
    await runtime.repo.appendAudit({ actorId: userId, action: "instagram.connected", entityType: "SocialAccount", entityId: saved.accountId });
  } catch (error) {
    const databaseUnavailable = error instanceof AppError && error.code === "database_unavailable";
    logOAuthState(options, "instagram_oauth_persistence_failed", databaseUnavailable ? `database_unavailable_${persistenceStage}` : `${persistenceStage}_failed`);
    if (databaseUnavailable) return finishCallback("database_unavailable");
    return finishCallback("instagram_callback_error");
  }
  return withCookies(buildFlashLocation("/instagram", "notice", "instagram_connected"), [clearInstagramStateCookie(secure, state)]);
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
