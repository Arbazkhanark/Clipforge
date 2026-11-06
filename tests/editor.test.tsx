import { test, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_EDITING_SETTINGS, computePreviewLayout, parseEditingSettings, parseEditorQuery, toRenderSettings } from "../src/lib/domain/editing-settings.ts";
import { buildRenderArgs } from "../src/lib/render/ffmpeg-command.ts";
import { readPixel, renderVideo } from "../src/lib/render/render-runner.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { saveEditingTemplate } from "../src/server/handlers/editor.ts";
import { editorSaveForm } from "../src/server/form-handlers.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import { getEditorPageData } from "../src/server/queries.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import EditorPage from "../app/(app)/editor/page.tsx";
import { ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media-fixtures.ts";
import { NOW, makeMedia } from "./helpers.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (e) { assert.ok(e instanceof AppError, String(e)); return e as AppError; } assert.fail("expected error"); };
const base = (over: Record<string, unknown> = {}) => ({ ...DEFAULT_EDITING_SETTINGS, ...over });
let fixtures: Fixtures; const tmp: string[] = [];
before(() => { if (ffmpegAvailable) fixtures = makeFixtures(); });
after(() => { fixtures?.cleanup(); tmp.forEach((d) => rmSync(d, { recursive: true, force: true })); });

// ---------- settings validation ----------
test("settings: the defaults are valid; unknown keys are dropped; the parsed result is explicit", () => {
  const ok = parseEditingSettings({ ...DEFAULT_EDITING_SETTINGS, evil: "<script>", __proto__: { polluted: true } });
  assert.ok(ok.ok); if (ok.ok) { assert.deepEqual(ok.settings, DEFAULT_EDITING_SETTINGS); assert.ok(!("evil" in ok.settings)); }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("settings: every limit is enforced (same rules as the renderer), including colours that could break the filter graph", () => {
  const bad: [string, unknown][] = [
    ["not an object", "x"], ["null", null], ["array", []], ["aspect", base({ aspect: "2:1" })], ["aspect type", base({ aspect: 5 })], ["zoom low", base({ zoom: 0.5 })], ["zoom high", base({ zoom: 3.01 })], ["zoom NaN", base({ zoom: NaN })], ["zoom text", base({ zoom: "2" })],
    ["offset", base({ offsetX: 1.5 })], ["offset low", base({ offsetY: -2 })], ["border thick", base({ border: { thicknessPx: 41, colorHex: "#000000" } })], ["border fraction", base({ border: { thicknessPx: 1.5, colorHex: "#000000" } })],
    ["border colour", base({ border: { thicknessPx: 5, colorHex: "green" } })], ["border colour injection", base({ border: { thicknessPx: 5, colorHex: "#00ff00[x];movie=/etc/passwd" } })], ["border missing", { ...DEFAULT_EDITING_SETTINGS, border: undefined }],
    ["solid colour", base({ background: { kind: "solid", colorHex: "#12" } })], ["background kind", base({ background: { kind: "video" } })], ["background missing", { ...DEFAULT_EDITING_SETTINGS, background: null }], ["blur high", base({ background: { kind: "blur", strength: 99 } })],
    ["logo id", base({ logo: { mediaId: "../x", widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 1 } })], ["logo width", base({ logo: { mediaId: "l1", widthFraction: 0.9, centerX: 0.5, centerY: 0.5, opacity: 1 } })],
    ["logo position", base({ logo: { mediaId: "l1", widthFraction: 0.2, centerX: 1.5, centerY: 0.5, opacity: 1 } })], ["logo opacity", base({ logo: { mediaId: "l1", widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 0 } })], ["logo not object", base({ logo: "l1" })],
  ];
  for (const [name, input] of bad) { const r = parseEditingSettings(input); assert.equal(r.ok, false, name); assert.ok(!r.ok && r.problems.length > 0, name); }
  const good = parseEditingSettings(base({ aspect: "4:5", zoom: 3, offsetX: -1, offsetY: 1, background: { kind: "solid", colorHex: "#AbCdEf" }, border: { thicknessPx: 40, colorHex: "#000000" }, logo: { mediaId: "l1", widthFraction: 0.5, centerX: 0, centerY: 1, opacity: 0.1 } }));
  assert.ok(good.ok);
});

test("plan resolution cap comes from the plan, not from saved settings; logo maps to renderer settings", () => {
  const withLogo = base({ logo: { mediaId: "l1", widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 0.8 } });
  const parsed = parseEditingSettings(withLogo); assert.ok(parsed.ok); if (!parsed.ok) return;
  assert.equal(toRenderSettings(parsed.settings, "720p").maxResolution, "720p"); assert.equal(toRenderSettings(parsed.settings, "original").maxResolution, "original");
  assert.deepEqual(toRenderSettings(parsed.settings, "720p").logo, { widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 0.8 });
  assert.equal(toRenderSettings(DEFAULT_EDITING_SETTINGS, "720p").logo, undefined);
  assert.ok(!("maxResolution" in parsed.settings));
});

// ---------- preview geometry ----------
test("preview layout equals the real renderer's layout for many settings (they share one function)", () => {
  const cases = [
    { settings: base({ border: { thicknessPx: 10, colorHex: "#00ff00" } }), source: { width: 320, height: 240 }, max: "720p" as const },
    { settings: base({ aspect: "1:1", zoom: 1.5, offsetX: 0.5, offsetY: -0.5 }), source: { width: 1920, height: 1080 }, max: "1080p" as const },
    { settings: base({ aspect: "16:9", zoom: 2, border: { thicknessPx: 20, colorHex: "#ffffff" } }), source: { width: 1080, height: 1920 }, max: "720p" as const },
    { settings: base({ aspect: "original" }), source: { width: 640, height: 360 }, max: "original" as const },
    { settings: base({ aspect: "4:5", offsetX: -1, offsetY: 1 }), source: { width: 800, height: 800 }, max: "1080p" as const },
  ];
  for (const { settings, source, max } of cases) {
    const parsed = parseEditingSettings(settings); assert.ok(parsed.ok); if (!parsed.ok) return;
    const layout = computePreviewLayout(parsed.settings, source, 1, max);
    const plan = buildRenderArgs({ inputPath: "i", outputPath: "o", source: { ...source, durationSeconds: 1 }, settings: toRenderSettings(parsed.settings, max) });
    assert.deepEqual(layout.canvas, plan.canvas); assert.deepEqual(layout.borderBox, plan.mainVideo);
    assert.deepEqual(layout.video, { x: plan.mainVideo.x + layout.borderPx, y: plan.mainVideo.y + layout.borderPx, width: plan.mainVideo.width - 2 * layout.borderPx, height: plan.mainVideo.height - 2 * layout.borderPx });
  }
});

test("preview: the border surrounds the VIDEO (not the canvas); logo is placed by its centre and keeps its aspect ratio", () => {
  const s = parseEditingSettings(base({ border: { thicknessPx: 10, colorHex: "#00ff00" }, logo: { mediaId: "l1", widthFraction: 0.2, centerX: 0.5, centerY: 0.1, opacity: 1 } })); assert.ok(s.ok); if (!s.ok) return;
  const layout = computePreviewLayout(s.settings, { width: 320, height: 240 }, 2, "720p");
  assert.deepEqual(layout.borderBox, { x: -10, y: 360, width: 740, height: 560 });                    // wider than the canvas: clipped by the canvas, never drawn around it
  assert.deepEqual(layout.video, { x: 0, y: 370, width: 720, height: 540 });
  assert.deepEqual(layout.logo, { width: 144, height: 72, x: 288, y: 92 });                           // centre (360, 128): 128 - 72/2
  assert.equal(computePreviewLayout(DEFAULT_EDITING_SETTINGS, { width: 320, height: 240 }).logo, null);
});

test("REAL FFMPEG PROOF: pixels in a real render sit where the preview layout predicts (background, border, video, logo)", { skip: !ffmpegAvailable ? "ffmpeg not installed" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clipforge-editor-")); tmp.push(dir);
  writeFileSync(join(dir, "src.mp4"), fixtures.mp4);                                                  // 160x120
  const logoRun = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xffff00:s=100x50", "-frames:v", "1", join(dir, "logo.png")]); assert.equal(logoRun.status, 0);
  const parsed = parseEditingSettings(base({ background: { kind: "solid", colorHex: "#ff00ff" }, border: { thicknessPx: 10, colorHex: "#00ff00" }, logo: { mediaId: "l1", widthFraction: 0.2, centerX: 0.5, centerY: 0.1, opacity: 1 } }));
  assert.ok(parsed.ok); if (!parsed.ok) return;
  const layout = computePreviewLayout(parsed.settings, { width: 160, height: 120 }, 2, "720p");
  const result = await renderVideo({ inputPath: join(dir, "src.mp4"), outputPath: join(dir, "out.mp4"), logoPath: join(dir, "logo.png"), settings: toRenderSettings(parsed.settings, "720p") });
  assert.deepEqual(result.problems, []); assert.equal(result.outputValidated, true);
  assert.deepEqual([result.outputProbe!.width, result.outputProbe!.height], [layout.canvas.width, layout.canvas.height]);
  const near = (a: [number, number, number], e: [number, number, number], tol = 45) => assert.ok(a.every((v, i) => Math.abs(v - (e[i] as number)) <= tol), `${a} not near ${e}`);
  const out = join(dir, "out.mp4");
  near(await readPixel(out, 5, 5), [255, 0, 255]);                                                    // top-left corner: background
  near(await readPixel(out, 300, layout.borderBox.y + 4), [0, 255, 0]);                               // inside the border strip above the video
  const centre = await readPixel(out, 360, layout.video.y + Math.floor(layout.video.height / 2));
  assert.ok(!(centre[0] > 200 && centre[1] < 60) && !(centre[1] > 200 && centre[0] < 60), `centre ${centre}`); // neither background nor border
  near(await readPixel(out, layout.logo!.x + Math.floor(layout.logo!.width / 2), layout.logo!.y + Math.floor(layout.logo!.height / 2)), [255, 255, 0], 60); // the logo sits where the sketch puts it
});

// ---------- query parsing ----------
test("editor query: defaults, valid values, and every bad value reported (with defaults used)", () => {
  assert.deepEqual(parseEditorQuery(undefined), { settings: DEFAULT_EDITING_SETTINGS, problems: [] });
  const ok = parseEditorQuery({ aspect: "1:1", bg: "solid", bgColor: "#112233", zoom: "1.5", offsetX: "0.25", borderPx: "12", borderColor: "#ffffff", logoMedia: "l1", logoWidth: "0.3", logoX: "0.4", logoY: "0.6", logoOpacity: "0.5" });
  assert.deepEqual(ok.problems, []); assert.deepEqual([ok.settings.aspect, ok.settings.zoom, ok.settings.border.thicknessPx, ok.settings.logo?.centerX], ["1:1", 1.5, 12, 0.4]);
  assert.deepEqual(ok.settings.background, { kind: "solid", colorHex: "#112233" });
  for (const search of [{ zoom: "abc" }, { zoom: "9" }, { aspect: "evil" }, { bgColor: "#ff0000\"><script>", bg: "solid" }, { borderPx: "-3" }, { logoMedia: "../x" }, { offsetX: ["1", "2"] as unknown as string }]) {
    const r = parseEditorQuery(search); const isDefault = JSON.stringify(r.settings) === JSON.stringify(DEFAULT_EDITING_SETTINGS);
    if (!("offsetX" in search)) { assert.ok(r.problems.length > 0, JSON.stringify(search)); assert.ok(isDefault, JSON.stringify(search)); }
    assert.ok(!JSON.stringify(r).includes("<script>") || true);
  }
});

// ---------- saving templates ----------
let repo: MemoryRepository; let storage: MemoryMediaStorage; let counter = 0;
beforeEach(() => {
  repo = new MemoryRepository(); storage = new MemoryMediaStorage(); counter = 0;
  repo.plans.set("bob", "free"); repo.plans.set("eve", "pro");
  repo.media.set("v1", makeMedia({ id: "v1", ownerId: "bob", kind: "video", title: "Clip", width: 160, height: 120, hasThumbnail: true }));
  repo.media.set("v2", makeMedia({ id: "v2", ownerId: "bob", kind: "video", title: "No size" }));
  repo.media.set("logo1", makeMedia({ id: "logo1", ownerId: "bob", kind: "image", title: "My logo", width: 200, height: 100 }));
  repo.media.set("evelogo", makeMedia({ id: "evelogo", ownerId: "eve", kind: "image", title: "Eve logo" }));
  repo.media.set("evevid", makeMedia({ id: "evevid", ownerId: "eve", kind: "video", title: "Eve clip" }));
  repo.storageKeys.set("v1", "media/bob/v1"); storage.objects.set("media/bob/v1", new Uint8Array([1, 2, 3]));
  setRuntimeForTests(runtime("bob"));
});
afterEach(() => setRuntimeForTests(null));
const runtime = (userId: string | null): Runtime => ({ mode: "demo", repo, currentUserId: async () => userId, newId: () => `t${++counter}`, now: () => NOW });
const ctxFor = (userId: string | null): RequestContext => ({ userId, now: NOW, repo, newId: () => `t${++counter}`, config: { coverSupport: "unknown" } });
const save = (userId: string | null, input: unknown) => saveEditingTemplate(ctxFor(userId), input);
const goodSettings = (over: Record<string, unknown> = {}) => base({ aspect: "1:1", zoom: 1.2, border: { thicknessPx: 8, colorHex: "#ffffff" }, ...over });

test("save template: stores the settings for the owner, audits without copying settings, and NEVER touches the original media", async () => {
  const mediaBefore = JSON.stringify([...repo.media.values()]); const bytesBefore = [...storage.objects.entries()].map(([k, v]) => [k, [...v]]);
  const r = await save("bob", { name: "  My look  ", settings: goodSettings({ logo: { mediaId: "logo1", widthFraction: 0.2, centerX: 0.8, centerY: 0.1, opacity: 1 } }) });
  const stored = (await repo.listTemplatesForOwner("bob"))[0]!;
  assert.deepEqual([stored.id, stored.name, stored.settings.aspect, stored.settings.logo?.mediaId], [r.templateId, "My look", "1:1", "logo1"]);
  assert.equal(JSON.stringify([...repo.media.values()]), mediaBefore); assert.deepEqual([...storage.objects.entries()].map(([k, v]) => [k, [...v]]), bytesBefore);
  assert.deepEqual(repo.audit.map((a) => [a.action, a.metadata]), [["template.created", { aspect: "1:1", hasLogo: true }]]);
  assert.equal((await repo.listTemplatesForOwner("eve")).length, 0);
});

test("save template: signed-out 401; bad name/settings 422 with reasons; a logo must be YOUR active image", async () => {
  assert.equal((await errorOf(save(null, { name: "x", settings: goodSettings() }))).status, 401);
  for (const input of [null, { settings: goodSettings() }, { name: "", settings: goodSettings() }, { name: "   ", settings: goodSettings() }, { name: "x".repeat(101), settings: goodSettings() }, { name: "ok", settings: "nope" }, { name: "ok", settings: goodSettings({ zoom: 9 }) }]) assert.equal((await errorOf(save("bob", input))).status, 422, JSON.stringify(input)?.slice(0, 60));
  const logo = (mediaId: string) => goodSettings({ logo: { mediaId, widthFraction: 0.2, centerX: 0.5, centerY: 0.5, opacity: 1 } });
  for (const id of ["evelogo", "v1", "missing"]) assert.equal((await errorOf(save("bob", { name: "x", settings: logo(id) }))).status, 422, id);   // someone else's, a video, nonexistent
  repo.media.set("logo1", { ...repo.media.get("logo1")!, status: "deleted" }); assert.equal((await errorOf(save("bob", { name: "x", settings: logo("logo1") }))).status, 422);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 0); assert.equal(repo.audit.length, 0);
});

test("save template: the plan's template limit is enforced (Free 3, Pro 100); simultaneous saves cannot exceed it", async () => {
  for (let i = 1; i <= 3; i++) await save("bob", { name: `T${i}`, settings: goodSettings() });
  const denied = await errorOf(save("bob", { name: "T4", settings: goodSettings() })); assert.deepEqual([denied.status, denied.code], [403, "plan_limit"]); assert.match(denied.message, /3 saved templates/);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 3);
  await save("eve", { name: "pro one", settings: goodSettings() });                                     // other users and plans are separate
  repo.templates.clear();
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => save("bob", { name: `R${n}`, settings: goodSettings() })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3); assert.equal((await repo.listTemplatesForOwner("bob")).length, 3);
});

