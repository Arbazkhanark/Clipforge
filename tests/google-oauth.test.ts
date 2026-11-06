// Google OAuth is tested with a fake code exchange and locally signed ID tokens.
// Nothing here contacts Google or uses real client credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { createLocalRuntime, type Runtime } from "../src/server/runtime.ts";
import { AuthService, DEFAULT_AUTH_CONFIG, type GoogleProfile } from "../src/server/auth/auth-service.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { googleCallbackRoute, googleStartRoute } from "../src/server/auth/google-routes.ts";
import { buildGoogleAuthorizationUrl, exchangeGoogleCode, readGoogleOAuthConfig, readOAuthCookie, type GoogleOAuthConfig } from "../src/server/auth/google-oauth.ts";
import { verifyGoogleIdToken, type RsaJwk } from "../src/server/auth/google-id-token.ts";
import { readSessionToken } from "../src/server/auth/tokens.ts";

const FAST = { logN: 10, r: 8, p: 1 };
const NOW = new Date("2026-06-01T12:00:00Z");
const GOOD = "correct horse battery";
const CONFIG: GoogleOAuthConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret-not-a-real-one",
  redirectUri: "http://localhost:3000/api/auth/google/callback",
};

function runtime(): Runtime {
  return createLocalRuntime({ scrypt: FAST, now: () => NOW });
}

function form(path: string, fields: [string, string][], headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function cookiePairs(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function profile(over: Partial<GoogleProfile> = {}): GoogleProfile {
  return { sub: "google-sub-1", email: "ada@example.com", emailVerified: true, name: "Ada", ...over };
}

test("Google config rejects placeholders and accepts only the callback path", () => {
  assert.equal(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: "replace-me", GOOGLE_CLIENT_SECRET: "replace-me", GOOGLE_OAUTH_REDIRECT_URI: CONFIG.redirectUri }), null);
  assert.equal(readGoogleOAuthConfig({ ...process.env, GOOGLE_CLIENT_ID: CONFIG.clientId, GOOGLE_CLIENT_SECRET: CONFIG.clientSecret, GOOGLE_OAUTH_REDIRECT_URI: "https://evil.example/steal" }), null);
  assert.deepEqual(readGoogleOAuthConfig({ GOOGLE_CLIENT_ID: CONFIG.clientId, GOOGLE_CLIENT_SECRET: CONFIG.clientSecret, GOOGLE_OAUTH_REDIRECT_URI: CONFIG.redirectUri }), CONFIG);
});

