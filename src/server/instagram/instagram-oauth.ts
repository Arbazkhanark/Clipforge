// Instagram Login (authorization code + state). Re-read on 2026-11-06.
// Business Login for Instagram (updated Mar 13, 2026) names these endpoints and does not list PKCE:
//   https://www.instagram.com/oauth/authorize
//   https://api.instagram.com/oauth/access_token
//   https://graph.instagram.com/access_token?grant_type=ig_exchange_token
// Oauth Authorize (updated Jul 17, 2025) uses https://api.instagram.com/oauth/authorize and lists
// client_id, redirect_uri, response_type, scope, and optional state. It does not list code_challenge.
// This file follows the Business Login host. It does not add PKCE, because neither page documents it.
// This file does not run unless a test or a configured server calls exchangeInstagramCode.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Environment } from "../environment.ts";
import { INSTAGRAM_REQUIRED_SCOPES } from "../../lib/integrations/instagram-capabilities.ts";
import { isSupportedInstagramAccountType, missingInstagramScopes, normalizeInstagramScopes } from "../../lib/integrations/instagram-eligibility.ts";
import type { InstagramAccountType } from "../repository.ts";
import { readInstagramTokenKey } from "./token-cipher.ts";

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_ORIGIN = "https://graph.instagram.com";
export const INSTAGRAM_SCOPES = INSTAGRAM_REQUIRED_SCOPES;
const OAUTH_MAX_AGE_SECONDS = 600;
const issuedStates = new Map<string, { userId: string; expiresAt: number }>();

export interface InstagramOAuthConfig { clientId: string; clientSecret: string; redirectUri: string; tokenKey: Buffer; }
export interface InstagramConnectedProfile {
  externalAccountId: string;
  username: string | null;
  accountType: InstagramAccountType;
  grantedScopes: string[];
  accessToken: string;
  tokenExpiresAt: Date;
}
export type InstagramExchangeFailure =
  | "expired_code"
  | "authorization_code_exchange_network_error"
  | "authorization_code_exchange_rejected"
  | "authorization_code_response_invalid"
  | "authorization_code_permissions_invalid"
  | "long_lived_token_exchange_network_error"
  | "long_lived_token_exchange_rejected"
  | "long_lived_token_response_invalid"
  | "profile_lookup_network_error"
  | "profile_lookup_rejected"
  | "profile_response_invalid"
  | "profile_identity_missing"
  | "profile_identity_malformed"
  | "unsupported_account"
  | "profile_username_invalid"
  | "token_expiry_invalid";
export type InstagramExchangeResult = { ok: true; profile: InstagramConnectedProfile } | { ok: false; reason: InstagramExchangeFailure };

export function readInstagramOAuthConfig(env: Environment = process.env): InstagramOAuthConfig | null {
  const clientId = env["INSTAGRAM_APP_ID"]?.trim() ?? "";
  const clientSecret = env["INSTAGRAM_APP_SECRET"]?.trim() ?? "";
  const redirectUri = env["INSTAGRAM_OAUTH_REDIRECT_URI"]?.trim() ?? "";
  const tokenKey = readInstagramTokenKey(env);
  if (!clientId || !clientSecret || !redirectUri || !tokenKey || clientId === "replace-me" || clientSecret === "replace-me") return null;
  let url: URL;
  try { url = new URL(redirectUri); } catch { return null; }
  // const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const local = env["APP_ENDPOINT"]?.trim() === "https://clipforge-liard-eta.vercel.app";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (!url.pathname.endsWith("/api/instagram/callback")) return null;
  return { clientId, clientSecret, redirectUri, tokenKey };
}

export function createInstagramState(): string { return randomBytes(32).toString("base64url"); }

/** Process-local one-use state storage. A shared store is required before multi-process deployment. */
export function issueInstagramOAuthState(state: string, userId: string, now: Date): void {
  for (const [key, value] of issuedStates) if (value.expiresAt <= now.getTime()) issuedStates.delete(key);
  issuedStates.set(state, { userId, expiresAt: now.getTime() + OAUTH_MAX_AGE_SECONDS * 1000 });
}

export function consumeInstagramOAuthState(state: string, now: Date): string | null {
  const issued = issuedStates.get(state);
  issuedStates.delete(state);
  return issued && issued.expiresAt > now.getTime() ? issued.userId : null;
}