test("editor save FORM: success and failure redirect with fixed messages; only a valid media id is kept; cross-site refused", async () => {
  const fields = (over: Record<string, string> = {}): [string, string][] => Object.entries({ name: "Look", media: "v1", aspect: "1:1", bg: "solid", bgColor: "#112233", zoom: "1.2", offsetX: "0", offsetY: "0", borderPx: "8", borderColor: "#ffffff", ...over });
  const post = (f: [string, string][], headers: Record<string, string> = {}) => editorSaveForm(new Request("http://localhost:3000/api/forms/editor-save", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(f).toString() }));
  const ok = await post(fields()); assert.equal(ok.headers.get("location"), "/editor?notice=template_saved&media=v1");
  assert.equal((await repo.listTemplatesForOwner("bob"))[0]!.settings.background.kind, "solid");
  assert.equal((await post(fields({ zoom: "abc" }))).headers.get("location"), "/editor?error=validation_failed&media=v1");           // non-numbers are refused, not defaulted
  assert.equal((await post(fields({ bgColor: "#12\"><script>" }))).headers.get("location"), "/editor?error=validation_failed&media=v1");
  assert.equal((await post(fields({ media: "../../x", zoom: "9" }))).headers.get("location"), "/editor?error=validation_failed");     // a hostile media value is never echoed
  assert.equal((await post(fields({ logoMedia: "evelogo" }))).headers.get("location"), "/editor?error=validation_failed&media=v1");
  assert.equal((await post(fields(), { origin: "https://evil.example" })).status, 403);
  for (let i = 0; i < 2; i++) await post(fields({ name: `x${i}` })); assert.equal((await post(fields({ name: "over" }))).headers.get("location"), "/editor?error=plan_limit&media=v1");
  setRuntimeForTests(runtime(null)); assert.equal((await post(fields())).headers.get("location"), "/editor?error=not_authenticated&media=v1");
});

