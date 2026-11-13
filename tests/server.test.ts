import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { AppError, toHttpResult } from "../src/server/errors.ts";
import { readVersionMap, Problems } from "../src/server/validation.ts";
import { bulkUpdateCaptions, bulkUpdateCovers } from "../src/server/handlers/captions-covers.ts";
import { createGrant, decideCollectionAccessRequest, requestCollectionAccess, revokeGrant } from "../src/server/handlers/sharing.ts";
import { changeCycleStatus, createCycle, mixIntoCycle, unmixFromCycle, startPublishingCycle, saveCycleSchedule } from "../src/server/handlers/cycles.ts";
import { getCollectionCapabilities } from "../src/lib/domain/sharing-permissions.ts";
import { monthStartUtc } from "../src/lib/domain/usage-accounting.ts";
import { buildPreflightReport } from "../src/server/preflight-service.ts";
import { NOW, inDays, makeCollection, makeGrant, makeItem, makeMedia } from "./helpers.ts";
import type { PlanId } from "../src/lib/billing/catalog.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";

// ---------- helpers ----------
let idCounter = 0;
function setup(plans: Record<string, PlanId> = { bob: "pro", owner: "pro" }) {
  const repo = new MemoryRepository();
  for (const [user, plan] of Object.entries(plans)) repo.plans.set(user, plan);
  repo.cycles.set("cycle1", { id: "cycle1", ownerId: "bob", status: "draft", finalReviewConfirmed: false, name: "June", socialAccountId: "acct1" });
  repo.socialAccounts.set("acct1", { id: "acct1", userId: "bob", platform: "instagram", status: "connected", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date("2026-08-01T00:00:00Z") });
  repo.socialAccounts.set("acctEve", { id: "acctEve", userId: "eve", status: "connected" });
  const ctxFor = (userId: string | null, over: Partial<RequestContext> = {}): RequestContext =>
    ({ userId, now: NOW, repo, newId: () => `new${++idCounter}`, config: { coverSupport: "supported" }, ...over });
  return { repo, ctxFor };
}
const addItems = (repo: MemoryRepository, items: ReturnType<typeof makeItem>[]) => items.forEach((i) => repo.items.set(i.id, i));
const own = (id: string, extra = {}) => makeItem({ id, cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: `m-${id}`, sourceKind: "owned", sourceCollectionId: null, ...extra });
const errorOf = async (promise: Promise<unknown>): Promise<AppError> => { try { await promise; } catch (e) { assert.ok(e instanceof AppError, `expected AppError, got ${e}`); return e as AppError; } assert.fail("expected an error"); };
const versionsOf = (repo: MemoryRepository, ids: string[]) => Object.fromEntries(ids.map((id) => [id, repo.items.get(id)!.version]));
const grantActivePlan = (repo: MemoryRepository, userId: string, planId: "creator" | "pro" | "agency") => {
  repo.promotionalAccessGrants.set(`promo-${userId}`, {
    id: `promo-${userId}`, promotionId: `promotion-${userId}`, userId, redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status: "active", planId,
    durationDays: 3, queueSequence: 1n, startsAt: new Date(NOW.getTime() - 1), expiresAt: inDays(3), activatedAt: new Date(NOW.getTime() - 1), revokedAt: null,
    grantedByAdminId: "admin", reason: null, createdAt: NOW, updatedAt: NOW,
  });
  repo.setUserRole(userId, "user");
};

// ---------- authentication & error shapes ----------
test("every handler requires a signed-in user (401) before doing anything", async () => {
  const { repo, ctxFor } = setup();
  const anon = ctxFor(null);
  for (const call of [bulkUpdateCaptions, bulkUpdateCovers, createGrant, revokeGrant, requestCollectionAccess, decideCollectionAccessRequest, createCycle, mixIntoCycle, unmixFromCycle, startPublishingCycle, saveCycleSchedule, changeCycleStatus]) {
    const error = await errorOf(call(anon, {}));
    assert.equal(error.status, 401); assert.equal(error.code, "not_authenticated");
  }
  assert.equal(repo.audit.length, 0);
});

test("access-request handlers derive requester and decision owner from the authenticated principal", async () => {
  const { repo, ctxFor } = setup();
  repo.collections.set("private-col", { id: "private-col", ownerId: "owner", name: "Secret name", visibility: "private", archived: false, mediaIds: [] });
  const created = await requestCollectionAccess(ctxFor("bob"), { collectionId: "private-col", requestedCapabilities: ["view"], requesterId: "owner", ownerId: "owner" });
  assert.match(created.requestId, /^new/);
  assert.equal(repo.collectionAccessRequests.get(created.requestId)?.requesterId, "bob");
  const deniedDecision = await errorOf(decideCollectionAccessRequest(ctxFor("bob"), { collectionId: "private-col", requestId: created.requestId, decision: "approved", ownerId: "owner", requestedCapabilities: ["manage"] }));
  assert.equal(deniedDecision.status, 404);
  const approved = await decideCollectionAccessRequest(ctxFor("owner"), { collectionId: "private-col", requestId: created.requestId, decision: "approved", ownerId: "bob", requestedCapabilities: ["manage"] });
  assert.equal(approved.status, "approved");
  assert.deepEqual(repo.grants.find((grant) => grant.collectionId === "private-col")?.capabilities, ["view"]);
});

