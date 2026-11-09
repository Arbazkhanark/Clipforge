// Instagram Login is tested with a fake token exchange. Nothing here contacts Meta or uses real app secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalRuntime } from "../src/server/runtime.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { buildSessionCookie } from "../src/server/auth/tokens.ts";
import { encryptToken, decryptToken, readInstagramTokenKey } from "../src/server/instagram/token-cipher.ts";
import { buildInstagramAuthorizationUrl, consumeInstagramOAuthState, exchangeInstagramCode, issueInstagramOAuthState, readInstagramOAuthConfig, type InstagramConnectedProfile, type InstagramOAuthConfig } from "../src/server/instagram/instagram-oauth.ts";
import { instagramCallbackRoute, instagramDisconnectRoute, instagramStartRoute } from "../src/server/instagram/instagram-routes.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const KEY = Buffer.alloc(32, 7);
const CONFIG: InstagramOAuthConfig = { clientId: "ig-app", clientSecret: "test-secret-not-real", redirectUri: "http://localhost:3000/api/instagram/callback", tokenKey: KEY };
const TOKEN = "ig-token-SECRET-value";

function profile(over: Partial<InstagramConnectedProfile> = {}): InstagramConnectedProfile {
  return { externalAccountId: "1789001", username: "ada.clips", accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], accessToken: TOKEN, tokenExpiresAt: new Date("2026-08-01T00:00:00Z"), ...over };
}

