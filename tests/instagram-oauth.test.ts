// Instagram Login is tested with a fake token exchange. Nothing here contacts Meta or uses real app secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalRuntime } from "../src/server/runtime.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { buildSessionCookie } from "../src/server/auth/tokens.ts";
import { encryptToken, decryptToken, readInstagramTokenKey } from "../src/server/instagram/token-cipher.ts";
import { buildInstagramAuthorizationUrl, exchangeInstagramCode, readInstagramOAuthConfig, type InstagramConnectedProfile, type InstagramOAuthConfig } from "../src/server/instagram/instagram-oauth.ts";
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

test("token ciphertext round-trips and does not contain the token", () => {
  const stored = encryptToken(KEY, TOKEN);
  assert.equal(stored.includes(TOKEN), false);
  assert.equal(decryptToken(KEY, stored), TOKEN);
  assert.equal(decryptToken(Buffer.alloc(32, 1), stored), null);
});

test("exchange refuses a personal account, missing permissions, and a bad code", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.instagram.com")) return Response.json({ access_token: "short", user_id: "1789001", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
    if (url.includes("/access_token")) return Response.json({ access_token: TOKEN, expires_in: 5_184_000 });
    return Response.json({ username: "ada.clips", account_type: "PERSONAL" });
  };
  const personal = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl });
  assert.deepEqual(personal, { ok: false, reason: "unsupported_account" });
  const missing = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: async (input) => String(input).includes("api.instagram.com") ? Response.json({ access_token: "short", user_id: "1789001", permissions: ["instagram_business_basic"] }) : Response.json({}) });
  assert.deepEqual(missing, { ok: false, reason: "missing_permission" });
  const expired = await exchangeInstagramCode({ config: CONFIG, code: "old", now: NOW, fetchImpl: async () => new Response("no", { status: 400 }) });
  assert.deepEqual(expired, { ok: false, reason: "expired_code" });
});

test("start and callback require state and a session, and the stored account has no token", async () => {
  const { runtime, cookie } = await signedIn();
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
  const denied = await instagramCallbackRoute(routes)(new Request("http://localhost:3000/api/instagram/callback?error=access_denied", { headers: { cookie: jar } }));
  assert.match(denied.headers.get("location") ?? "", /error=instagram_cancelled/);
  const mismatch = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${"b".repeat(43)}`, { headers: { cookie: jar } }));
  assert.match(mismatch.headers.get("location") ?? "", /error=instagram_invalid_state/);
  const connected = await instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(connected.headers.get("location") ?? "", /notice=instagram_connected/);
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