test("errors become safe HTTP results; unknown errors never leak internals", () => {
  const known = toHttpResult(new AppError(404, "not_found", "Nope."));
  assert.deepEqual(known, { status: 404, body: { error: { code: "not_found", message: "Nope." } } });
  const unknown = toHttpResult(new Error("password=hunter2 at db.ts:42"));
  assert.equal(unknown.status, 500); assert.ok(!JSON.stringify(unknown).includes("hunter2"));
});

// ---------- input validation ----------
test("invalid input is rejected with ALL problems listed (422) and nothing is read or written", async () => {
  const { repo, ctxFor } = setup();
  const error = await errorOf(bulkUpdateCaptions(ctxFor("bob"), { cycleId: "../etc/passwd", target: { kind: "selected", itemIds: [] }, caption: 123, expectedVersions: [] }));
  assert.equal(error.status, 422);
  const messages = (error.details as { errors: string[] }).errors.join(" | ");
  for (const part of ["cycleId", "itemIds", "caption", "expectedVersions"]) assert.ok(messages.includes(part), `missing problem about ${part}: ${messages}`);
  assert.equal(repo.audit.length, 0);
});

test("body shape attacks: non-objects, giant lists, oversize text, bad versions", async () => {
  const { ctxFor } = setup();
  for (const body of [null, "x", 5, [], undefined]) assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), body))).status, 422);
  const base = { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption: "ok", expectedVersions: {} };
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, caption: "x".repeat(20_001) }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, target: { kind: "selected", itemIds: Array.from({ length: 501 }, (_, i) => `i${i}`) } }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, expectedVersions: { i1: "1" } }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, expectedVersions: { i1: 0 } }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, overwriteCustomConfirmed: "yes" }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCaptions(ctxFor("bob"), { ...base, target: { kind: "everything" } }))).status, 422);
});

test("a __proto__ key in expectedVersions is plain data and pollutes nothing", () => {
  const problems = new Problems();
  const map = readVersionMap(JSON.parse('{"__proto__": 5, "i1": 2}'), "x", problems, 10);
  assert.equal(Object.getPrototypeOf(map), null);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  const body = JSON.parse('{"expectedVersions": {"__proto__": 5, "i1": 2}}');
  const parsed = readVersionMap(body, "expectedVersions", new Problems(), 10);
  assert.equal(parsed["i1"], 2); assert.equal(Object.keys(parsed).length, 2);
  assert.equal(({} as { polluted?: number }).polluted, undefined);
});

const scheduleInput = (over: Record<string, unknown> = {}) => ({
  cycleId: "cycle1", startDate: "2026-06-02", timeZone: "Asia/Kolkata", intervalMinutes: 60, postsPerInterval: 1,
  daysOfWeek: [0, 1, 2, 3, 4, 5, 6], windowStart: "09:00", windowEnd: "11:00", dailyMax: null, endDate: null, ...over,
});

test("cycle schedule validates settings, assigns timezone-aware times, persists them, and reassigns after edits", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("s1", { position: 1 }), own("s2", { position: 2 }), own("s3", { position: 3 })]);
  const first = await saveCycleSchedule(ctxFor("bob"), scheduleInput());
  assert.deepEqual(first, { scheduled: 3, unscheduled: 0 });
  const initial = await repo.getCycleItems("cycle1");
  assert.equal(initial[0]!.scheduledFor!.toISOString(), "2026-06-02T03:30:00.000Z");
  assert.equal((await repo.getCycle("cycle1"))!.scheduleSettings!.timeZone, "Asia/Kolkata");
  const second = await saveCycleSchedule(ctxFor("bob"), scheduleInput({ intervalMinutes: 120, endDate: "2026-06-02" }));
  assert.deepEqual(second, { scheduled: 2, unscheduled: 1 });
  const rescheduled = await repo.getCycleItems("cycle1");
  assert.deepEqual(rescheduled.map((item) => [item.status, item.scheduledFor?.toISOString() ?? null]), [
    ["scheduled", "2026-06-02T03:30:00.000Z"], ["scheduled", "2026-06-02T05:30:00.000Z"], ["upcoming", null],
  ]);
  const noSlots = await saveCycleSchedule(ctxFor("bob"), scheduleInput({ daysOfWeek: [1], endDate: "2026-06-02" }));
  assert.deepEqual(noSlots, { scheduled: 0, unscheduled: 3 });
  assert.ok((await repo.getCycleItems("cycle1")).every((item) => item.status === "upcoming" && item.scheduledFor === null));
});

test("cycle schedule rejects invalid settings, non-owners and non-draft cycles; empty cycles can save", async () => {
  const { repo, ctxFor } = setup();
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput({ intervalMinutes: 0 })))).status, 422);
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput({ timeZone: "Mars/Base" })))).status, 422);
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput({ daysOfWeek: [] })))).status, 422);
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput({ endDate: "2026-06-01" })))).status, 422);
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("eve"), scheduleInput()))).status, 404);
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "paused" });
  assert.equal((await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput()))).status, 403);
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "draft" });
  assert.deepEqual(await saveCycleSchedule(ctxFor("bob"), scheduleInput()), { scheduled: 0, unscheduled: 0 });
  assert.ok(repo.cycles.get("cycle1")!.scheduleSettings);
});