export function instagramSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildInstagramAuthorizationUrl(config: InstagramOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

const validState = (state: string) => /^[A-Za-z0-9_-]{43,128}$/.test(state);

/** A state-derived cookie name lets concurrent browser tabs keep separate state cookies. */
export function instagramStateCookieName(state: string, secure: boolean): string {
  const prefix = secure ? "__Host-" : "";
  if (!validState(state)) return `${prefix}clipforge_ig_state`;
  const suffix = createHash("sha256").update(state).digest("hex").slice(0, 24);
  return `${prefix}clipforge_ig_state_${suffix}`;
}

export function buildInstagramStateCookie(state: string, secure: boolean): string {
  return [`${instagramStateCookieName(state, secure)}=${state}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${OAUTH_MAX_AGE_SECONDS}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function clearInstagramStateCookie(secure: boolean, state?: string): string {
  return [`${instagramStateCookieName(state ?? "", secure)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

export function readInstagramStateCookie(cookieHeader: string | null | undefined, secure: boolean, state: string): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  const expected = instagramStateCookieName(state, secure);
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === expected && /^[A-Za-z0-9_-]{43,128}$/.test(value)) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isValidInstagramUserId(value: unknown): boolean {
  if (typeof value === "string") return /^[0-9]{1,32}$/.test(value);
  return typeof value === "number" && Number.isSafeInteger(value) && /^[0-9]{1,32}$/.test(String(value));
}

const UNSUPPORTED_NUMERIC_USER_ID = Symbol("unsupported_numeric_user_id");

type JsonParseContext = { source?: string };
type JsonReviverWithSource = (this: unknown, key: string, value: unknown, context?: JsonParseContext) => unknown;
type JsonParserWithSource = (text: string, reviver: JsonReviverWithSource) => unknown;

export function parseInstagramJson(text: string, parser: JsonParserWithSource = JSON.parse as unknown as JsonParserWithSource): unknown {
  return parser(text, (key, value, context) => {
    if (key !== "user_id" || typeof value !== "number") return value;
    const source = context?.source;
    if (source === undefined) return UNSUPPORTED_NUMERIC_USER_ID;
    // Accept only the original unsigned decimal integer token. Preserve it as
    // text before JSON.parse's rounded Number can be used as an identifier.
    return /^[0-9]+$/.test(source) ? source : UNSUPPORTED_NUMERIC_USER_ID;
  });
}

type JsonReadState = "valid_json" | "invalid_json" | "response_too_large" | "stream_failure";
type JsonReadResult = { value: unknown | null; state: JsonReadState };
const MAX_PROVIDER_RESPONSE_BYTES = 20 * 1024;

function cancelProviderReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void reader.cancel().catch(() => undefined); } catch { /* Cancellation is best-effort. */ }
}

async function readJsonResult(response: Response): Promise<JsonReadResult> {
  const reader = response.body?.getReader();
  if (!reader) return { value: null, state: "invalid_json" };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (value.byteLength > MAX_PROVIDER_RESPONSE_BYTES - totalBytes) {
        cancelProviderReader(reader);
        return { value: null, state: "response_too_large" };
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    cancelProviderReader(reader);
    return { value: null, state: "stream_failure" };
  } finally {
    try { reader.releaseLock(); } catch { /* The reader may already be released. */ }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: parseInstagramJson(text), state: "valid_json" };
  } catch {
    return { value: null, state: "invalid_json" };
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  return (await readJsonResult(response)).value;
}

type AuthorizationCodeErrorCategory =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "redirect_uri_mismatch"
  | "oauth_exception"
  | "unknown";

function authorizationCodeErrorCategory(value: unknown): AuthorizationCodeErrorCategory {
  const root = asRecord(value);
  const nestedError = asRecord(root?.["error"]);
  const candidates = [
    root?.["error"], root?.["error_type"], root?.["error_code"],
    nestedError?.["type"], nestedError?.["code"],
  ];
  const categories: Record<string, AuthorizationCodeErrorCategory> = {
    invalid_grant: "invalid_grant",
    invalid_client: "invalid_client",
    invalid_request: "invalid_request",
    unauthorized_client: "unauthorized_client",
    unsupported_grant_type: "unsupported_grant_type",
    invalid_scope: "invalid_scope",
    redirect_uri_mismatch: "redirect_uri_mismatch",
    invalid_redirect_uri: "redirect_uri_mismatch",
    oauthexception: "oauth_exception",
    oauthaccesstokenexception: "oauth_exception",
  };
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const key = candidate.trim().toLowerCase();
    if (Object.hasOwn(categories, key)) return categories[key]!;
  }
  return "unknown";
}

function logAuthorizationCodeExchangeHttpFailure(
  status: number,
  responseJson: JsonReadResult,
): void {
  console.warn(JSON.stringify({
    event: "instagram_oauth_token_exchange_http_error",
    stage: "authorization_code_exchange",
    http_status: status,
    provider_error_category: responseJson.state === "valid_json" ? authorizationCodeErrorCategory(responseJson.value) : "unknown",
    response_state: responseJson.state,
  }));
}

