// Google authorization-code + PKCE helpers.
// The browser is sent to Google. The callback checks a short HttpOnly state cookie before any code is exchanged.
// Access tokens are read only to reach the ID token and are then discarded.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleProfile } from "./auth-service.ts";
import { verifyGoogleIdToken, type RsaJwk } from "./google-id-token.ts";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const OAUTH_MAX_AGE_SECONDS = 600;

export interface GoogleOAuthConfig { clientId: string; clientSecret: string; redirectUri: string; }
export type GoogleExchangeFailure = "expired_code" | "callback_error";
export type GoogleExchangeResult = { ok: true; profile: GoogleProfile } | { ok: false; reason: GoogleExchangeFailure };

export function readGoogleOAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  const clientId = env["GOOGLE_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = env["GOOGLE_CLIENT_SECRET"]?.trim() ?? "";
  const redirectUri = env["GOOGLE_OAUTH_REDIRECT_URI"]?.trim() ?? "";
  if (!clientId || !clientSecret || !redirectUri || clientId === "replace-me" || clientSecret === "replace-me") return null;
  let url: URL;
  try { url = new URL(redirectUri); } catch { return null; }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (!url.pathname.endsWith("/api/auth/google/callback")) return null;
  return { clientId, clientSecret, redirectUri };
}

export function createOAuthState(): string { return randomBytes(32).toString("base64url"); }

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildGoogleAuthorizationUrl(config: GoogleOAuthConfig, state: string, codeChallenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieName(kind: "state" | "pkce" | "link" | "return", secure: boolean): string {
  const suffix = kind === "state" ? "google_state" : kind === "pkce" ? "google_pkce" : kind === "link" ? "google_link" : "google_return";
  return `${secure ? "__Host-" : ""}clipforge_${suffix}`;
}

export function buildOAuthCookie(kind: "state" | "pkce" | "link" | "return", value: string, secure: boolean): string {
  return [`${cookieName(kind, secure)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${OAUTH_MAX_AGE_SECONDS}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export function buildClearedOAuthCookie(kind: "state" | "pkce" | "link" | "return", secure: boolean): string {
  return [`${cookieName(kind, secure)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

export function readOAuthCookie(cookieHeader: string | null | undefined, kind: "state" | "pkce" | "link" | "return", secure: boolean): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  const expected = cookieName(kind, secure);
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === expected && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  }
  return null;
}

export async function exchangeGoogleCode(args: {
  config: GoogleOAuthConfig;
  code: string;
  codeVerifier: string;
  now: Date;
  fetchImpl?: typeof fetch;
  keys?: RsaJwk[];
}): Promise<GoogleExchangeResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let keys = args.keys;
  if (!keys) {
    try {
      const certs = await fetchImpl(CERTS_URL, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (!certs.ok) return { ok: false, reason: "callback_error" };
      const body = await certs.json() as { keys?: RsaJwk[] };
      keys = Array.isArray(body.keys) ? body.keys : [];
    } catch { return { ok: false, reason: "callback_error" }; }
  }
  let payload: unknown;
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: args.config.clientId,
        client_secret: args.config.clientSecret,
        code: args.code,
        code_verifier: args.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: args.config.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    payload = await response.json();
    if (!response.ok) {
      const errorCode = typeof payload === "object" && payload !== null && "error" in payload ? (payload as { error?: unknown }).error : "";
      return { ok: false, reason: errorCode === "invalid_grant" ? "expired_code" : "callback_error" };
    }
  } catch { return { ok: false, reason: "callback_error" }; }
  const idToken = typeof payload === "object" && payload !== null && "id_token" in payload ? (payload as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string") return { ok: false, reason: "callback_error" };
  const profile = verifyGoogleIdToken(idToken, { clientId: args.config.clientId, now: args.now, keys });
  return profile ? { ok: true, profile } : { ok: false, reason: "callback_error" };
}