test("authorization URL has PKCE and state, and never the client secret", () => {
  const url = new URL(buildGoogleAuthorizationUrl(CONFIG, "state-value", "challenge-value"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
  assert.equal(url.search.includes(CONFIG.clientSecret), false);
});

test("start stores state and PKCE in HttpOnly cookies and refuses a cross-site post", async () => {
  const rt = runtime();
  const response = await googleStartRoute({ runtime: () => rt, config: CONFIG, now: () => NOW })(form("/api/auth/google/start", [["intent", "login"]]));
  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.equal(location.includes(CONFIG.clientSecret), false);
  assert.match(location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("clipforge_google_state=") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && !cookie.includes("Secure")));
  assert.ok(cookies.some((cookie) => cookie.startsWith("clipforge_google_pkce=") && cookie.includes("HttpOnly")));
  const state = new URL(location).searchParams.get("state") ?? "";
  assert.equal(readOAuthCookie(cookiePairs(response), "state", false), state);

  const blocked = await googleStartRoute({ runtime: () => rt, config: CONFIG })(form("/api/auth/google/start", [], { origin: "https://evil.example" }));
  assert.equal(blocked.status, 403);
  const unlinked = await googleStartRoute({ runtime: () => rt, config: CONFIG, now: () => NOW })(form("/api/auth/google/start", [["intent", "link"]]));
  assert.match(unlinked.headers.get("location") ?? "", /error=not_authenticated/);
  assert.equal((unlinked.headers.get("location") ?? "").includes("accounts.google.com"), false);
});

test("missing Google credentials do not start a login or invent a session", async () => {
  const response = await googleStartRoute({ runtime, config: null })(form("/api/auth/google/start", [["intent", "login"]]));
  assert.match(response.headers.get("location") ?? "", /error=google_not_configured/);
  assert.equal(response.headers.getSetCookie().some((cookie) => cookie.includes("clipforge_session=")), false);
});

test("callback rejects cancelled consent, bad state, and an expired code without creating a user", async () => {
  const rt = runtime();
  const start = await googleStartRoute({ runtime: () => rt, config: CONFIG, now: () => NOW })(form("/api/auth/google/start", [["intent", "login"]]));
  const jar = cookiePairs(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const callback = googleCallbackRoute({
    runtime: () => rt,
    config: CONFIG,
    now: () => NOW,
    exchange: async () => { throw new Error("should not exchange"); },
  });
  const cancelled = await callback(new Request(`http://localhost:3000/api/auth/google/callback?error=access_denied&state=${state}`, { headers: { cookie: jar } }));
  assert.match(cancelled.headers.get("location") ?? "", /error=google_cancelled/);
  assert.equal(rt.auth && await rt.auth.getSessionUserId(readSessionToken(cancelled.headers.get("set-cookie"))), null);

  const mismatched = await googleCallbackRoute({ runtime: () => rt, config: CONFIG, now: () => NOW, exchange: async () => ({ ok: true, profile: profile() }) })(
    new Request(`http://localhost:3000/api/auth/google/callback?code=good-code&state=${"a".repeat(43)}`, { headers: { cookie: jar } }),
  );
  assert.match(mismatched.headers.get("location") ?? "", /error=google_invalid_state/);

  let exchanged = 0;
  const expired = await googleCallbackRoute({
    runtime: () => rt,
    config: CONFIG,
    now: () => NOW,
    exchange: async () => { exchanged += 1; return { ok: false, reason: "expired_code" }; },
  })(new Request(`http://localhost:3000/api/auth/google/callback?code=expired-code&state=${state}`, { headers: { cookie: jar } }));
  assert.equal(exchanged, 1);
  assert.match(expired.headers.get("location") ?? "", /error=google_expired_code/);
  assert.deepEqual(await rt.auth!.login({ email: "ada@example.com", password: GOOD }), { ok: false, code: "invalid_credentials" });
});

test("callback creates one session, refuses a second identity, and keeps email/password login working", async () => {
  const rt = runtime();
  const seen: string[] = [];
  const exchange = async (next: GoogleProfile) => googleCallbackRoute({
    runtime: () => rt,
    config: CONFIG,
    now: () => NOW,
    exchange: async ({ code }) => { seen.push(code); return { ok: true, profile: next }; },
  });
  const start = await googleStartRoute({ runtime: () => rt, config: CONFIG, now: () => NOW })(form("/api/auth/google/start", [["intent", "login"]]));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const created = await (await exchange(profile()))(new Request(`http://localhost:3000/api/auth/google/callback?code=code-1&state=${state}`, { headers: { cookie: cookiePairs(start) } }));
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("location"), "/dashboard");
  const session = readSessionToken(cookiePairs(created));
  assert.equal(typeof session, "string");
  assert.equal(await rt.auth!.getSessionUserId(session), (await rt.auth!.getSessionUserId(session)));
  const userId = await rt.auth!.getSessionUserId(session);
  assert.ok(userId);
  assert.deepEqual(seen, ["code-1"]);
  assert.equal(created.headers.get("location")?.includes("code-1"), false);

  const again = await googleStartRoute({ runtime: () => rt, config: CONFIG, now: () => NOW })(form("/api/auth/google/start", [["intent", "login"]]));
  const againState = new URL(again.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const second = await (await exchange(profile()))(new Request(`http://localhost:3000/api/auth/google/callback?code=code-2&state=${againState}`, { headers: { cookie: cookiePairs(again) } }));
  assert.equal(await rt.auth!.getSessionUserId(readSessionToken(cookiePairs(second))), userId);

  const password = await rt.auth!.login({ email: "ada@example.com", password: GOOD });
  assert.equal(password.ok, false);
  if (!password.ok) assert.equal(password.code, "invalid_credentials");

  const registered = await rt.auth!.register({ email: "pat@example.com", password: GOOD, name: "Pat" });
  assert.equal(registered.ok, true);
  const token = new URL((rt.outbox as MemoryEmailOutbox).messages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  assert.equal((await rt.auth!.verifyEmail(token)).ok, true);
  const login = await rt.auth!.login({ email: "pat@example.com", password: GOOD });
  assert.equal(login.ok, true);
});

test("an existing email is not linked unless the signed-in user owns that verified address", async () => {
  const clock = { now: NOW };
  const repo = new MemoryAuthRepository();
  const outbox = new MemoryEmailOutbox();
  let id = 0;
  const auth = new AuthService({ repo, email: outbox, limiter: new InMemoryRateLimiter(), now: () => clock.now, newId: () => `id${++id}`, config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: FAST } });
  assert.equal((await auth.register({ email: "ada@example.com", password: GOOD })).ok, true);
  const unverified = await auth.completeGoogleSignIn(profile(), null);
  assert.deepEqual(unverified, { ok: false, code: "google_account_exists" });
  assert.equal(await repo.getGoogleIdentityBySub("google-sub-1"), null);

  const token = new URL(outbox.messages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  await auth.verifyEmail(token);
  const stillSeparate = await auth.completeGoogleSignIn(profile(), null);
  assert.deepEqual(stillSeparate, { ok: false, code: "google_account_exists" });
  assert.equal(await repo.getGoogleIdentityByUserId("id1"), null);

  const unverifiedGoogle = await auth.completeGoogleSignIn(profile({ emailVerified: false }), "id1");
  assert.deepEqual(unverifiedGoogle, { ok: false, code: "google_email_unverified" });
  assert.equal(repo.users.size, 1);

  const other = await auth.completeGoogleSignIn(profile({ sub: "other-sub", email: "other@example.com" }), "id1");
  assert.deepEqual(other, { ok: false, code: "google_link_mismatch" });

  const linked = await auth.completeGoogleSignIn(profile(), "id1");
  assert.equal(linked.ok, true);
  if (linked.ok) assert.equal(linked.userId, "id1");
  assert.equal((await repo.getGoogleIdentityBySub("google-sub-1"))!.userId, "id1");
  const login = await auth.login({ email: "ada@example.com", password: GOOD });
  assert.equal(login.ok, true);

  assert.equal((await auth.register({ email: "bea@example.com", password: GOOD })).ok, true);
  const beaToken = new URL(outbox.messages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  await auth.verifyEmail(beaToken);
  const bea = await repo.getUserByEmail("bea@example.com");
  const taken = await auth.completeGoogleSignIn(profile(), bea!.id);
  assert.deepEqual(taken, { ok: false, code: "google_identity_taken" });
  assert.equal(await repo.getGoogleIdentityByUserId(bea!.id), null);
  assert.equal((await auth.login({ email: "bea@example.com", password: GOOD })).ok, true);
});

test("ID tokens are checked locally and an access token is not treated as an account", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = (publicKey.export as (options: { format: "jwk" }) => RsaJwk)({ format: "jwk" });
  jwk.kid = "local-test";
  jwk.alg = "RS256";
  const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "local-test", typ: "JWT" }) => {
    const encoded = [header, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
    const signature = Buffer.from(rsaSign("RSA-SHA256", Buffer.from(encoded), privateKey)).toString("base64url");
    return `${encoded}.${signature}`;
  };
  const claims = { iss: "https://accounts.google.com", aud: CONFIG.clientId, exp: Math.floor(NOW.getTime() / 1000) + 300, sub: "sub-local", email: "ada@example.com", email_verified: true, name: "Ada" };
  const token = sign(claims);
  assert.equal(verifyGoogleIdToken(token, { clientId: CONFIG.clientId, now: NOW, keys: [jwk] })?.sub, "sub-local");
  assert.equal(verifyGoogleIdToken(sign({ ...claims, aud: "someone-else" }), { clientId: CONFIG.clientId, now: NOW, keys: [jwk] }), null);
  assert.equal(verifyGoogleIdToken(sign({ ...claims, exp: Math.floor(NOW.getTime() / 1000) - 120 }), { clientId: CONFIG.clientId, now: NOW, keys: [jwk] }), null);
  assert.equal(verifyGoogleIdToken(sign(claims, { alg: "none", kid: "local-test" }), { clientId: CONFIG.clientId, now: NOW, keys: [jwk] }), null);
  assert.equal(verifyGoogleIdToken(sign({ ...claims, email_verified: false }), { clientId: CONFIG.clientId, now: NOW, keys: [jwk] })?.emailVerified, false);

  const exchanged = await exchangeGoogleCode({
    config: CONFIG,
    code: "local-code",
    codeVerifier: "verifier-verifier-verifier-verifier-verifier",
    now: NOW,
    keys: [jwk],
    fetchImpl: async () => Response.json({ access_token: "must-not-escape", id_token: token }),
  });
  assert.deepEqual(exchanged, { ok: true, profile: { sub: "sub-local", email: "ada@example.com", emailVerified: true, name: "Ada" } });
  assert.equal(JSON.stringify(exchanged).includes("must-not-escape"), false);
  const expired = await exchangeGoogleCode({
    config: CONFIG,
    code: "old-code",
    codeVerifier: "verifier-verifier-verifier-verifier-verifier",
    now: NOW,
    keys: [jwk],
    fetchImpl: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
  });
  assert.deepEqual(expired, { ok: false, reason: "expired_code" });
});