function parseAuthorizationCodeTokenResponse(value: unknown): Record<string, unknown> | null {
  const root = asRecord(value);
  if (!root) return null;
  if (!Object.hasOwn(root, "data")) return root;

  // Compatibility wrapper: exactly one token response object, with no
  // competing top-level fields. Never choose an arbitrary entry.
  if (Object.keys(root).length !== 1 || !Array.isArray(root["data"]) || root["data"].length !== 1) return null;
  return asRecord(root["data"][0]);
}

export async function exchangeInstagramCode(args: { config: InstagramOAuthConfig; code: string; now: Date; fetchImpl?: typeof fetch }): Promise<InstagramExchangeResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: args.config.clientId, client_secret: args.config.clientSecret, grant_type: "authorization_code", redirect_uri: args.config.redirectUri, code: args.code });
  let shortResponse: Response;
  try { shortResponse = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); }
  catch { return { ok: false, reason: "authorization_code_exchange_network_error" }; }
  const shortJsonResult = await readJsonResult(shortResponse);
  const shortJson = shortJsonResult.value;
  const shortData = parseAuthorizationCodeTokenResponse(shortJson);
  const shortToken = typeof shortData?.["access_token"] === "string" ? shortData["access_token"] : "";
  if (!shortResponse.ok) {
    logAuthorizationCodeExchangeHttpFailure(shortResponse.status, shortJsonResult);
    return { ok: false, reason: shortResponse.status === 400 ? "expired_code" : "authorization_code_exchange_rejected" };
  }
  if (!shortToken) return { ok: false, reason: "authorization_code_response_invalid" };
  const parsedScopes = normalizeInstagramScopes(shortData?.["permissions"]);
  const grantedScopes = parsedScopes.scopes;
  if (parsedScopes.malformed || missingInstagramScopes(grantedScopes).length > 0) return { ok: false, reason: "authorization_code_permissions_invalid" };

  const longUrl = new URL("/access_token", GRAPH_ORIGIN);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", args.config.clientSecret);
  longUrl.searchParams.set("access_token", shortToken);
  let longResponse: Response;
  try { longResponse = await fetchImpl(longUrl); }
  catch { return { ok: false, reason: "long_lived_token_exchange_network_error" }; }
  const longJson = asRecord(await readJson(longResponse));
  const accessToken = typeof longJson?.["access_token"] === "string" ? longJson["access_token"] : "";
  const expiresIn = typeof longJson?.["expires_in"] === "number" ? longJson["expires_in"] : Number(longJson?.["expires_in"]);
  if (!longResponse.ok) return { ok: false, reason: "long_lived_token_exchange_rejected" };
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false, reason: "long_lived_token_response_invalid" };

  const profileUrl = new URL("/me", GRAPH_ORIGIN);
  profileUrl.searchParams.set("fields", "user_id,username,account_type");
  profileUrl.searchParams.set("access_token", accessToken);
  let profileResponse: Response;
  try { profileResponse = await fetchImpl(profileUrl); }
  catch { return { ok: false, reason: "profile_lookup_network_error" }; }
  const profileJson = asRecord(await readJson(profileResponse));
  if (!profileResponse.ok) return { ok: false, reason: "profile_lookup_rejected" };
  if (!profileJson) return { ok: false, reason: "profile_response_invalid" };
  const profileUserId = profileJson["user_id"];
  if (profileUserId === undefined || profileUserId === null) return { ok: false, reason: "profile_identity_missing" };
  if (!isValidInstagramUserId(profileUserId)) return { ok: false, reason: "profile_identity_malformed" };
  // This token-authenticated profile response is the canonical source for the
  // account ID. The code-exchange response's user_id is intentionally unused.
  const externalAccountId = String(profileUserId);
  const rawAccountType = profileJson["account_type"];
  if (!isSupportedInstagramAccountType(rawAccountType)) return { ok: false, reason: "unsupported_account" };
  const accountType: InstagramAccountType = rawAccountType;
  const username = typeof profileJson["username"] === "string" && /^[A-Za-z0-9._]{1,30}$/.test(profileJson["username"]) ? profileJson["username"] : null;
  if (!username) return { ok: false, reason: "profile_username_invalid" };
  const tokenExpiresAt = new Date(args.now.getTime() + expiresIn * 1000);
  if (Number.isNaN(tokenExpiresAt.getTime()) || tokenExpiresAt <= args.now) return { ok: false, reason: "token_expiry_invalid" };
  return { ok: true, profile: { externalAccountId, username, accountType, grantedScopes, accessToken, tokenExpiresAt } };
}
