// Instagram Login is tested with a fake token exchange. Nothing here contacts Meta or uses real app secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalRuntime } from "../src/server/runtime.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { buildSessionCookie } from "../src/server/auth/tokens.ts";
import { encryptToken, decryptToken, readInstagramTokenKey } from "../src/server/instagram/token-cipher.ts";
import { buildInstagramAuthorizationUrl, consumeInstagramOAuthState, exchangeInstagramCode, instagramStateCookieName, issueInstagramOAuthState, readInstagramOAuthConfig, type InstagramConnectedProfile, type InstagramExchangeResult, type InstagramOAuthConfig } from "../src/server/instagram/instagram-oauth.ts";
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
  assert.deepEqual(missing, { ok: false, reason: "authorization_code_permissions_invalid" });
  const malformed = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: fetchFor("BUSINESS", ["instagram_business_basic", "instagram_business_content_publish", "bad!scope"]) });
  assert.deepEqual(malformed, { ok: false, reason: "authorization_code_permissions_invalid" });
  const expired = await exchangeInstagramCode({ config: CONFIG, code: "old", now: NOW, fetchImpl: async () => new Response("no", { status: 400 }) });
  assert.deepEqual(expired, { ok: false, reason: "expired_code" });
});

test("exchange failures report fixed stage reasons without retaining provider response details", async () => {
  const validAuth = () => Response.json({ access_token: "short", user_id: "1789001", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
  const validLong = () => Response.json({ access_token: TOKEN, expires_in: 5_184_000 });
  const validProfile = () => Response.json({ user_id: "1789001", username: "ada.clips", account_type: "BUSINESS" });
  const cases: Array<{ name: string; fetchImpl: typeof fetch; reason: string }> = [
    { name: "authorization network", fetchImpl: async () => { throw new Error(TOKEN); }, reason: "authorization_code_exchange_network_error" },
    { name: "authorization rejected", fetchImpl: async () => new Response("private provider body", { status: 500 }), reason: "authorization_code_exchange_rejected" },
    { name: "authorization response malformed", fetchImpl: async () => Response.json({}), reason: "authorization_code_response_invalid" },
    { name: "authorization permissions missing", fetchImpl: async () => Response.json({ access_token: "short", user_id: "1789001", permissions: [] }), reason: "authorization_code_permissions_invalid" },
    { name: "long token network", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : Promise.reject(new Error(TOKEN)), reason: "long_lived_token_exchange_network_error" },
    { name: "long token rejected", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : new Response("private provider body", { status: 500 }), reason: "long_lived_token_exchange_rejected" },
    { name: "long token response malformed", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : Response.json({ access_token: "", expires_in: 0 }), reason: "long_lived_token_response_invalid" },
    { name: "profile network", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : Promise.reject(new Error(TOKEN)), reason: "profile_lookup_network_error" },
    { name: "profile rejected", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : new Response("private provider body", { status: 500 }), reason: "profile_lookup_rejected" },
    { name: "profile malformed", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : new Response("not-json"), reason: "profile_response_invalid" },
    { name: "profile identity mismatch", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : Response.json({ user_id: "other", username: "ada.clips", account_type: "BUSINESS" }), reason: "profile_identity_mismatch" },
    { name: "unsupported account", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : Response.json({ user_id: "1789001", username: "ada.clips", account_type: "PERSONAL" }), reason: "unsupported_account" },
    { name: "invalid username", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? validLong() : Response.json({ user_id: "1789001", username: "bad username", account_type: "BUSINESS" }), reason: "profile_username_invalid" },
    { name: "invalid expiry", fetchImpl: async (input) => String(input).includes("api.instagram.com") ? validAuth() : String(input).includes("/access_token") ? Response.json({ access_token: TOKEN, expires_in: 1e100 }) : validProfile(), reason: "token_expiry_invalid" },
  ];
  for (const entry of cases) {
    const result = await exchangeInstagramCode({ config: CONFIG, code: "good", now: NOW, fetchImpl: entry.fetchImpl });
    assert.deepEqual(result, { ok: false, reason: entry.reason }, entry.name);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, entry.name);
  }
});

test("start and callback require state and a session, and the stored account has no token", async () => {
  const { runtime, cookie } = await signedIn();
  const oauthStates = new Map<string, string>();
  runtime.instagramOAuthStates = {
    async issue(state, ownerId) { oauthStates.set(state, ownerId); },
    async consume(state) { const userId = oauthStates.get(state); oauthStates.delete(state); return userId ? { status: "consumed", userId } : { status: "not_found" }; },
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

test("overlapping OAuth starts keep independent browser cookies and one-time states", async () => {
  const { runtime, cookie } = await signedIn();
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW };
  const first = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const firstState = new URL(first.headers.get("location") ?? "https://invalid/").searchParams.get("state")!;
  const firstStateCookie = first.headers.getSetCookie().map((item) => item.split(";")[0]!).find((item) => item.includes("clipforge_ig_state_"))!;
  const second = await instagramStartRoute(routes)(form("/api/instagram/start", [], `${cookie}; ${firstStateCookie}`));
  const secondState = new URL(second.headers.get("location") ?? "https://invalid/").searchParams.get("state")!;
  const secondStateCookie = second.headers.getSetCookie().map((item) => item.split(";")[0]!).find((item) => item.includes("clipforge_ig_state_"))!;
  assert.notEqual(firstStateCookie.split("=", 1)[0], secondStateCookie.split("=", 1)[0]);
  const cookieJar = `${cookie}; ${firstStateCookie}; ${secondStateCookie}`;
  const callback = instagramCallbackRoute({ ...routes, exchange: async () => ({ ok: true, profile: profile() }) });
  const firstCallback = await callback(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${firstState}`, { headers: { cookie: cookieJar } }));
  const secondCallback = await callback(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${secondState}`, { headers: { cookie: cookieJar } }));
  assert.match(firstCallback.headers.get("location") ?? "", /notice=instagram_connected/);
  assert.match(secondCallback.headers.get("location") ?? "", /notice=instagram_connected/);
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
  const ownerDiagnostics: Array<{ event: string; reason: string }> = [];
  const wrongOwner = await instagramCallbackRoute({ ...routes, diagnosticLogger: { warn: (entry) => ownerDiagnostics.push(entry) }, exchange: async () => { exchangeCalls += 1; throw new Error(TOKEN); } })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${state}`, { headers: { cookie: jar } }));
  assert.match(wrongOwner.headers.get("location") ?? "", /error=not_authenticated/);
  assert.equal(exchangeCalls, 0);
  assert.deepEqual(ownerDiagnostics, [{ event: "instagram_oauth_state_rejected", reason: "session_user_mismatch" }]);
  activeUserId = await originalResolver(new Request("http://localhost:3000/", { headers: { cookie } }));
  const retryStart = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
  const retryState = new URL(retryStart.headers.get("location") ?? "https://invalid/").searchParams.get("state") ?? "";
  const retryJar = `${cookie}; ${retryStart.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ")}`;
  const diagnostics: Array<{ event: string; reason: string }> = [];
  let logged = "";
  const oldConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged += args.map(String).join(" "); };
  let failed: Response;
  try {
    failed = await instagramCallbackRoute({ ...routes, diagnosticLogger: { warn: (entry) => diagnostics.push(entry) }, exchange: async () => { throw new Error(TOKEN); } })(new Request(`http://localhost:3000/api/instagram/callback?code=abc&state=${retryState}`, { headers: { cookie: retryJar } }));
  } finally { console.error = oldConsoleError; }
  assert.match(failed.headers.get("location") ?? "", /error=instagram_callback_error/);
  assert.equal((failed.headers.get("location") ?? "").includes(TOKEN), false);
  assert.equal(logged.includes(TOKEN), false);
  assert.deepEqual(diagnostics, [{ event: "instagram_oauth_exchange_failed", reason: "exchange_unexpected_failure" }]);
  assert.equal(JSON.stringify(diagnostics).includes(TOKEN), false);
  runtime.currentUserId = originalResolver;
});

test("callback emits fixed diagnostics for provider, code, exchange, and persistence failures", async () => {
  const { runtime, cookie } = await signedIn();
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW };
  const diagnostics: Array<{ event: string; reason: string }> = [];
  const logger = { warn: (entry: { event: string; reason: string }) => diagnostics.push(entry) };
  const invoke = async (query: string, exchange?: () => Promise<InstagramExchangeResult>, alter?: () => void) => {
    const start = await instagramStartRoute(routes)(form("/api/instagram/start", [], cookie));
    const state = new URL(start.headers.get("location") ?? "https://invalid/").searchParams.get("state")!;
    const stateCookie = start.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    alter?.();
    const before = diagnostics.length;
    const response = await instagramCallbackRoute({ ...routes, diagnosticLogger: logger, ...(exchange ? { exchange } : {}) })(new Request(`http://localhost:3000/api/instagram/callback${query}&state=${state}`, { headers: { cookie: `${cookie}; ${stateCookie}` } }));
    return { response, entries: diagnostics.slice(before) };
  };

  const provider = await invoke("?error=server_error", async () => ({ ok: true, profile: profile() }));
  assert.match(provider.response.headers.get("location") ?? "", /error=instagram_callback_error/);
  assert.deepEqual(provider.entries, [{ event: "instagram_oauth_callback_rejected", reason: "provider_returned_error" }]);

  const malformedCode = await invoke("?code=bad%20code", async () => ({ ok: true, profile: profile() }));
  assert.deepEqual(malformedCode.entries, [{ event: "instagram_oauth_callback_rejected", reason: "authorization_code_missing_or_malformed" }]);

  const providerReasons = ["authorization_code_exchange_network_error", "authorization_code_exchange_rejected", "authorization_code_response_invalid", "authorization_code_permissions_invalid", "long_lived_token_exchange_network_error", "long_lived_token_exchange_rejected", "long_lived_token_response_invalid", "profile_lookup_network_error", "profile_lookup_rejected", "profile_response_invalid", "profile_identity_mismatch", "unsupported_account", "profile_username_invalid", "token_expiry_invalid"] as const;
  for (const reason of providerReasons) {
    const result = await invoke("?code=abc", async () => ({ ok: false, reason }));
    assert.deepEqual(result.entries, [{ event: "instagram_oauth_exchange_failed", reason }], reason);
    assert.match(result.response.headers.get("location") ?? "", /error=instagram_/);
  }

  const thrown = await invoke("?code=abc", async () => { throw new Error(TOKEN); });
  assert.deepEqual(thrown.entries, [{ event: "instagram_oauth_exchange_failed", reason: "exchange_unexpected_failure" }]);

  const persistenceCases: Array<{ stage: string; change: () => void; restore: () => void }> = [
    { stage: "plan_activation", change: () => { runtime.repo.getPlanIdForUser = async () => { throw new Error(TOKEN); }; }, restore: () => { runtime.repo.getPlanIdForUser = originalPlan; } },
    { stage: "account_link", change: () => { runtime.repo.saveInstagramConnectionWithinLimit = async () => { throw new Error(TOKEN); }; }, restore: () => { runtime.repo.saveInstagramConnectionWithinLimit = originalSave; } },
    { stage: "audit_write", change: () => { runtime.repo.appendAudit = async () => { throw new Error(TOKEN); }; }, restore: () => { runtime.repo.appendAudit = originalAudit; } },
  ];
  const originalPlan = runtime.repo.getPlanIdForUser.bind(runtime.repo);
  const originalSave = runtime.repo.saveInstagramConnectionWithinLimit.bind(runtime.repo);
  const originalAudit = runtime.repo.appendAudit.bind(runtime.repo);
  let accountSuffix = 1;
  for (const entry of persistenceCases) {
    const result = await invoke("?code=abc", async () => ({ ok: true, profile: profile({ externalAccountId: `1789${accountSuffix++}` }) }), entry.change);
    entry.restore();
    assert.match(result.response.headers.get("location") ?? "", /error=instagram_callback_error/);
    assert.deepEqual(result.entries, [{ event: "instagram_oauth_persistence_failed", reason: `${entry.stage}_failed` }]);
  }
  assert.equal(JSON.stringify(diagnostics).includes(TOKEN), false);
  assert.equal(JSON.stringify(diagnostics).includes(CONFIG.clientSecret), false);
});

test("OAuth callback diagnostics distinguish state rejection causes without logging state material", async () => {
  const { runtime, cookie } = await signedIn();
  const diagnostics: Array<{ event: string; reason: string }> = [];
  const logger = { warn: (entry: { event: string; reason: string }) => diagnostics.push(entry) };
  const routes = { runtime: () => runtime, config: CONFIG, now: () => NOW, diagnosticLogger: logger };
  const request = (query: string, state: string, cookieValue?: string) => new Request(`http://localhost:3000/api/instagram/callback${query}`, { headers: { cookie: `${cookie}${cookieValue === undefined ? "" : `; ${instagramStateCookieName(state, false)}=${cookieValue}`}` } });
  const call = async (query: string, state: string, cookieValue?: string) => instagramCallbackRoute(routes)(request(query, state, cookieValue));
  const state = "a".repeat(43);

  await instagramCallbackRoute(routes)(new Request("http://localhost:3000/api/instagram/callback", { headers: { cookie } }));
  await call(`?state=${state}`, state);
  await call("?state=bad", "bad", "bad");
  await call(`?state=${state}`, state, "bad");
  await call(`?state=${state}`, state, "b".repeat(43));
  await call(`?state=${state}`, state, state); // Correct cookie/query pair, but no persisted token hash.

  const expired = "e".repeat(43);
  await runtime.instagramOAuthStates!.issue(expired, "owner1", new Date(NOW.getTime() - 601_000));
  await call(`?state=${expired}`, expired, expired);

  const consumed = "c".repeat(43);
  await runtime.instagramOAuthStates!.issue(consumed, "owner1", NOW);
  assert.equal((await runtime.instagramOAuthStates!.consume(consumed, NOW)).status, "consumed");
  await call(`?state=${consumed}`, consumed, consumed);

  assert.deepEqual(diagnostics.map((entry) => entry.reason), [
    "state_parameter_missing",
    "state_cookie_missing",
    "state_parameter_malformed",
    "state_cookie_malformed",
    "state_cookie_query_mismatch",
    "state_hash_not_found",
    "state_record_expired",
    "state_record_already_consumed",
  ]);
  assert.ok(diagnostics.every((entry) => entry.event === "instagram_oauth_state_rejected"));
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(state), false);
  assert.equal(serialized.includes(cookie), false);
});

test("OAuth state-store database failure is logged safely and fails closed", async () => {
  const { runtime, cookie } = await signedIn();
  const state = "d".repeat(43);
  const diagnostics: Array<{ event: string; reason: string }> = [];
  runtime.instagramOAuthStates = { issue: async () => undefined, consume: async () => { throw new Error("sensitive database detail"); } };
  const response = await instagramCallbackRoute({ runtime: () => runtime, config: CONFIG, now: () => NOW, diagnosticLogger: { warn: (entry) => diagnostics.push(entry) } })(new Request(`http://localhost:3000/api/instagram/callback?state=${state}`, { headers: { cookie: `${cookie}; ${instagramStateCookieName(state, false)}=${state}` } }));
  assert.match(response.headers.get("location") ?? "", /error=database_unavailable/);
  assert.deepEqual(diagnostics, [{ event: "instagram_oauth_state_lookup_failed", reason: "state_store_database_error" }]);
  assert.equal(JSON.stringify(diagnostics).includes("sensitive database detail"), false);
  assert.equal(JSON.stringify(diagnostics).includes(state), false);
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