function form(path: string, fields: [string, string][], cookie = ""): Request {
  return new Request(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
}

async function signedIn() {
  const runtime = createLocalRuntime({ scrypt: { logN: 10, r: 8, p: 1 }, now: () => NOW });
  assert.equal((await runtime.auth!.register({ email: "ada@example.com", password: "correct horse battery", name: "Ada" })).ok, true);
  const link = runtime.outbox!.messages.at(-1)!.text.match(/https?:\/\/\S+/)![0];
  assert.equal((await runtime.auth!.verifyEmail(new URL(link).searchParams.get("token")!)).ok, true);
  const login = await runtime.auth!.login({ email: "ada@example.com", password: "correct horse battery" });
  assert.equal(login.ok, true);
  if (!login.ok) throw new Error("login");
  return { runtime, cookie: buildSessionCookie(login.sessionToken, login.expiresAt, NOW, false).split(";")[0] ?? "" };
}

test("Instagram config rejects placeholders and a redirect that is not the callback", () => {
  assert.equal(readInstagramOAuthConfig({ INSTAGRAM_APP_ID: "replace-me", INSTAGRAM_APP_SECRET: "replace-me", INSTAGRAM_OAUTH_REDIRECT_URI: CONFIG.redirectUri, INSTAGRAM_TOKEN_KEY: "replace-me" }), null);
  assert.equal(readInstagramTokenKey({ INSTAGRAM_TOKEN_KEY: KEY.toString("base64url") })?.length, 32);
  assert.equal(readInstagramOAuthConfig({ INSTAGRAM_APP_ID: CONFIG.clientId, INSTAGRAM_APP_SECRET: CONFIG.clientSecret, INSTAGRAM_OAUTH_REDIRECT_URI: "https://evil.example/steal", INSTAGRAM_TOKEN_KEY: KEY.toString("base64url") }), null);
});

test("authorization URL uses the official host and does not include the secret", () => {
  const url = new URL(buildInstagramAuthorizationUrl(CONFIG, "s".repeat(43)));
  assert.equal(url.origin + url.pathname, "https://www.instagram.com/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "instagram_business_basic,instagram_business_content_publish");
  assert.equal(url.search.includes(CONFIG.clientSecret), false);
  assert.equal(url.search.includes("password"), false);
  assert.equal(url.searchParams.has("code_challenge"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
});

test("server-side OAuth state is bound, expires, and is consumed once", () => {
  issueInstagramOAuthState("state-one-use-1", "user-1", NOW);
  assert.equal(consumeInstagramOAuthState("state-one-use-1", NOW), "user-1");
  assert.equal(consumeInstagramOAuthState("state-one-use-1", NOW), null);
  issueInstagramOAuthState("state-expired-1", "user-2", NOW);
  assert.equal(consumeInstagramOAuthState("state-expired-1", new Date(NOW.getTime() + 600_000)), null);
});

test("token ciphertext round-trips and does not contain the token", () => {
  const stored = encryptToken(KEY, TOKEN);
  assert.equal(stored.includes(TOKEN), false);
  assert.equal(decryptToken(KEY, stored), TOKEN);
  assert.equal(decryptToken(Buffer.alloc(32, 1), stored), null);
  assert.equal(decryptToken(KEY, ""), null);
  assert.equal(decryptToken(KEY, "v1.invalid.invalid.invalid"), null);
  const parts = stored.split(".");
  parts[2] = `${parts[2]?.[0] === "A" ? "B" : "A"}${parts[2]?.slice(1)}`;
  assert.equal(decryptToken(KEY, parts.join(".")), null);
  assert.equal(decryptToken(Buffer.alloc(16), stored), null);
  assert.throws(() => encryptToken(Buffer.alloc(16), TOKEN));
});

test("exchange accepts only explicit professional account types and validates returned scopes", async () => {
  const fetchFor = (accountType: unknown, permissions: unknown = ["instagram_business_basic", "instagram_business_content_publish"]): typeof fetch => async (input) => {
    const url = String(input);
    if (url.includes("api.instagram.com")) return Response.json({ access_token: "short", user_id: "1789001", permissions });
    if (url.includes("/access_token")) return Response.json({ access_token: TOKEN, expires_in: 5_184_000 });
    return Response.json({ user_id: "1789001", username: "ada.clips", account_type: accountType });
  };
  for (const accountType of ["PERSONAL", "UNKNOWN", null, undefined, "CREATOR", "business", 7]) {
    const result = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor(accountType) });
    assert.deepEqual(result, { ok: false, reason: "unsupported_account" }, `account type ${String(accountType)} must be rejected`);
  }
  for (const accountType of ["BUSINESS", "MEDIA_CREATOR"] as const) {
    assert.equal((await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor(accountType) })).ok, true);
  }
  assert.equal((await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor("BUSINESS", ["", "instagram_business_basic", "instagram_business_basic", "extra_scope", "instagram_business_content_publish"]) })).ok, true);
  const missing = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor("BUSINESS", ["instagram_business_basic"]) });
  assert.deepEqual(missing, { ok: false, reason: "missing_permission" });
  const malformed = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor("BUSINESS", ["instagram_business_basic", "instagram_business_content_publish", "bad!scope"]) });
  assert.deepEqual(malformed, { ok: false, reason: "missing_permission" });
  const expired = await exchangeInstagramCode({ config: CONFIG, code: "old", now: NOW, fetchImpl: async () => new Response("no", { status: 400 }) });
  assert.deepEqual(expired, { ok: false, reason: "expired_code" });
});