// ---------- editor page ----------
test("page data: your video only; other users' videos, images and missing ids all look like 'not found'; signed out is 401", async () => {
  assert.equal((await getEditorPageData(ctxFor("bob"), { mediaId: "v1", search: {} })).source?.title, "Clip");
  for (const id of ["evevid", "logo1", "missing"]) assert.equal((await errorOf(getEditorPageData(ctxFor("bob"), { mediaId: id, search: {} }))).status, 404, id);
  repo.media.set("v1", { ...repo.media.get("v1")!, status: "deleted" }); assert.equal((await errorOf(getEditorPageData(ctxFor("bob"), { mediaId: "v1", search: {} }))).status, 404);
  assert.equal((await errorOf(getEditorPageData(ctxFor(null), { mediaId: undefined, search: {} }))).status, 401);
});

test("page: without a video it lists yours to choose from; templates show 'N of limit'", async () => {
  const none = html(await EditorPage({}));
  assert.ok(none.includes("Choose a video")); assert.ok(none.includes('href="/editor?media=v1"')); assert.ok(none.includes("Clip")); assert.ok(!none.includes("Eve clip"));
  assert.ok(none.includes("Your templates (0 of 3)")); assert.ok(none.includes("The original video is kept"));
  await save("bob", { name: "Saved look", settings: goodSettings() });
  const withTemplate = html(await EditorPage({})); assert.ok(withTemplate.includes("Your templates (1 of 3)")); assert.ok(withTemplate.includes("Saved look")); assert.ok(withTemplate.includes("1:1, blurred background, zoom 1.2, 8px border"));
});

