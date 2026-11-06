// Forms: rendered HTML -> form routes -> the same tested handlers -> redirect with a whitelisted flash message.
// Proves wiring in plain Node. It does NOT prove a browser submits these forms (no browser/Next.js here).
import { test, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { DEMO_CYCLE_ID, DEMO_USER_ID, seedDemoData } from "../src/server/demo-data.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import type { MediaServices } from "../src/server/context.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { detectProbe } from "../src/server/storage/media-inspection.ts";
import { buildFlashLocation, parseFlash, FLASH_NOTICES, FLASH_ERRORS } from "../src/server/flash.ts";
import { captionsForm, coversForm, createCycleForm, mixForm, startCycleForm, unmixForm } from "../src/server/form-handlers.ts";
import { uploadRoute } from "../src/server/upload-route.ts";
import MediaPage from "../app/(app)/media/page.tsx";
import CyclesPage from "../app/(app)/cycles/page.tsx";
import CyclePage from "../app/(app)/cycles/[cycleId]/page.tsx";
import CollectionPage from "../app/(app)/collections/[collectionId]/page.tsx";
import { ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media-fixtures.ts";
import { NOW } from "./helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const ffprobeInstalled = spawnSync("ffprobe", ["-version"]).status === 0;
let fixtures: Fixtures; let repo: MemoryRepository; let counter = 0; const tmp: string[] = [];
before(() => { if (ffmpegAvailable) fixtures = makeFixtures(); });
after(() => { fixtures?.cleanup(); tmp.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function runtime(userId: string | null, media?: MediaServices): Runtime {
  return { mode: "demo", repo, currentUserId: async () => userId, newId: () => `f${++counter}`, now: () => NOW, ...(media ? { media: async () => media } : {}) };
}
const mediaServices = async (opts: { disk?: boolean; probe?: "real" | null; max?: number } = {}): Promise<MediaServices> => {
  let storage;
  if (opts.disk) { const dir = mkdtempSync(join(tmpdir(), "clipforge-forms-")); tmp.push(dir); storage = await LocalDiskMediaStorage.create(dir); } else storage = new MemoryMediaStorage();
  return { storage, probe: opts.probe === null ? null : await detectProbe(), maxUploadBytes: opts.max ?? 5 * 1024 * 1024 };
};
beforeEach(() => { repo = new MemoryRepository(); seedDemoData(repo, NOW); setRuntimeForTests(runtime(DEMO_USER_ID)); });
afterEach(() => setRuntimeForTests(null));

const formPost = (path: string, fields: [string, string][], headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const location = (r: Response) => r.headers.get("location") ?? "";
const versionsOfCycle = () => [...repo.items.values()].filter((i) => i.cycleId === DEMO_CYCLE_ID).map((i): [string, string] => [`version.${i.id}`, String(i.version)]);

// ---------- flash ----------
test("flash: only whitelisted codes produce text; crafted links cannot inject content; counts are digits only", () => {
  assert.equal(parseFlash({ notice: "upload_ok" })?.message, FLASH_NOTICES.upload_ok);
  assert.equal(parseFlash({ error: "plan_limit" })?.kind, "error");
  for (const bad of [{ notice: "<script>alert(1)</script>" }, { error: "toString" }, { notice: "__proto__" }, { error: "constructor" }, { notice: ["upload_ok"] }, {}, undefined]) assert.equal(parseFlash(bad as never), null, JSON.stringify(bad));
  const counted = parseFlash({ notice: "captions_applied", updated: "3", skipped: "1", conflicts: "<b>9</b>", confirm: "99999" });
  assert.match(counted!.message, /3 updated, 1 skipped\)$/); assert.ok(!counted!.message.includes("<b>"));
  assert.ok(Object.keys(FLASH_NOTICES).length > 5 && Object.keys(FLASH_ERRORS).length > 10);
});

test("redirect locations: only plain internal paths; unknown codes can never be smuggled in", () => {
  assert.equal(buildFlashLocation("/cycles/abc", "notice", "cycle_created"), "/cycles/abc?notice=cycle_created");
  assert.equal(buildFlashLocation("/media", "error", "not-a-code"), "/media?error=error");
  assert.equal(buildFlashLocation("/x", "error", "conflict", { updated: 2, skipped: -1, conflicts: 1.5, blocked: 99999 }), "/x?error=conflict&updated=2");
  for (const path of ["//evil.example", "https://evil.example", "/a?b=c", "/a\nSet-Cookie: x", "", "/a b", "/../x%00"]) assert.throws(() => buildFlashLocation(path, "notice", "cycle_created"), JSON.stringify(path));
  assert.throws(() => buildFlashLocation("/x", "notice", "evil"));
});

// ---------- form routes ----------
test("create cycle form: success redirects to the new cycle; plan limit and bad input redirect back with a safe error", async () => {
  const ok = await createCycleForm(formPost("/api/forms/cycle-create", [["name", "From form"], ["socialAccountId", "demo-account"]]));
  assert.equal(ok.status, 303); assert.match(location(ok), /^\/cycles\/f\d+\?notice=cycle_created$/);
  assert.equal([...repo.cycles.values()].some((c) => c.name === "From form"), true);
  const bad = await createCycleForm(formPost("/api/forms/cycle-create", [["name", ""], ["socialAccountId", "../x"]]));
  assert.equal(location(bad), "/cycles?error=validation_failed");
  repo.plans.set(DEMO_USER_ID, "free"); // Free allows 1 active cycle and the demo user already has one
  assert.equal(location(await createCycleForm(formPost("/api/forms/cycle-create", [["name", "Second"], ["socialAccountId", "demo-account"]]))), "/cycles?error=plan_limit");
});

test("caption form: ticked videos only; custom captions protected until confirmed; published untouched; counts reported", async () => {
  const base: [string, string][] = [["cycleId", DEMO_CYCLE_ID], ["scope", "selected"], ["caption", "Hello from the form"], ...versionsOfCycle()];
  const r = await captionsForm(formPost("/api/forms/captions", [...base, ["itemIds", "demo-item-3"]]));
  assert.equal(location(r), `/cycles/${DEMO_CYCLE_ID}?notice=captions_applied&updated=1&skipped=0&conflicts=0&confirm=0`);
  assert.equal(repo.items.get("demo-item-3")!.captionText, "Hello from the form"); assert.equal(repo.items.get("demo-item-1")!.captionText, "Sample caption one");
  // item-1 has no "individual" caption source in seed (source none), so use item with individual: set one
  repo.items.set("demo-item-2", { ...repo.items.get("demo-item-2")!, captionSource: "individual" });
  const all = await captionsForm(formPost("/api/forms/captions", [["cycleId", DEMO_CYCLE_ID], ["scope", "all"], ["caption", "For everyone"], ...versionsOfCycle()]));
  assert.match(location(all), /updated=3&skipped=0&conflicts=0&confirm=1$/); assert.equal(repo.items.get("demo-item-2")!.captionText, "Sample caption two");
  const confirmed = await captionsForm(formPost("/api/forms/captions", [["cycleId", DEMO_CYCLE_ID], ["scope", "all"], ["caption", "For everyone!"], ["overwriteCustomConfirmed", "yes"], ...versionsOfCycle()]));
  assert.match(location(confirmed), /updated=4/); assert.equal(repo.items.get("demo-item-2")!.captionText, "For everyone!");
});

test("caption form: stale versions are conflicts (not overwritten); a __proto__ field pollutes nothing", async () => {
  const stale = versionsOfCycle().map(([n]): [string, string] => [n, "99"]);
  const r = await captionsForm(formPost("/api/forms/captions", [["cycleId", DEMO_CYCLE_ID], ["scope", "all"], ["caption", "Nope"], ...stale, ["version.__proto__", "5"]]));
  assert.match(location(r), /updated=0&skipped=0&conflicts=4/); assert.equal(repo.items.get("demo-item-3")!.captionText, "");
  assert.equal(({} as { polluted?: number }).polluted, undefined);
});

test("cover form: saves an owned image as 'saved in ClipForge' only; a video or someone else's file is refused", async () => {
  const r = await coversForm(formPost("/api/forms/covers", [["cycleId", DEMO_CYCLE_ID], ["scope", "selected"], ["itemIds", "demo-item-3"], ["coverMediaId", "demo-media-29"], ...versionsOfCycle()]));
  assert.match(location(r), /notice=covers_applied&updated=1/);
  assert.deepEqual([repo.items.get("demo-item-3")!.coverMediaId, repo.items.get("demo-item-3")!.coverState], ["demo-media-29", "saved_internally"]);
  const theirs = await coversForm(formPost("/api/forms/covers", [["cycleId", DEMO_CYCLE_ID], ["scope", "all"], ["coverMediaId", "demo-shared-1"], ...versionsOfCycle()]));
  assert.equal(location(theirs), `/cycles/${DEMO_CYCLE_ID}?error=validation_failed`);
});

test("unmix + mix forms: remove keeps history; mixing uses shared videos in place and rejects the view-only one", async () => {
  const removed = await unmixForm(formPost("/api/forms/cycle-unmix", [["cycleId", DEMO_CYCLE_ID], ["itemIds", "demo-item-3"]]));
  assert.match(location(removed), /notice=videos_removed&removed=1&blocked=0/); assert.equal(repo.items.get("demo-item-3")!.status, "cancelled");
  assert.equal(repo.items.size, 4);
  const mixed = await mixForm(formPost("/api/forms/cycle-mix", [["cycleId", DEMO_CYCLE_ID], ["collectionId", "demo-shared-col-1"], ["video", "demo-shared-col-1|demo-shared-2"], ["video", "demo-shared-col-2|demo-shared-3"]]));
  assert.match(location(mixed), /notice=videos_added&added=1&rejected=1/);
  const added = [...repo.items.values()].find((i) => i.mediaAssetId === "demo-shared-2")!;
  assert.deepEqual([added.sourceKind, added.cycleOwnerId], ["shared_reference", DEMO_USER_ID]);
  assert.equal([...repo.media.values()].filter((m) => m.ownerId === DEMO_USER_ID).length, 30); // no copy was made
  const broken = await mixForm(formPost("/api/forms/cycle-mix", [["cycleId", DEMO_CYCLE_ID], ["collectionId", "demo-shared-col-1"], ["video", "garbage-without-separator"]]));
  assert.equal(location(broken), "/collections/demo-shared-col-1?error=validation_failed");
});

test("start form: needs the confirmation; first start wins, a repeat is a conflict; nothing is published", async () => {
  assert.equal(location(await startCycleForm(formPost("/api/forms/cycle-start", [["cycleId", DEMO_CYCLE_ID]]))), `/cycles/${DEMO_CYCLE_ID}?error=preflight_failed`);
  assert.equal(repo.cycles.get(DEMO_CYCLE_ID)!.status, "draft");
  assert.equal(location(await startCycleForm(formPost("/api/forms/cycle-start", [["cycleId", DEMO_CYCLE_ID], ["confirmFinalReview", "yes"]]))), `/cycles/${DEMO_CYCLE_ID}?notice=cycle_started`);
  assert.equal(repo.cycles.get(DEMO_CYCLE_ID)!.status, "running");
  assert.equal(location(await startCycleForm(formPost("/api/forms/cycle-start", [["cycleId", DEMO_CYCLE_ID], ["confirmFinalReview", "yes"]]))), `/cycles/${DEMO_CYCLE_ID}?error=conflict`);
  assert.ok([...repo.items.values()].every((i) => i.status !== "published"));
});

test("form route protections: cross-site refused, wrong content type, not signed in, someone else's cycle, oversized body", async () => {
  const fields: [string, string][] = [["cycleId", DEMO_CYCLE_ID], ["scope", "all"], ["caption", "x"], ...versionsOfCycle()];
  assert.equal((await captionsForm(formPost("/api/forms/captions", fields, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await captionsForm(formPost("/api/forms/captions", fields, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal(location(await captionsForm(formPost("/api/forms/captions", fields, { "content-type": "application/json" }))), `/cycles?error=unsupported_media_type`);
  assert.equal(location(await captionsForm(formPost("/api/forms/captions", fields, { "content-length": "99999999" }))), `/cycles?error=payload_too_large`);
  setRuntimeForTests(runtime(null));
  assert.equal(location(await captionsForm(formPost("/api/forms/captions", fields))), `/cycles/${DEMO_CYCLE_ID}?error=not_authenticated`);
  setRuntimeForTests(runtime("eve"));
  assert.equal(location(await captionsForm(formPost("/api/forms/captions", fields))), `/cycles/${DEMO_CYCLE_ID}?error=not_found`);
  assert.equal(repo.items.get("demo-item-3")!.captionText, "");
  // A hostile cycleId can never become a redirect target.
  assert.equal(location(await captionsForm(formPost("/api/forms/captions", [["cycleId", "//evil.example"], ["scope", "all"], ["caption", "x"]]))), "/cycles?error=not_found".replace("not_found", "validation_failed"));
});

// ---------- upload route ----------
async function multipart(bytes: Uint8Array | string, filename: string, type: string, opts: { fieldName?: string; accept?: string; length?: string | null; headers?: Record<string, string> } = {}) {
  const form = new FormData();
  if (typeof bytes === "string") form.set(opts.fieldName ?? "file", bytes);
  else {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.set(opts.fieldName ?? "file", new File([copy], filename, { type }));
  }
  const packed = new Response(form);
  const body = new Uint8Array(await packed.arrayBuffer());
  const headers: Record<string, string> = { host: "localhost:3000", "content-type": packed.headers.get("content-type")!, ...(opts.accept ? { accept: opts.accept } : {}), ...opts.headers };
  if (opts.length !== null) headers["content-length"] = opts.length ?? String(body.length);
  return new Request("http://localhost:3000/api/forms/media-upload", { method: "POST", headers, body });
}
const needReal = { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffmpeg/ffprobe not installed" : false };

test("UPLOAD ROUTE (browser form): a real file is verified, stored, recorded; user is redirected with 'upload complete'", needReal, async () => {
  const media = await mediaServices(); setRuntimeForTests(runtime(DEMO_USER_ID, media));
  const response = await uploadRoute()(await multipart(fixtures.mp4, "My Video.mp4", "video/mp4", { accept: "text/html,application/xhtml+xml" }));
  assert.equal(response.status, 303); assert.equal(location(response), "/media?notice=upload_ok");
  const saved = [...repo.media.values()].find((m) => m.title === "My Video.mp4")!;
  assert.deepEqual([saved.ownerId, saved.validation, saved.kind], [DEMO_USER_ID, "verified", "video"]);
  assert.equal((media.storage as MemoryMediaStorage).objects.size, 1);
});

test("UPLOAD ROUTE (API caller): JSON result without any path or storage key", needReal, async () => {
  setRuntimeForTests(runtime(DEMO_USER_ID, await mediaServices({ disk: true })));
  const response = await uploadRoute()(await multipart(fixtures.png, "c.png", "image/png"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual([body["kind"], body["validation"], body["storage"]], ["image", "verified", "local-disk"]);
  assert.ok(!/clipforge-forms|media\/|staging|storageKey/.test(JSON.stringify(body)));
});

test("UPLOAD ROUTE: no ffprobe -> redirect says the check was incomplete (never 'upload complete')", needReal, async () => {
  setRuntimeForTests(runtime(DEMO_USER_ID, await mediaServices({ probe: null })));
  const response = await uploadRoute()(await multipart(fixtures.png, "c.png", "image/png", { accept: "text/html" }));
  assert.equal(location(response), "/media?notice=upload_incomplete");
  assert.equal([...repo.media.values()].find((m) => m.title === "c.png")!.validation, "incomplete");
});

test("UPLOAD ROUTE protections: oversized, no length, wrong content type, no file, text field, bad media, cross-site, signed out", needReal, async () => {
  const media = await mediaServices({ max: 2000 }); setRuntimeForTests(runtime(DEMO_USER_ID, media));
  const route = uploadRoute(); const asHtml = { accept: "text/html" };
  const code = async (req: Promise<Request>) => { const r = await route(await req); return r.status === 303 ? location(r) : r.status; };
  assert.equal(await code(multipart(fixtures.mp4, "big.mp4", "video/mp4", asHtml)), "/media?error=file_too_large");                       // declared length over the cap
  assert.equal(await code(multipart(fixtures.png, "a.png", "image/png", { ...asHtml, length: null })), "/media?error=length_required");  // no Content-Length
  assert.equal(await code(multipart(fixtures.png, "a.png", "image/png", { ...asHtml, headers: { "content-type": "text/plain" } })), "/media?error=unsupported_media_type");
  assert.equal(await code(multipart("just text", "", "", { ...asHtml })), "/media?error=validation_failed");                              // field is not a file
  assert.equal(await code(multipart(fixtures.png, "a.png", "image/png", { ...asHtml, fieldName: "other" })), "/media?error=validation_failed");
  assert.equal(await code(multipart(new TextEncoder().encode("<html>not media at all</html>"), "x.mp4", "video/mp4", asHtml)), "/media?error=unsupported_media_type");
  assert.equal(await code(multipart(fixtures.png, "a.png", "image/png", { ...asHtml, headers: { origin: "https://evil.example" } })), 403);
  setRuntimeForTests(runtime(null, media));
  assert.equal(await code(multipart(fixtures.png, "a.png", "image/png", asHtml)), "/media?error=not_authenticated");
  assert.equal([...repo.media.values()].filter((m) => !m.id.startsWith("demo-")).length, 0);
  assert.equal((media.storage as MemoryMediaStorage).objects.size + (media.storage as MemoryMediaStorage).staged.size, 0);
  // API callers get JSON status codes instead of redirects.
  setRuntimeForTests(runtime(DEMO_USER_ID, media));
  assert.equal((await route(await multipart(fixtures.mp4, "big.mp4", "video/mp4"))).status, 413);
  assert.equal((await route(await multipart(fixtures.png, "a.png", "image/png", { length: null }))).status, 411);
});

test("UPLOAD ROUTE: a body that DECLARES it is too large is refused without reading (buffering) it at all", needReal, async () => {
  setRuntimeForTests(runtime(DEMO_USER_ID, await mediaServices({ max: 2000 })));
  const request = await multipart(fixtures.png, "a.png", "image/png", { accept: "text/html", length: String(50 * 1024 * 1024) });
  let bodyWasRead = false;
  request.formData = async () => { bodyWasRead = true; throw new Error("body must not be read"); };
  assert.equal(location(await uploadRoute()(request)), "/media?error=file_too_large");
  assert.equal(bodyWasRead, false);
});

// ---------- pages ----------
test("media page: says where files go (memory vs local disk vs none), shows flash, and marks incomplete checks", async () => {
  setRuntimeForTests(runtime(DEMO_USER_ID, await mediaServices()));
  const memory = html(await MediaPage({}));
  assert.ok(memory.includes("Demo storage (server memory)")); assert.ok(memory.includes("discarded when the server restarts")); assert.ok(memory.includes('data-storage-kind="memory"'));
  assert.ok(memory.includes('enctype="multipart/form-data"') || memory.includes('encType="multipart/form-data"')); assert.ok(memory.includes('action="/api/forms/media-upload"')); assert.ok(memory.includes("Cloud (S3) storage is not connected"));
  assert.ok(memory.includes("up to 5 MB per file"));
  setRuntimeForTests(runtime(DEMO_USER_ID, await mediaServices({ disk: true })));
  const disk = html(await MediaPage({}));
  assert.ok(disk.includes("Private folder on this computer")); assert.ok(disk.includes("not stored in the database")); assert.ok(!disk.includes("discarded when the server restarts"));
  setRuntimeForTests(runtime(DEMO_USER_ID));
  const none = html(await MediaPage({}));
  assert.ok(none.includes("Uploads are not available")); assert.ok(!none.includes('action="/api/forms/media-upload"'));
  repo.media.set("demo-media-1", { ...repo.media.get("demo-media-1")!, validation: "incomplete" });
  assert.ok(html(await MediaPage({})).includes("Not fully checked"));
  const flash = html(await MediaPage({ searchParams: { notice: "upload_ok" } })); assert.ok(flash.includes('data-flash="notice"')); assert.ok(flash.includes("Upload complete"));
  const evil = html(await MediaPage({ searchParams: { error: "<script>alert(1)</script>" } })); assert.ok(!evil.includes("<script>")); assert.ok(!evil.includes("data-flash"));
});

test("cycles page: create form lists only your connected accounts (no external ids); explains when there are none", async () => {
  const withAccount = html(await CyclesPage());
  assert.ok(withAccount.includes('action="/api/forms/cycle-create"')); assert.ok(withAccount.includes("Connected account 1")); assert.ok(!withAccount.includes(">demo-account<")); // the internal id is only the option value, never visible text
  repo.socialAccounts.set("demo-account", { id: "demo-account", userId: DEMO_USER_ID, status: "token_expired" });
  assert.ok(html(await CyclesPage()).includes("Live publishing is not configured"));
});

test("cycle page: one form wraps the table and all actions; versions only for editable items; covers are images only; start needs readiness", async () => {
  const page = html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } }));
  const formHtml = page.slice(page.indexOf('<form id="cycle-items-form"'), page.indexOf("</form>", page.indexOf('<form id="cycle-items-form"')));
  for (const part of ['name="cycleId"', "<table", 'name="itemIds"', "<textarea", 'name="scope"', "Apply caption", "Save cover", "Remove ticked videos"]) assert.ok(formHtml.includes(part), part);
  assert.ok(/formAction="\/api\/forms\/covers"/i.test(formHtml)); assert.ok(/formAction="\/api\/forms\/cycle-unmix"/i.test(formHtml)); assert.ok(/formAction="\/api\/forms\/captions"/i.test(formHtml));
  assert.equal((formHtml.match(/name="version\./g) ?? []).length, 4);
  assert.ok(formHtml.includes("Sample cover image 29")); assert.ok(!formHtml.includes("<option value=\"demo-media-1\">"));
  assert.ok(formHtml.includes("never shown as applied on Instagram"));
  assert.ok(page.includes('action="/api/forms/cycle-start"')); assert.ok(!/<button type="submit" disabled>Start cycle/.test(page));
  assert.ok(page.includes('action="/api/forms/cycle-repeat"'));
  assert.ok(page.includes("Live publishing is not configured"));
  assert.ok(page.includes("pauses new claims after 3"));
  assert.ok(page.includes("eligible, unpublished"));
  // Blocked cycle: start button disabled.
  repo.grants.find((g) => g.collectionId === "demo-shared-col-1")!.status = "revoked";
  assert.ok(/<button type="submit" disabled="">Start cycle/.test(html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } }))));
  // Ended cycles: no editing form at all.
  repo.cycles.set(DEMO_CYCLE_ID, { ...repo.cycles.get(DEMO_CYCLE_ID)!, status: "stopped" });
  const ended = html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } })); assert.ok(!ended.includes("cycle-items-form")); assert.ok(!ended.includes("cycle-start"));
});

test("collection page: the add-to-cycle form appears only where use is permitted, lists your open cycles, and posts 'collection|video'", async () => {
  const allowed = html(await CollectionPage({ params: { collectionId: "demo-shared-col-1" } }));
  assert.ok(allowed.includes('action="/api/forms/cycle-mix"')); assert.ok(allowed.includes('value="demo-shared-col-1|demo-shared-1"')); assert.ok(allowed.includes("does not copy them to your storage"));
  assert.ok(allowed.includes("Sample cycle (nothing is published)"));
  assert.ok(!html(await CollectionPage({ params: { collectionId: "demo-shared-col-2" } })).includes("cycle-mix"));      // view-only share
  assert.ok(html(await CollectionPage({ params: { collectionId: "demo-col-1" } })).includes("cycle-mix"));              // owner
  repo.cycles.clear(); assert.ok(html(await CollectionPage({ params: { collectionId: "demo-col-1" } })).includes("Create a publishing cycle"));
});

test("END TO END (no browser): read the rendered caption form's hidden fields, 'fill it in', post it to its action, see the change", async () => {
  const page = html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } }));
  const formHtml = page.slice(page.indexOf('<form id="cycle-items-form"'));
  const action = /<form id="cycle-items-form"[^>]*\saction="([^"]+)"/.exec(formHtml)![1]!; // attribute order is not significant
  const hidden = [...formHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m): [string, string] => [m[1]!, m[2]!]);
  assert.equal(action, "/api/forms/captions");
  const response = await captionsForm(formPost(action, [...hidden, ["scope", "selected"], ["itemIds", "demo-item-3"], ["caption", "Typed into the real form"]]));
  assert.equal(location(response), `/cycles/${DEMO_CYCLE_ID}?notice=captions_applied&updated=1&skipped=0&conflicts=0&confirm=0`);
  assert.equal(repo.items.get("demo-item-3")!.captionText, "Typed into the real form");
  const after = html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID }, searchParams: { notice: "captions_applied", updated: "1" } }));
  assert.ok(after.includes("Typed into the real form")); assert.ok(after.includes("Caption update finished. (1 updated)"));
});