test("cycle schedule save checks the current plan allowance while preflight remains the start gate", async () => {
  const { repo, ctxFor } = setup({ bob: "free" });
  const limit = getPlan("free").limits.scheduledItemsPerMonth;
  addItems(repo, Array.from({ length: limit + 1 }, (_, index) => own(`over-${index + 1}`, { position: index + 1 })));
  const error = await errorOf(saveCycleSchedule(ctxFor("bob"), scheduleInput()));
  assert.equal(error.code, "plan_limit");
  assert.equal((await repo.getCycleItems("cycle1")).every((item) => item.scheduledFor === null), true);
});

test("cycle controls enforce ownership and valid transitions; stop cancels editable items atomically", async () => {
  const { repo, ctxFor } = setup({ bob: "pro", eve: "pro" });
  addItems(repo, [own("stop1", { status: "scheduled", scheduledFor: new Date(NOW.getTime() + 60_000) }), own("stop2", { status: "publishing" })]);
  assert.equal((await errorOf(changeCycleStatus(ctxFor("eve"), { cycleId: "cycle1", action: "pause" }))).status, 404);
  assert.equal((await errorOf(changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "resume" }))).status, 409);
  assert.equal((await errorOf(changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "stop" }))).status, 422);
  await changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "stop", confirmStop: true });
  assert.equal(repo.cycles.get("cycle1")!.status, "stopped");
  assert.deepEqual([repo.items.get("stop1")!.status, repo.items.get("stop1")!.scheduledFor, repo.items.get("stop1")!.version], ["cancelled", null, 2]);
  assert.equal(repo.items.get("stop2")!.status, "publishing");
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.stopped").length, 1);
  assert.equal((await errorOf(changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "stop", confirmStop: true }))).status, 409);
});

test("pause and resume use compare-and-set transitions and record audit entries", async () => {
  const { repo, ctxFor } = setup();
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "running" });
  await changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "pause" });
  assert.equal(repo.cycles.get("cycle1")!.status, "paused");
  await changeCycleStatus(ctxFor("bob"), { cycleId: "cycle1", action: "resume" });
  assert.equal(repo.cycles.get("cycle1")!.status, "running");
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["cycle.paused", "cycle.resumed"]);
});

// ---------- ownership ----------
test("another user's cycle looks exactly like a missing one (404) and nothing changes", async () => {
  const { repo, ctxFor } = setup({ bob: "pro", eve: "pro" });
  addItems(repo, [own("i1")]);
  const body = { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption: "hijack", overwriteCustomConfirmed: true, expectedVersions: { i1: 1 } };
  const asEve = await errorOf(bulkUpdateCaptions(ctxFor("eve"), body));
  const missing = await errorOf(bulkUpdateCaptions(ctxFor("eve"), { ...body, cycleId: "doesNotExist" }));
  assert.deepEqual([asEve.status, asEve.message.replace("Publishing cycle", "")], [404, missing.message.replace("Publishing cycle", "")]);
  assert.equal(repo.items.get("i1")!.captionText, ""); assert.equal(repo.audit.length, 0); assert.equal(repo.captionRevisions.length, 0);
  for (const [handler, input] of [[unmixFromCycle, { cycleId: "cycle1", itemIds: ["i1"] }], [mixIntoCycle, { cycleId: "cycle1", videos: [{ mediaAssetId: "m", collectionId: "c" }] }], [startPublishingCycle, { cycleId: "cycle1", confirmFinalReview: true }]] as const) {
    assert.equal((await errorOf(handler(ctxFor("eve"), input))).status, 404);
  }
  assert.equal(repo.items.get("i1")!.status, "upcoming");
});

test("a cycle cannot be created on someone else's social account", async () => {
  const { ctxFor } = setup();
  assert.equal((await errorOf(createCycle(ctxFor("bob"), { name: "x", socialAccountId: "acctEve" }))).status, 404);
});

// ---------- captions ----------
test("bulk caption: updates upcoming items, never published ones; saves revisions + audit; reports per item", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("pub", { status: "published", captionText: "old" }), own("a", { position: 2 }), own("b", { position: 3, captionText: "mine", captionSource: "individual" })]);
  const report = await bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption: "New", overwriteCustomConfirmed: false, expectedVersions: versionsOf(repo, ["pub", "a", "b"]) });
  assert.deepEqual(report.summary, { updated: 1, skipped: 0, conflicts: 0, needsConfirmation: 1 });
  assert.equal(repo.items.get("a")!.captionText, "New"); assert.equal(repo.items.get("a")!.version, 2);
  assert.equal(repo.items.get("b")!.captionText, "mine");      // custom caption protected
  assert.equal(repo.items.get("pub")!.captionText, "old"); assert.equal(repo.items.get("pub")!.version, 1);
  assert.equal(repo.captionRevisions.length, 1);
  assert.equal(repo.audit[0]!.action, "caption.bulk_update"); assert.equal(repo.audit[0]!.actorId, "bob");
  assert.ok(!JSON.stringify(repo.audit).includes("New"), "caption text must not be copied into the audit log");
  // Confirming overwrite then replaces it.
  await bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "selected", itemIds: ["b"] }, caption: "New", overwriteCustomConfirmed: true, expectedVersions: versionsOf(repo, ["b"]) });
  assert.equal(repo.items.get("b")!.captionText, "New");
});

test("invalid caption (too long for the platform rules) is a 422 and changes nothing", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a")]);
  const error = await errorOf(bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption: "x".repeat(3000), overwriteCustomConfirmed: false, expectedVersions: { a: 1 } }));
  assert.equal(error.status, 422); assert.equal(repo.items.get("a")!.captionText, ""); assert.equal(repo.captionRevisions.length, 0);
});

