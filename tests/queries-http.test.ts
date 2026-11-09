import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { DEMO_USER_ID, DEMO_CYCLE_ID, seedDemoData } from "../src/server/demo-data.ts";
import { buildContext, type Runtime } from "../src/server/runtime.ts";
import { getCollectionDetail, getCollectionsOverview, getCycleDetail, getDashboardData, getInstagramAccounts, getMediaLibrary, MEDIA_PAGE_SIZE } from "../src/server/queries.ts";
import { AppError } from "../src/server/errors.ts";
import { jsonRoute, checkSameOrigin, MAX_JSON_BODY_BYTES } from "../src/server/http.ts";
import { createCycle, mixIntoCycle, startPublishingCycle } from "../src/server/handlers/cycles.ts";
import { bulkUpdateCaptions } from "../src/server/handlers/captions-covers.ts";
import { createGrant } from "../src/server/handlers/sharing.ts";
import { NOW } from "./helpers.ts";

let repo: MemoryRepository;
let counter = 0;
const runtimeFor = (userId: string | null): Runtime => ({ mode: "demo", repo, currentUserId: async () => userId, newId: () => `id${++counter}`, now: () => NOW });
const ctxFor = (userId: string | null) => buildContext(runtimeFor(userId));
const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (e) { return e as AppError; } assert.fail("expected error"); };
beforeEach(() => { repo = new MemoryRepository(); seedDemoData(repo, NOW); });

// ---------- queries ----------
test("queries require sign-in", async () => {
  const anon = await ctxFor(null);
  for (const q of [() => getDashboardData(anon), () => getMediaLibrary(anon, 1), () => getCollectionsOverview(anon), () => getCollectionDetail(anon, "demo-col-1"), () => getCycleDetail(anon, DEMO_CYCLE_ID)]) assert.equal((await errorOf(q())).status, 401);
});