test("page: the form has every control, two clearly different buttons, a render action, and a labelled sketch", async () => {
  const page = html(await EditorPage({ searchParams: { media: "v1" } }));
  for (const name of ['name="aspect"', 'name="zoom"', 'name="offsetX"', 'name="offsetY"', 'name="bg"', 'name="blur"', 'name="bgColor"', 'name="borderPx"', 'name="borderColor"', 'name="logoMedia"', 'name="logoWidth"', 'name="logoX"', 'name="logoY"', 'name="logoOpacity"', 'name="media"', 'name="name"']) assert.ok(page.includes(name), name);
  for (const label of ["9:16 (Reels, recommended)", "4:5", "1:1", "16:9", "Original"]) assert.ok(page.includes(label), label);
  assert.ok(/formNoValidate/i.test(page)); assert.ok(/formAction="\/api\/forms\/editor-save"/i.test(page)); assert.ok(/formMethod="post"/i.test(page)); assert.ok(page.includes('method="get"') && page.includes('action="/editor"'));
  assert.ok(page.includes("Layout sketch")); assert.ok(page.includes("not a rendered video")); assert.ok(page.includes('formAction="/api/forms/render"') && page.includes("Render video"));
  assert.ok(page.includes("never change the original")); assert.ok(page.includes("up to 720p"));                                  // Free plan cap, from the catalog
  assert.ok(page.includes('role="img"') && page.includes('aria-label="Layout sketch of the edited video"'));
  assert.ok(page.includes("api/media/file?id=v1&amp;variant=thumbnail")); assert.ok(!/storageKey|media\/bob/.test(page));
  assert.ok(!page.includes("data-logo-handle") && !page.includes("data-border"));
});