// ---------- concurrency ----------
test("RACE: a worker claims an item between load and save -> that item is a conflict, the other still updates, no revision for the loser", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a"), own("b", { position: 2 })]);
  repo.beforeItemSave = () => { repo.beforeItemSave = null; repo.items.set("a", { ...repo.items.get("a")!, status: "publishing", version: 2, lockedBy: "w1" }); };
  const report = await bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption: "Late", overwriteCustomConfirmed: true, expectedVersions: versionsOf(repo, ["a", "b"]) });
  assert.deepEqual(report.summary, { updated: 1, skipped: 0, conflicts: 1, needsConfirmation: 0 });
  assert.equal(repo.items.get("a")!.captionText, ""); assert.equal(repo.items.get("a")!.status, "publishing");
  assert.equal(repo.items.get("b")!.captionText, "Late");
  assert.deepEqual(repo.captionRevisions.map((r) => r.itemId), ["b"]);
  assert.equal(report.results.find((r) => r.itemId === "a")!.outcome, "conflict");
});

test("RACE: two simultaneous bulk updates - exactly one wins every item, never a mix, revisions match reality", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a"), own("b", { position: 2 }), own("c", { position: 3 })]);
  const expectedVersions = versionsOf(repo, ["a", "b", "c"]);
  const call = (caption: string) => bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "all_upcoming" }, caption, overwriteCustomConfirmed: true, expectedVersions });
  const [first, second] = await Promise.all([call("ONE"), call("TWO")]);
  assert.equal(first.summary.updated + second.summary.updated, 3);
  assert.equal(first.summary.conflicts + second.summary.conflicts, 3);
  const captions = new Set(["a", "b", "c"].map((id) => repo.items.get(id)!.captionText));
  assert.equal(captions.size, 1); assert.ok(captions.has("ONE") || captions.has("TWO"));
  assert.equal(repo.captionRevisions.length, 3);
  assert.deepEqual(["a", "b", "c"].map((id) => repo.items.get(id)!.version), [2, 2, 2]);
});

test("RACE: simultaneous cycle starts cannot bypass a blocked publishing preflight", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a", { captionText: "hi", mediaAssetId: "m1" })]);
  repo.media.set("m1", makeMedia({ id: "m1", ownerId: "bob" }));
  const start = () => startPublishingCycle(ctxFor("bob"), { cycleId: "cycle1", confirmFinalReview: true });
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 0);
  for (const rejected of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
    assert.equal((rejected.reason as AppError).status, 409);
    assert.equal((rejected.reason as AppError).code, "preflight_failed");
  }
  assert.equal(repo.cycles.get("cycle1")!.status, "draft");
  assert.equal(repo.audit.filter((a) => a.action === "cycle.started").length, 0);
});

// ---------- covers ----------
test("bulk cover: needs a cover image the user owns; saved internally; platform warning comes from config", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a")]);
  repo.media.set("cover1", makeMedia({ id: "cover1", ownerId: "bob" }));
  repo.media.set("coverEve", makeMedia({ id: "coverEve", ownerId: "eve" }));
  const base = { cycleId: "cycle1", target: { kind: "all_upcoming" }, overwriteCustomConfirmed: false, expectedVersions: { a: 1 } };
  assert.equal((await errorOf(bulkUpdateCovers(ctxFor("bob"), { ...base, coverMediaId: "coverEve" }))).status, 422);
  assert.equal((await errorOf(bulkUpdateCovers(ctxFor("bob"), { ...base, coverMediaId: "missing" }))).status, 422);
  assert.equal(repo.items.get("a")!.coverMediaId, null);
  const unknown = await bulkUpdateCovers(ctxFor("bob", { config: { coverSupport: "unknown" } }), { ...base, coverMediaId: "cover1" });
  assert.equal(unknown.summary.updated, 1); assert.match(unknown.warning ?? "", /could not confirm/);
  assert.equal(repo.items.get("a")!.coverState, "saved_internally");
});

// ---------- sharing ----------
const sharedSetup = (ownerPlan: PlanId = "pro") => {
  const s = setup({ bob: "pro", owner: ownerPlan, carol: "free" });
  s.repo.collections.set("col1", makeCollection());
  return s;
};

test("grants: owner can grant; the grant is stored and audited; strangers get 404; viewers without manage get 403", async () => {
  const { repo, ctxFor } = sharedSetup();
  const body = { collectionId: "col1", granteeId: "carol", capabilities: ["view", "use_in_cycle"] };
  assert.equal((await errorOf(createGrant(ctxFor("eve"), body))).status, 404);   // stranger: collection looks nonexistent
  assert.equal(repo.grants.length, 0);
  repo.grants.push(makeGrant({ granteeId: "bob", capabilities: ["view"] }));
  assert.equal((await errorOf(createGrant(ctxFor("bob"), body))).status, 403);    // can see it, cannot manage it
  await createGrant(ctxFor("owner"), body);
  assert.deepEqual(repo.grants.find((g) => g.granteeId === "carol")!.capabilities, ["view", "use_in_cycle"]);
  assert.equal(repo.grants.find((g) => g.granteeId === "carol")!.grantedById, "owner");
  assert.equal(repo.audit.at(-1)!.action, "sharing.grant_created");
});

