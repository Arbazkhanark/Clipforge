// Instagram Login (authorization code + state). Re-read on 2026-11-06.
// Business Login for Instagram (updated Mar 13, 2026) names these endpoints and does not list PKCE:
//   https://www.instagram.com/oauth/authorize
//   https://api.instagram.com/oauth/access_token
//   https://graph.instagram.com/access_token?grant_type=ig_exchange_token
// Oauth Authorize (updated Jul 17, 2025) uses https://api.instagram.com/oauth/authorize and lists
// client_id, redirect_uri, response_type, scope, and optional state. It does not list code_challenge.
// This file follows the Business Login host. It does not add PKCE, because neither page documents it.
// This file does not run unless a test or a configured server calls exchangeInstagramCode.
import { randomBytes, timingSafeEqual } from "node:crypto";
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
export type InstagramExchangeResult = { ok: true; profile: InstagramConnectedProfile } | { ok: false; reason: "expired_code" | "callback_error" | "missing_permission" | "unsupported_account" };

export function readInstagramOAuthConfig(env: Environment = process.env): InstagramOAuthConfig | null {
  const clientId = env["INSTAGRAM_APP_ID"]?.trim() ?? "";
  const clientSecret = env["INSTAGRAM_APP_SECRET"]?.trim() ?? "";
  const redirectUri = env["INSTAGRAM_OAUTH_REDIRECT_URI"]?.trim() ?? "";
  const tokenKey = readInstagramTokenKey(env);
  if (!clientId || !clientSecret || !redirectUri || !tokenKey || clientId === "replace-me" || clientSecret === "replace-me") return null;
  let url: URL;
  try { url = new URL(redirectUri); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  // const local = env["APP_ENDPOINT"]?.trim() === "https://clipforge-liard-eta.vercel.app";
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

function cookieName(secure: boolean): string { return `${secure ? "__Host-" : ""}clipforge_ig_state`; }

export function buildInstagramStateCookie(state: string, secure: boolean): string {
  return [`${cookieName(secure)}=${state}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${OAUTH_MAX_AGE_SECONDS}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function clearInstagramStateCookie(secure: boolean): string {
  return [`${cookieName(secure)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

export function readInstagramStateCookie(cookieHeader: string | null | undefined, secure: boolean): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  const expected = cookieName(secure);
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
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (text.length > 20_000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    if (record) return record;
    return Array.isArray(parsed) ? asRecord(parsed[0]) : null;
  } catch {
    return null;
  }
}

export async function exchangeInstagramCode(args: { config: InstagramOAuthConfig; code: string; now: Date; fetchImpl?: typeof fetch }): Promise<InstagramExchangeResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = new URLSearchParams({ client_id: args.config.clientId, client_secret: args.config.clientSecret, grant_type: "authorization_code", redirect_uri: args.config.redirectUri, code: args.code });
  let shortResponse: Response;
  try { shortResponse = await fetchImpl(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }); }
  catch { return { ok: false, reason: "callback_error" }; }
  const shortJson = await readJson(shortResponse);
  const shortData = asRecord(shortJson?.["data"]) ?? (Array.isArray(shortJson?.["data"]) ? asRecord((shortJson?.["data"] as unknown[])[0]) : shortJson);
  const shortToken = typeof shortData?.["access_token"] === "string" ? shortData["access_token"] : "";
  const userId = shortData?.["user_id"];
  const externalAccountId = typeof userId === "string" || typeof userId === "number" ? String(userId) : "";
  if (!shortResponse.ok || !shortToken || !/^[0-9]{1,32}$/.test(externalAccountId)) return { ok: false, reason: shortResponse.status === 400 ? "expired_code" : "callback_error" };
  const parsedScopes = normalizeInstagramScopes(shortData?.["permissions"]);
  const grantedScopes = parsedScopes.scopes;
  if (parsedScopes.malformed || missingInstagramScopes(grantedScopes).length > 0) return { ok: false, reason: "missing_permission" };

  const longUrl = new URL("/access_token", GRAPH_ORIGIN);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", args.config.clientSecret);
  longUrl.searchParams.set("access_token", shortToken);
  let longResponse: Response;
  try { longResponse = await fetchImpl(longUrl); }
  catch { return { ok: false, reason: "callback_error" }; }
  const longJson = await readJson(longResponse);
  const accessToken = typeof longJson?.["access_token"] === "string" ? longJson["access_token"] : "";
  const expiresIn = typeof longJson?.["expires_in"] === "number" ? longJson["expires_in"] : Number(longJson?.["expires_in"]);
  if (!longResponse.ok || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false, reason: "callback_error" };

  const profileUrl = new URL("/me", GRAPH_ORIGIN);
  profileUrl.searchParams.set("fields", "user_id,username,account_type");
  profileUrl.searchParams.set("access_token", accessToken);
  let profileResponse: Response;
  try { profileResponse = await fetchImpl(profileUrl); }
  catch { return { ok: false, reason: "callback_error" }; }
  const profileJson = await readJson(profileResponse);
  if (!profileResponse.ok || !profileJson) return { ok: false, reason: "callback_error" };
  const profileUserId = profileJson["user_id"];
  if ((typeof profileUserId !== "string" && typeof profileUserId !== "number") || String(profileUserId) !== externalAccountId) return { ok: false, reason: "callback_error" };
  const rawAccountType = profileJson["account_type"];
  if (!isSupportedInstagramAccountType(rawAccountType)) return { ok: false, reason: "unsupported_account" };
  const accountType: InstagramAccountType = rawAccountType;
  const username = typeof profileJson["username"] === "string" && /^[A-Za-z0-9._]{1,30}$/.test(profileJson["username"]) ? profileJson["username"] : null;
  if (!username) return { ok: false, reason: "callback_error" };
  const tokenExpiresAt = new Date(args.now.getTime() + expiresIn * 1000);
  if (Number.isNaN(tokenExpiresAt.getTime()) || tokenExpiresAt <= args.now) return { ok: false, reason: "callback_error" };
  return { ok: true, profile: { externalAccountId, username, accountType, grantedScopes, accessToken, tokenExpiresAt } };
}