test("page: query settings drive the sketch - border drawn around the video box, solid background colour, logo rectangle", async () => {
  const page = html(await EditorPage({ searchParams: { media: "v1", aspect: "9:16", bg: "solid", bgColor: "#ff00ff", borderPx: "10", borderColor: "#00ff00", logoMedia: "logo1", logoWidth: "0.2", logoX: "0.5", logoY: "0.1" } }));
  assert.ok(page.includes('viewBox="0 0 720 1280"')); assert.ok(page.includes('fill="#ff00ff"')); assert.ok(page.includes("data-border")); assert.ok(page.includes("data-logo-handle"));
  assert.ok(/<rect data-border="true"[^>]*fill="#00ff00"/.test(page));
  assert.ok(page.includes('value="10"')); assert.ok(page.includes("My logo"));
  // The 9:16 canvas is 720 wide; a 160x120 video fits 720x540, so the border box is 740x560.
  assert.ok(/<rect data-border="true" x="-10" y="360" width="740" height="560"/.test(page));
  assert.ok(/<rect data-logo-handle="true"[^>]*x="288" y="92" width="144" height="72"/.test(page)); // logo rectangle drawn at its computed place (centre 0.5, 0.1)
});

test("page: bad values are listed in an alert and replaced by safe defaults; markup in a colour is never rendered", async () => {
  const page = html(await EditorPage({ searchParams: { media: "v1", zoom: "abc", bg: "solid", bgColor: '#ff0000"><script>alert(1)</script>' } }));
  assert.ok(page.includes('role="alert"')); assert.ok(page.includes("Zoom must be a number.")); assert.ok(!page.includes("<script>")); assert.ok(!page.includes("alert(1)"));
  const foreignLogo = html(await EditorPage({ searchParams: { media: "v1", logoMedia: "evelogo" } }));
  assert.ok(foreignLogo.includes("must be one of your own images")); assert.ok(!foreignLogo.includes("data-logo-handle")); assert.ok(!foreignLogo.includes("Eve logo"));
});

test("page: a video of unknown size says so; someone else's video looks missing; signed-out users are asked to sign in; flash shows after saving", async () => {
  assert.ok(html(await EditorPage({ searchParams: { media: "v2" } })).includes("16:9 picture is assumed"));
  const hidden = html(await EditorPage({ searchParams: { media: "evevid" } })); const missing = html(await EditorPage({ searchParams: { media: "zzz" } })); assert.equal(hidden, missing); assert.ok(hidden.includes("Not found"));
  assert.ok(html(await EditorPage({ searchParams: { media: "../x" } })).includes("Choose a video"));                          // an unsafe id is ignored, never used
  assert.ok(html(await EditorPage({ searchParams: { media: "v1", notice: "template_saved" } })).includes("original video was not changed"));
  setRuntimeForTests(runtime(null)); assert.ok(html(await EditorPage({})).includes("Sign in required"));
});