test("grant input is validated: unknown permission, bad date, missing ids", async () => {
  const { ctxFor } = sharedSetup();
  assert.equal((await errorOf(createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["root"] }))).status, 422);
  assert.equal((await errorOf(createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"], expiresAt: "next week" }))).status, 422);
  assert.equal((await errorOf(createGrant(ctxFor("owner"), { collectionId: "col1", capabilities: ["view"] }))).status, 422);
  assert.equal((await errorOf(createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "owner", capabilities: ["view"] }))).status, 422); // owner already has access
});

test("plan limits for sharing use the OWNER's plan: Free can't share, Creator can't expire grants, caps are enforced", async () => {
  const free = sharedSetup("free");
  const freeError = await errorOf(createGrant(free.ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"] }));
  assert.deepEqual([freeError.status, freeError.code], [403, "plan_limit"]);

  const creator = sharedSetup("creator");
  const expiring = await errorOf(createGrant(creator.ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"], expiresAt: inDays(3).toISOString() }));
  assert.equal(expiring.code, "plan_limit");
  for (const id of ["u1", "u2", "u3", "u4", "u5"]) await createGrant(creator.ctxFor("owner"), { collectionId: "col1", granteeId: id, capabilities: ["view"] });
  const capped = await errorOf(createGrant(creator.ctxFor("owner"), { collectionId: "col1", granteeId: "u6", capabilities: ["view"] }));
  assert.equal(capped.code, "plan_limit"); assert.match(capped.message, /5 of 5/);
  await createGrant(creator.ctxFor("owner"), { collectionId: "col1", granteeId: "u1", capabilities: ["view", "use_in_cycle"] }); // updating an existing recipient is fine
  assert.equal(creator.repo.grants.length, 5);

  const pro = sharedSetup("pro");
  await createGrant(pro.ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"], expiresAt: inDays(3).toISOString() });
  assert.equal(pro.repo.grants[0]!.expiresAt?.toISOString(), inDays(3).toISOString());
});

test("concurrent sharing grants are serialized at the owner cap and identical retries do not duplicate audits", async () => {
  const { repo, ctxFor } = sharedSetup("creator");
  const requests = Array.from({ length: 8 }, (_, index) => createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: `recipient-${index}`, capabilities: ["view"] }));
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  assert.equal(repo.grants.filter((grant) => grant.status === "active").length, 5);
  assert.equal(repo.audit.filter((entry) => entry.action === "sharing.grant_created").length, 5);
  const created = repo.grants[0]!;
  const auditsBeforeRetry = repo.audit.length;
  await createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: created.granteeId, capabilities: created.capabilities });
  assert.equal(repo.audit.length, auditsBeforeRetry);
  assert.equal(repo.grants.length, 5);
});

test("sharing grant audit failure rolls back the grant and repeated revocation has no duplicate audit", async () => {
  const { repo, ctxFor } = sharedSetup("pro");
  repo.beforeSharingAuditInsert = (entry) => entry.action !== "sharing.grant_created";
  await assert.rejects(() => createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"] }));
  assert.equal(repo.grants.length, 0);
  assert.equal(repo.audit.length, 0);
  repo.beforeSharingAuditInsert = null;
  await createGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"] });
  const beforeFailedRevoke = repo.audit.length;
  repo.beforeSharingAuditInsert = (entry) => entry.action !== "sharing.grant_revoked";
  await assert.rejects(() => revokeGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol" }));
  assert.equal(repo.grants[0]?.status, "active");
  assert.equal(repo.audit.length, beforeFailedRevoke);
  repo.beforeSharingAuditInsert = null;
  await revokeGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol" });
  const auditsAfterRevoke = repo.audit.length;
  assert.equal((await errorOf(revokeGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "carol" }))).status, 404);
  assert.equal(repo.audit.length, auditsAfterRevoke);
  assert.equal(repo.grants[0]?.status, "revoked");
});

test("promotional owner tier is used for collection-sharing policy; recipient tier does not replace owner tier", async () => {
  const ownerPromo = sharedSetup("free");
  grantActivePlan(ownerPromo.repo, "owner", "creator");
  await createGrant(ownerPromo.ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view", "use_in_cycle"] });
  assert.equal(ownerPromo.repo.grants[0]?.granteeId, "carol");

  const recipientPromo = sharedSetup("free");
  grantActivePlan(recipientPromo.repo, "carol", "agency");
  const denied = await errorOf(createGrant(recipientPromo.ctxFor("owner"), { collectionId: "col1", granteeId: "carol", capabilities: ["view"] }));
  assert.equal(denied.code, "plan_limit", "the recipient's promotional plan cannot change collection owner policy");
});

test("promotional Creator limits apply to campaign mixing through the existing catalog", async () => {
  const { repo, ctxFor } = setup({ bob: "free", owner: "pro" });
  grantActivePlan(repo, "bob", "creator");
  const mediaIds = Array.from({ length: 6 }, (_, index) => `promo-media-${index}`);
  mediaIds.forEach((id) => repo.media.set(id, makeMedia({ id, ownerId: "bob" })));
  repo.collections.set("bob-collection", makeCollection({ id: "bob-collection", ownerId: "bob", mediaIds }));
  const added = await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: mediaIds.map((mediaAssetId) => ({ mediaAssetId, collectionId: "bob-collection" })) });
  assert.equal(added.added, 6, "Creator's catalog batch limit is used instead of Free's limit of five");
});