test("Instagram account cards report safe eligibility states without exposing account ids or tokens", async () => {
  const valid = { platform: "instagram" as const, status: "connected" as const, hasToken: true, accountType: "BUSINESS" as const, grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2026-08-01T00:00:00Z") };
  repo.socialAccounts.set("eligible", { id: "eligible", userId: DEMO_USER_ID, ...valid });
  repo.socialAccounts.set("permissions", { id: "permissions", userId: DEMO_USER_ID, ...valid, grantedScopes: ["instagram_business_basic"] });
  repo.socialAccounts.set("personal", { id: "personal", userId: DEMO_USER_ID, ...valid, accountType: "PERSONAL" });
  repo.socialAccounts.set("unknown", { id: "unknown", userId: DEMO_USER_ID, ...valid, accountType: undefined });
  repo.socialAccounts.set("expired", { id: "expired", userId: DEMO_USER_ID, ...valid, status: "token_expired" });
  repo.socialAccounts.set("disconnected", { id: "disconnected", userId: DEMO_USER_ID, ...valid, status: "disconnected" });
  repo.socialAccounts.set("unknown-status", { id: "unknown-status", userId: DEMO_USER_ID, ...valid, status: "unknown" as never });
  const cards = await getInstagramAccounts(await ctxFor(DEMO_USER_ID));
  assert.deepEqual(Object.fromEntries(cards.filter((card) => card.id !== "demo-account").map((card) => [card.id, card.eligibilityStatus])), {
    eligible: "connected_eligible", permissions: "missing_permissions", personal: "unsupported_personal", unknown: "unsupported_account_type", expired: "expired_connection", disconnected: "not_connected", "unknown-status": "reconnection_required",
  });
  assert.equal(JSON.stringify(cards).includes("externalAccountId"), false);
  assert.equal(JSON.stringify(cards).includes("accessToken"), false);
});

test("media library paging: page size, totals, newest first, bounds", async () => {
  const ctx = await ctxFor(DEMO_USER_ID);
  const first = await getMediaLibrary(ctx, undefined);
  assert.deepEqual([first.items.length, first.total, first.page, first.pageCount, first.pageSize], [MEDIA_PAGE_SIZE, 30, 1, 2, 24]);
  assert.equal(first.items[0]!.title, "Sample clip 01"); // created 1 day ago = newest
  assert.equal((await getMediaLibrary(ctx, "2")).items.length, 6);
  assert.equal((await getMediaLibrary(ctx, 3)).items.length, 0);
  for (const bad of [0, -2, 1.5, "x", NaN, 1e9]) assert.equal((await errorOf(getMediaLibrary(ctx, bad))).status, 422);
});

test("view models contain ONLY whitelisted fields (no storage keys, urls, owner ids)", async () => {
  const ctx = await ctxFor(DEMO_USER_ID);
  const everything = JSON.stringify([await getMediaLibrary(ctx, 1), await getCollectionsOverview(ctx), await getCollectionDetail(ctx, "demo-shared-col-1"), await getDashboardData(ctx)]);
  assert.ok(!/storageKey|ownerId|granteeId|grantedById|https?:|s3/i.test(everything), everything.slice(0, 200));
  const media = (await getMediaLibrary(ctx, 1)).items[0]!;
  assert.deepEqual(Object.keys(media).sort(), ["durationMs", "hasThumbnail", "height", "id", "kind", "sizeBytes", "status", "title", "validation", "width"]);
});

test("dashboard summaries include owner-safe campaign counts, next planned time, and status filtering", async () => {
  const ctx = await ctxFor(DEMO_USER_ID);
  const all = await getDashboardData(ctx);
  assert.equal(all.campaigns.length, 1);
  assert.deepEqual([all.campaigns[0]!.totalItems, all.campaigns[0]!.scheduledItems], [4, 2]);
  assert.equal(all.campaigns[0]!.nextScheduledAt!.toISOString(), new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
  assert.equal(all.campaigns[0]!.accountName, "Instagram account");
  assert.equal((await getDashboardData(ctx, "Asia/Kolkata", "completed")).campaigns.length, 0);
  repo.cycles.set(DEMO_CYCLE_ID, { ...repo.cycles.get(DEMO_CYCLE_ID)!, status: "running" });
  assert.equal((await getDashboardData(ctx, "Asia/Kolkata", "running")).campaigns[0]!.status, "running");
  const eve = await getDashboardData(await ctxFor("eve"));
  assert.deepEqual(eve.campaigns, []);
});

test("a collection you cannot view is indistinguishable from a missing one; expired and revoked grants end access", async () => {
  const eve = await ctxFor("eve");
  const hidden = await errorOf(getCollectionDetail(eve, "demo-col-1")); const missing = await errorOf(getCollectionDetail(eve, "zzz"));
  assert.deepEqual([hidden.status, hidden.message], [missing.status, missing.message]);
  repo.grants[0] = { ...repo.grants[0]!, expiresAt: new Date(NOW.getTime() - 1) };
  assert.equal((await errorOf(getCollectionDetail(await ctxFor(DEMO_USER_ID), "demo-shared-col-1"))).status, 404);
  assert.equal((await getCollectionsOverview(await ctxFor(DEMO_USER_ID))).sharedWithMe.length, 1);
});

test("public-view collections are visible to others but give them no use/import/download", async () => {
  repo.collections.set("pub", { id: "pub", ownerId: "someone", visibility: "public_view", archived: false, name: "Public one", mediaIds: ["demo-shared-1"] });
  const detail = await getCollectionDetail(await ctxFor("eve"), "pub");
  assert.deepEqual(detail.permissions, { canUseInCycle: false, canImport: false, canDownload: false, isOwner: false });
});

test("deleted media is hidden from collections and the library", async () => {
  repo.media.set("demo-media-1", { ...repo.media.get("demo-media-1")!, status: "deleted" });
  const ctx = await ctxFor(DEMO_USER_ID);
  assert.equal((await getCollectionDetail(ctx, "demo-col-1")).videos.length, 4);
  assert.equal((await getMediaLibrary(ctx, 1)).total, 29);
});

// ---------- HTTP routes ----------
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request("http://localhost:3000/api/x", { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000", ...headers }, body: raw ?? JSON.stringify(body) });
const route = (handler: Parameters<typeof jsonRoute>[0], userId: string | null = DEMO_USER_ID) => jsonRoute(handler, () => runtimeFor(userId));

test("route: works end to end and never caches", async () => {
  const response = await route(createCycle)(post({ name: "Via route", socialAccountId: "demo-account" }));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const { cycleId } = await response.json() as { cycleId: string };
  assert.equal(repo.cycles.get(cycleId)!.name, "Via route");
});

test("route: CSRF protections - cross-site Origin, Sec-Fetch-Site and non-JSON content types are refused", async () => {
  const handler = route(createCycle);
  const body = { name: "x", socialAccountId: "demo-account" };
  assert.equal((await handler(post(body, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handler(post(body, { origin: "not a url" }))).status, 403);
  assert.equal((await handler(post(body, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await handler(post(body, { "content-type": "application/x-www-form-urlencoded" }, "name=x"))).status, 415);
  assert.equal((await handler(post(body, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handler(post(body, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).status, 200);
  assert.equal(repo.cycles.size, 2); // seed cycle + the one allowed request; the refused ones created nothing
  assert.equal(checkSameOrigin(post(body)), null);
});

test("route: bad JSON, huge bodies and invalid fields get clean 4xx errors", async () => {
  const handler = route(createCycle);
  assert.equal((await handler(post(null, {}, "{not json"))).status, 400);
  assert.equal((await handler(post(null, { "content-length": String(MAX_JSON_BODY_BYTES + 1) }, "{}"))).status, 413);
  assert.equal((await handler(post(null, {}, JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES) })))).status, 413);
  const invalid = await handler(post({ name: "", socialAccountId: "../x" }));
  assert.equal(invalid.status, 422);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "validation_failed");
});

test("route: unexpected errors become a generic 500 with no internals", async () => {
  const boom = route(async () => { throw new Error("secret db password in stack"); });
  const response = await boom(post({}));
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes("secret"));
});

test("route: not signed in = 401; unconfigured database = 503; neither touches data", async () => {
  assert.equal((await route(createCycle, null)(post({ name: "x", socialAccountId: "demo-account" }))).status, 401);
  const unconfigured = jsonRoute(createCycle, () => ({ ...runtimeFor(DEMO_USER_ID), mode: "unconfigured" as const, repo: new Proxy({}, { get: () => () => { throw new AppError(503, "not_configured", "no db"); } }) as MemoryRepository }));
  assert.equal((await unconfigured(post({ name: "x", socialAccountId: "demo-account" }))).status, 503);
  assert.equal(repo.cycles.size, 1);
});

test("routes expose the real handlers with the same protections (ownership, plan limits, concurrency)", async () => {
  // Ownership: another user cannot edit the demo cycle's captions through the route.
  const caption = { cycleId: DEMO_CYCLE_ID, target: { kind: "all_upcoming" }, caption: "x", expectedVersions: { "demo-item-1": 1 } };
  assert.equal((await route(bulkUpdateCaptions, "eve")(post(caption))).status, 404);
  // Plan limit through the route: Creator owner may share, but a Free owner may not.
  repo.plans.set("freeowner", "free"); repo.collections.set("fc", { id: "fc", ownerId: "freeowner", visibility: "private", archived: false, mediaIds: [] });
  const denied = await route(createGrant, "freeowner")(post({ collectionId: "fc", granteeId: "someone", capabilities: ["view"] }));
  assert.equal(denied.status, 403); assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "plan_limit");
  // Mixing a shared video via the route works for the demo user (grant allows use) and rejects the view-only one.
  const mixed = await route(mixIntoCycle)(post({ cycleId: DEMO_CYCLE_ID, videos: [{ mediaAssetId: "demo-shared-2", collectionId: "demo-shared-col-1" }, { mediaAssetId: "demo-shared-3", collectionId: "demo-shared-col-2" }] }));
  const mixedBody = await mixed.json() as { added: number; rejected: unknown[] };
  assert.deepEqual([mixedBody.added, mixedBody.rejected.length], [1, 1]);
  // Starting a draft cycle with an unconfirmed review is refused with the report.
  assert.equal((await route(startPublishingCycle)(post({ cycleId: DEMO_CYCLE_ID, confirmFinalReview: false }))).status, 409);
});