test("start and callback require state and a session, and the stored account has no token", async () => {
  const { runtime, cookie } = await signedIn();
  const oauthStates = new Map<string, string>();
  runtime.instagramOAuthStates = {
    async issue(state, ownerId) { oauthStates.set(state, ownerId); },
    async consume(state) { const ownerId = oauthStates.get(state) ?? null; oauthStates.delete(state); return ownerId; },
  };
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW };
  const blocked = await instagramStartRoute(routes)(form("/api/instagram/start", [], ""));
  assert.match(blocked.headers.get("location") ?? "", /error=not_authenticated/);
  const start = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const location = start.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/www\.instagram\.com\/oauth\/authorize\?/);
  assert.equal(location.includes(TOKEN), false);
  assert.equal(location.includes(CONFIG.clientSecret), false);
  const state = new URL(location).searchParams.get("state") ?? "";
  const jar = `${cookie}; ${start.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  const missingState = await instagramCallbackRoute(routes)(new Request("http://localhost:3000/api/instagram/callback?code=abc", { headers: { cookie: jar } }));
  assert.match(missingState.headers.get("location") ?? "", /error=instagram_invalid_state/);
  const deniedStart = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const deniedState = new URL(deniedStart.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const deniedJar = `${cookie}; ${deniedStart.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  const denied = await instagramCallbackRoute(routes)(new Request(`http://localhost:3000/api/instagram/callback?error=access_denied&state=${deniedState}`, { headers: { cookie: deniedJar } }));
  assert.match(denied.headers.get("location") ?? "", /error=instagram_cancelled/);
  const deniedReplay = await instagramCallbackRoute(routes)(new Request(`http://localhost:3000/api/instagram/callback?error=access_denied&state=${deniedState}`, { headers: { cookie: deniedJar } }));
  assert.match(deniedReplay.headers.get("location") ?? "", /error=instagram_invalid_state/);
  const mismatch = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${"b".repeat(43)}`, { headers: { cookie: jar } }));
  assert.match(mismatch.headers.get("location") ?? "", /error=instagram_invalid_state/);
  const connected = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(connected.headers.get("location") ?? "", /notice=instagram_connected/);
  const replay = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(replay.headers.get("location") ?? "", /error=instagram_invalid_state/);
  assert.equal((connected.headers.get("location") ?? "").includes(TOKEN), false);
  const accounts = await runtime.repo.listSocialAccountsForOwner((await runtime.currentUserId(new Request("http://localhost:3000/", { headers: { cookie } })))!);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.hasToken, true);
  assert.equal(accounts[0]?.accountType, "BUSINESS");
  assert.equal(JSON.stringify(accounts).includes(TOKEN), false);
  assert.equal(JSON.stringify(accounts).includes("v1."), false);
});

test("disconnect requires confirmation and does not affect another user's account", async () => {
  const ada = await signedIn();
  const saved = await ada.runtime.repo.saveInstagramConnection({ id: "acct-ada", userId: (await ada.runtime.currentUserId(new Request("http://localhost:3000/", { headers: { cookie: ada.cookie } })))!, externalAccountId: "1789001", username: "ada.clips", accountType: "BUSINESS", grantedScopes: ["instagram_business_basic"], tokenExpiresAt: NOW, encryptedAccessToken: encryptToken(KEY, TOKEN) });
  const unconfirmed = await instagramDisconnectRoute({ runtime: () => ada.runtime })(form("/api/instagram/disconnect", [["accountId", saved]], ada.cookie));
  assert.match(unconfirmed.headers.get("location") ?? "", /error=validation_failed/);
  assert.equal((await ada.runtime.repo.getSocialAccount(saved))?.status, "connected");
  assert.equal(await ada.runtime.repo.disconnectSocialAccount("someone-else", saved), false);
  const removed = await instagramDisconnectRoute({ runtime: () => ada.runtime })(form("/api/instagram/disconnect", [["accountId", saved], ["confirm", "yes"]], ada.cookie));
  assert.match(removed.headers.get("location") ?? "", /notice=instagram_disconnected/);
  const after = await ada.runtime.repo.getSocialAccount(saved);
  assert.equal(after?.status, "disconnected");
  assert.equal(after?.hasToken, undefined);
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
});

test("callback consumes valid state even when code is missing and refuses incomplete profile data without overwriting an account", async () => {
  const { runtime, cookie } = await signedIn();
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW };
  const start = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const state = new URL(start.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const jar = `${cookie}; ${start.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  const missingCode = await instagramCallbackRoute(routes)(new Request(`http://localhost:3000/api/instagram/callback?state=${state}`, { headers: { cookie: jar } }));
  assert.match(missingCode.headers.get("location") ?? "", /error=instagram_callback_error/);
  const missingCodeReplay = await instagramCallbackRoute(routes)(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(missingCodeReplay.headers.get("location") ?? "", /error=instagram_invalid_state/);

  const ownerId = (await runtime.currentUserId(new Request("http://localhost:3000/", { headers: { cookie } })))!;
  await runtime.repo.saveInstagramConnection({ id: "existing", userId: ownerId, externalAccountId: "1789001", username: "existing.name", accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2026-08-01T00:00:00Z"), encryptedAccessToken: encryptToken(KEY, "original-fake-token") });
  const retryStart = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const retryState = new URL(retryStart.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const retryJar = `${cookie}; ${retryStart.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  const incomplete = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile({ username: null, accountType: "UNKNOWN", grantedScopes: ["instagram_business_basic"] }) }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${retryState}`, { headers: { cookie: retryJar } }));
  assert.match(incomplete.headers.get("location") ?? "", /error=instagram_unsupported_account/);
  const existing = await runtime.repo.getSocialAccount("existing");
  assert.equal(existing?.username, "existing.name");
  assert.equal(existing?.accountType, "BUSINESS");
});

test("callback state is bound to its starting session and provider failures never reach the redirect", async () => {
  const { runtime, cookie } = await signedIn();
  const originalResolver = runtime.currentUserId;
  let activeUserId = await originalResolver(new Request("http://localhost:3000/", { headers: { cookie } }));
  runtime.currentUserId = async () => activeUserId;
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW };
  const start = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const state = new URL(start.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const jar = `${cookie}; ${start.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  activeUserId = "different-user";
  let exchangeCalls = 0;
  const wrongOwner = await instagramCallbackRoute({ ...routes, exchange: async () => { exchangeCalls += 1; throw new Error(TOKEN); } })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(wrongOwner.headers.get("location") ?? "", /error=not_authenticated/);
  assert.equal(exchangeCalls, 0);
  activeUserId = await originalResolver(new Request("http://localhost:3000/", { headers: { cookie } }));
  const retryStart = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const retryState = new URL(retryStart.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const retryJar = `${cookie}; ${retryStart.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  let logged = "";
  const oldConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged += args.map(String).join(" "); };
  let failed: Response;
  try {
    failed = await instagramCallbackRoute({ ...routes, exchange: async () => { throw new Error(TOKEN); } })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${retryState}`, { headers: { cookie: retryJar } }));
  } finally { console.error = oldConsoleError; }
  assert.match(failed.headers.get("location") ?? "", /error=instagram_callback_error/);
  assert.equal((failed.headers.get("location") ?? "").includes(TOKEN), false);
  assert.equal(logged.includes(TOKEN), false);
  runtime.currentUserId = originalResolver;
});

test("Prisma mapping keeps the ciphertext in the row and out of the account record", async () => {
  const repo = new PrismaRepository(new FakePrismaClient());
  const memory = new MemoryRepository();
  const ciphertext = encryptToken(KEY, TOKEN);
  const id = await repo.saveInstagramConnection({ id: "acct-1", userId: "ada", externalAccountId: "1789001", username: "ada.clips", accountType: "MEDIA_CREATOR", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: NOW, encryptedAccessToken: ciphertext });
  const view = await repo.getSocialAccount(id);
  assert.equal(view?.hasToken, true);
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  assert.equal(JSON.stringify(view).includes(ciphertext), false);
  await memory.saveInstagramConnection({ id: "acct-2", userId: "ada", externalAccountId: "1789001", username: null, accountType: "BUSINESS", grantedScopes: [], tokenExpiresAt: NOW, encryptedAccessToken: ciphertext });
  assert.equal(JSON.stringify(await memory.listSocialAccountsForOwner("ada")).includes(ciphertext), false);
  assert.equal(await repo.disconnectSocialAccount("eve", id), false);
  assert.equal((await repo.getSocialAccount(id))?.hasToken, true);
});