test("delegated manager limits hold through the handler; revoking works and takes effect immediately", async () => {
  const { repo, ctxFor } = sharedSetup("pro");
  repo.grants.push(makeGrant({ granteeId: "mgr", capabilities: ["view", "use_in_cycle", "manage"], grantedById: "owner" }));
  const asMgr = (over: object) => createGrant(ctxFor("mgr"), { collectionId: "col1", granteeId: "dave", capabilities: ["view"], expiresAt: inDays(10).toISOString(), ...over });
  await asMgr({});                                                                      // allowed
  assert.equal((await errorOf(asMgr({ granteeId: "erin", capabilities: ["view", "manage"] }))).status, 403);   // cannot delegate
  assert.equal((await errorOf(asMgr({ granteeId: "erin", expiresAt: undefined }))).status, 403);                // must expire
  assert.equal((await errorOf(asMgr({ granteeId: "erin", expiresAt: inDays(91).toISOString() }))).status, 403); // 90-day max
  assert.equal((await errorOf(asMgr({ granteeId: "erin", capabilities: ["download"] }))).status, 403);          // does not hold download
  assert.equal((await errorOf(revokeGrant(ctxFor("mgr"), { collectionId: "col1", granteeId: "mgr" }))).status, 403);
  const stranger = await errorOf(revokeGrant(ctxFor("eve"), { collectionId: "col1", granteeId: "dave" }));
  assert.equal(stranger.status, 404);
  await revokeGrant(ctxFor("mgr"), { collectionId: "col1", granteeId: "dave" });                       // their own grant
  const collection = repo.collections.get("col1")!;
  assert.equal(getCollectionCapabilities("dave", collection, repo.grants, NOW).size, 0);
  assert.equal((await errorOf(revokeGrant(ctxFor("owner"), { collectionId: "col1", granteeId: "dave" }))).status, 404); // already revoked
});

// ---------- cycles: plan limits, mix/unmix, start ----------
test("creating a cycle enforces the active-campaign limit of the plan (Free: 1)", async () => {
  const { repo, ctxFor } = setup({ bob: "free" });
  repo.cycles.clear();
  await createCycle(ctxFor("bob"), { name: "First", socialAccountId: "acct1" });
  const error = await errorOf(createCycle(ctxFor("bob"), { name: "Second", socialAccountId: "acct1" }));
  assert.deepEqual([error.status, error.code], [403, "plan_limit"]);
  assert.equal(repo.cycles.size, 1);
  assert.equal((await errorOf(createCycle(ctxFor("bob"), { name: "", socialAccountId: "acct1" }))).status, 422);
});

const mixSetup = (bobPlan: PlanId = "creator") => {
  const s = setup({ bob: bobPlan, owner: "pro" });
  s.repo.media.set("own1", makeMedia({ id: "own1", ownerId: "bob" }));
  s.repo.collections.set("mine", makeCollection({ id: "mine", ownerId: "bob", mediaIds: ["own1"] }));
  s.repo.media.set("shared1", makeMedia({ id: "shared1", ownerId: "owner" }));
  s.repo.collections.set("col1", makeCollection({ id: "col1", ownerId: "owner", mediaIds: ["shared1"] }));
  return s;
};

test("mix: Creator may mix owned + shared (with permission); source kinds and owners are recorded server-side", async () => {
  const { repo, ctxFor } = mixSetup("creator");
  repo.grants.push(makeGrant({ granteeId: "bob" }));
  const result = await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "own1", collectionId: "mine" }, { mediaAssetId: "shared1", collectionId: "col1" }] });
  assert.equal(result.added, 2); assert.deepEqual(result.rejected, []);
  const items = [...repo.items.values()];
  assert.deepEqual(items.map((i) => i.sourceKind).sort(), ["owned", "shared_reference"]);
  assert.ok(items.every((i) => i.cycleOwnerId === "bob" && i.status === "upcoming" && i.version === 1));
});

test("cycle import snapshots effective collection caption and cover settings; cycle overrides stay isolated", async () => {
  const { repo, ctxFor } = mixSetup("pro");
  repo.media.set("own2", makeMedia({ id: "own2", ownerId: "bob" }));
  repo.media.set("coverA", makeMedia({ id: "coverA", ownerId: "bob", kind: "image" }));
  repo.media.set("coverB", makeMedia({ id: "coverB", ownerId: "bob", kind: "image" }));
  repo.collections.set("mine", makeCollection({ id: "mine", ownerId: "bob", mediaIds: ["own1", "own2"], items: [
    { mediaAssetId: "own1", captionText: "Individual A", coverMediaId: "coverA", version: 1 },
    { mediaAssetId: "own2", captionText: "Individual B", coverMediaId: "coverB", version: 1 },
  ] }));
  const result = await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "own1", collectionId: "mine" }, { mediaAssetId: "own2", collectionId: "mine" }] });
  assert.equal(result.added, 2);
  const cycleItems = [...repo.items.values()].sort((a, b) => a.position - b.position);
  assert.deepEqual(cycleItems.map((item) => [item.captionText, item.coverMediaId]), [["Individual A", "coverA"], ["Individual B", "coverB"]]);
  const collectionBeforeOverride = await repo.getCollection("mine");
  const target = cycleItems[0]!;
  await bulkUpdateCaptions(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "selected", itemIds: [target.id] }, caption: "Cycle-only copy", overwriteCustomConfirmed: true, expectedVersions: { [target.id]: target.version } });
  const latest = repo.items.get(target.id)!;
  await bulkUpdateCovers(ctxFor("bob"), { cycleId: "cycle1", target: { kind: "selected", itemIds: [target.id] }, coverMediaId: "coverB", overwriteCustomConfirmed: true, expectedVersions: { [target.id]: latest.version } });
  assert.deepEqual((await repo.getCollection("mine"))?.items?.map((item) => [item.captionText, item.coverMediaId]), collectionBeforeOverride?.items?.map((item) => [item.captionText, item.coverMediaId]));
  assert.equal(repo.items.get(target.id)?.captionText, "Cycle-only copy");
  assert.equal(repo.items.get(target.id)?.coverMediaId, "coverB");
});

test("cycle import resolves shared collection defaults without replacing individual saved settings", async () => {
  const { repo, ctxFor } = mixSetup("pro");
  repo.media.set("own2", makeMedia({ id: "own2", ownerId: "bob" }));
  repo.media.set("coverA", makeMedia({ id: "coverA", ownerId: "bob", kind: "image" }));
  repo.collections.set("mine", makeCollection({ id: "mine", ownerId: "bob", mediaIds: ["own1", "own2"], captionMode: "shared", sharedCaptionText: "Shared caption", coverMode: "shared", sharedCoverMediaId: "coverA", items: [
    { mediaAssetId: "own1", captionText: "Preserved individual A", coverMediaId: null, version: 1 },
    { mediaAssetId: "own2", captionText: "Preserved individual B", coverMediaId: null, version: 1 },
  ] }));
  assert.equal((await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "own1", collectionId: "mine" }, { mediaAssetId: "own2", collectionId: "mine" }] })).added, 2);
  const items = [...repo.items.values()].sort((a, b) => a.position - b.position);
  assert.deepEqual(items.map((item) => [item.captionText, item.captionSource, item.coverMediaId]), [
    ["Shared caption", "bulk", "coverA"], ["Shared caption", "bulk", "coverA"],
  ]);
  assert.deepEqual(repo.collections.get("mine")?.items?.map((item) => [item.captionText, item.coverMediaId]), [["Preserved individual A", null], ["Preserved individual B", null]]);
});

test("cycle import rejects a collection-settings race before inserting stale snapshots", async () => {
  const { repo, ctxFor } = mixSetup("pro");
  const current = repo.collections.get("mine")!;
  repo.collections.set("mine", { ...current, settingsVersion: 4 });
  const addCycleItems = repo.addCycleItems.bind(repo);
  repo.addCycleItems = async (items, expectedVersions) => {
    const latest = repo.collections.get("mine")!;
    repo.collections.set("mine", { ...latest, settingsVersion: 5 });
    return addCycleItems(items, expectedVersions);
  };
  const error = await errorOf(mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "own1", collectionId: "mine" }] }));
  assert.equal(error.status, 409);
  assert.equal(repo.items.size, 0, "no cycle item is inserted from the stale settings snapshot");
});

test("mix: Free plan cannot use shared videos; no permission = rejected without revealing why; unknown ids look the same", async () => {
  const free = mixSetup("free");
  free.repo.grants.push(makeGrant({ granteeId: "bob" }));
  const freeResult = await mixIntoCycle(free.ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "shared1", collectionId: "col1" }] });
  assert.equal(freeResult.added, 0); assert.match(freeResult.rejected[0]!.reason, /plan/i);

  const { repo, ctxFor } = mixSetup("pro"); // no grant for bob
  const result = await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "shared1", collectionId: "col1" }, { mediaAssetId: "ghost", collectionId: "col1" }, { mediaAssetId: "own1", collectionId: "ghostCol" }] });
  assert.equal(result.added, 0); assert.equal(repo.items.size, 0);
  assert.equal(result.rejected.find((r) => r.mediaAssetId === "ghost")!.reason, result.rejected.find((r) => r.mediaAssetId === "own1")!.reason);
});

test("mix: public-view collections do not let strangers use videos; revoked grants stop working", async () => {
  const { repo, ctxFor } = mixSetup("pro");
  repo.collections.set("col1", makeCollection({ id: "col1", ownerId: "owner", mediaIds: ["shared1"], visibility: "public_view" }));
  assert.equal((await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "shared1", collectionId: "col1" }] })).added, 0);
  repo.grants.push(makeGrant({ granteeId: "bob", status: "revoked" }));
  assert.equal((await mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "shared1", collectionId: "col1" }] })).added, 0);
});

test("mix: plan batch size is enforced (Free: 5), duplicates need confirmation, ended cycles refuse", async () => {
  const free = mixSetup("free");
  const six = Array.from({ length: 6 }, () => ({ mediaAssetId: "own1", collectionId: "mine" }));
  const error = await errorOf(mixIntoCycle(free.ctxFor("bob"), { cycleId: "cycle1", videos: six }));
  assert.deepEqual([error.status, error.code], [403, "plan_limit"]);

  const { repo, ctxFor } = mixSetup("pro");
  const one = { cycleId: "cycle1", videos: [{ mediaAssetId: "own1", collectionId: "mine" }] };
  assert.equal((await mixIntoCycle(ctxFor("bob"), one)).added, 1);
  assert.equal((await mixIntoCycle(ctxFor("bob"), one)).added, 0);                                   // duplicate
  assert.equal((await mixIntoCycle(ctxFor("bob"), { ...one, confirmedDuplicateMediaIds: ["own1"] })).added, 1);
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "stopped" });
  assert.equal((await errorOf(mixIntoCycle(ctxFor("bob"), one))).status, 403);
  assert.equal((await errorOf(mixIntoCycle(ctxFor("bob"), { cycleId: "cycle1", videos: [{ mediaAssetId: "own1" }] }))).status, 422);
});

test("unmix: cancels upcoming items, keeps published history, reports in-flight and raced items honestly", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("up"), own("pub", { status: "published" }), own("busy", { status: "publishing", lockedBy: "w" }), own("raced")]);
  repo.beforeItemSave = () => { repo.beforeItemSave = null; repo.items.set("raced", { ...repo.items.get("raced")!, status: "publishing", version: 2, lockedBy: "w2" }); };
  const result = await unmixFromCycle(ctxFor("bob"), { cycleId: "cycle1", itemIds: ["up", "pub", "busy", "raced"] });
  assert.deepEqual(result.removedItemIds, ["up"]);
  assert.deepEqual(result.blocked.map((b) => b.itemId).sort(), ["busy", "pub", "raced"]);
  assert.equal(repo.items.get("up")!.status, "cancelled"); assert.equal(repo.items.get("pub")!.status, "published");
  assert.equal(repo.items.get("raced")!.status, "publishing"); // the worker's claim was not overwritten
  assert.equal(repo.items.size, 4);                             // nothing deleted
});

test("start: preflight failures return 409 with the full report and leave the cycle in draft", async () => {
  const { repo, ctxFor } = setup();
  addItems(repo, [own("a", { mediaAssetId: "m1", captionText: "hi" })]);
  repo.media.set("m1", makeMedia({ id: "m1", ownerId: "bob" }));
  const noConfirm = await errorOf(startPublishingCycle(ctxFor("bob"), { cycleId: "cycle1", confirmFinalReview: false }));
  assert.deepEqual([noConfirm.status, noConfirm.code], [409, "preflight_failed"]);
  assert.ok((noConfirm.details as { report: { checks: { id: string }[] } }).report.checks.some((c) => c.id === "final_review"));
  repo.socialAccounts.set("acct1", { id: "acct1", userId: "bob", status: "token_expired" });
  assert.equal((await errorOf(startPublishingCycle(ctxFor("bob"), { cycleId: "cycle1", confirmFinalReview: true }))).status, 409);
  assert.equal(repo.cycles.get("cycle1")!.status, "draft");
  assert.equal(repo.audit.some((a) => a.action === "cycle.started"), false);
});

test("publishing preflight: a shared video's revoked permission blocks it", async () => {
  const { repo, ctxFor } = setup();
  repo.media.set("shared1", makeMedia({ id: "shared1", ownerId: "owner" }));
  repo.collections.set("col1", makeCollection({ mediaIds: ["shared1"] }));
  addItems(repo, [makeItem({ id: "s", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "shared1", sourceKind: "shared_reference", sourceCollectionId: "col1", captionText: "hi" })]);
  repo.grants.push(makeGrant({ granteeId: "bob" }));
  repo.grants[0] = { ...repo.grants[0]!, status: "revoked" };
  const report = await buildPreflightReport(ctxFor("bob"), "bob", repo.cycles.get("cycle1")!, await repo.getCycleItems("cycle1"), true);
  assert.equal(report.checks.find((c) => c.id === "source_access")!.level, "blocked");
});

test("publishing preflight reads promotional scheduling limits from the central plan resolver", async () => {
  const { repo, ctxFor } = setup({ bob: "free", owner: "pro" });
  const item = own("scheduled-item", { scheduledFor: inDays(1) });
  repo.media.set(item.mediaAssetId, makeMedia({ id: item.mediaAssetId, ownerId: "bob" }));
  repo.setUsage("bob", monthStartUtc(NOW), { processingSeconds: 0, exports: 0, scheduledItems: 10 });
  const cycle = { ...repo.cycles.get("cycle1")!, finalReviewConfirmed: true };
  const freeReport = await buildPreflightReport(ctxFor("bob"), "bob", cycle, [item], true);
  assert.ok(freeReport.checks.some((check) => check.id === "plan_limit"));
  grantActivePlan(repo, "bob", "creator");
  const promoReport = await buildPreflightReport(ctxFor("bob"), "bob", cycle, [item], true);
  assert.equal(promoReport.checks.some((check) => check.id === "plan_limit"), false);
});

test("start: plan allowance and Instagram's documented 24h quota are enforced on the server", async () => {
  const { repo, ctxFor } = setup({ bob: "free" });
  repo.media.set("m1", makeMedia({ id: "m1", ownerId: "bob" }));
  addItems(repo, Array.from({ length: 3 }, (_, i) => own(`i${i}`, { mediaAssetId: "m1", captionText: "x", position: i + 1 })));
  repo.setUsage("bob", monthStartUtc(NOW), { processingSeconds: 0, exports: 0, scheduledItems: 9 }); // Free allows 10 scheduled items per month; 3 more would be 12
  const error = await errorOf(startPublishingCycle(ctxFor("bob"), { cycleId: "cycle1", confirmFinalReview: true }));
  assert.ok((error.details as { report: { checks: { id: string }[] } }).report.checks.some((c) => c.id === "plan_limit"));
});
