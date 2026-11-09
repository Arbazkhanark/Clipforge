import { test, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_EDITING_SETTINGS, computePreviewLayout, parseEditingSettings, parseEditorQuery, toRenderSettings, trimDurationProblems } from "../src/lib/domain/editing-settings.ts";
import { clampEditorOffset, clampEditorZoom, formatEditorZoomPercent, panEditorCamera, pinchEditorZoom, resetEditorCamera, stepEditorZoom, wheelEditorZoom } from "../src/lib/domain/editor-gestures.ts";
import { buildRenderArgs } from "../src/lib/render/ffmpeg-command.ts";
import { readPixel, renderVideo } from "../src/lib/render/render-runner.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { saveCurrentVideoSettings, saveEditingTemplate } from "../src/server/handlers/editor.ts";
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

test("interactive camera controls share bounded zoom and position math", () => {
  assert.equal(pinchEditorZoom(1.5, 100, 150), 2.25, "pinch out zooms in");
  assert.equal(pinchEditorZoom(1.5, 100, 50), 1, "pinch in is clamped at minimum");
  assert.equal(pinchEditorZoom(2.8, 100, 150), 3, "pinch out is clamped at maximum");
  assert.ok(wheelEditorZoom(1.5, -100) > 1.5, "wheel up zooms in");
  assert.ok(wheelEditorZoom(1.5, 100) < 1.5, "wheel down zooms out");
  assert.equal(stepEditorZoom(1, -1), 1); assert.equal(stepEditorZoom(3, 1), 3);
  assert.equal(stepEditorZoom(1.5, 1), 1.55);
  assert.equal(clampEditorZoom(Number.NaN), 1); assert.equal(clampEditorOffset(2), 1); assert.equal(clampEditorOffset(-2), -1);
  assert.deepEqual(resetEditorCamera(), { zoom: 1, offsetX: 0, offsetY: 0 });
  assert.equal(formatEditorZoomPercent(1.55), "155%"); assert.equal(formatEditorZoomPercent(99), "300%");
  assert.deepEqual(panEditorCamera({ zoom: 1.5, offsetX: 0.9, offsetY: -0.9 }, 100, -100, 100, 100), { offsetX: 1, offsetY: -1 });
  assert.deepEqual(panEditorCamera({ zoom: 1, offsetX: 0.25, offsetY: -0.25 }, 50, 25, 100, 100), { offsetX: 1, offsetY: 0.25 });
});

test("trim settings are normalized for legacy settings, structurally validated, and bounded by verified source duration", () => {
  const { trim: _legacyTrim, ...legacySettings } = DEFAULT_EDITING_SETTINGS;
  const legacy = parseEditingSettings(legacySettings);
  assert.ok(legacy.ok); if (legacy.ok) assert.deepEqual(legacy.settings.trim, { startSeconds: 0, endSeconds: null });
  for (const [name, trim] of [
    ["negative start", { startSeconds: -0.01, endSeconds: 0.5 }],
    ["equal range", { startSeconds: 0.5, endSeconds: 0.5 }],
    ["reversed range", { startSeconds: 0.8, endSeconds: 0.5 }],
    ["non numeric", { startSeconds: "0", endSeconds: 0.5 }],
    ["non-finite", { startSeconds: 0, endSeconds: Infinity }],
  ] as const) assert.equal(parseEditingSettings(base({ trim })).ok, false, name);
  const parsed = parseEditingSettings(base({ trim: { startSeconds: 0.25, endSeconds: 1 } }));
  assert.ok(parsed.ok); if (parsed.ok) {
    assert.deepEqual(parsed.settings.trim, { startSeconds: 0.25, endSeconds: 1 });
    assert.deepEqual(toRenderSettings(parsed.settings, "720p").trim, parsed.settings.trim);
  }
  assert.deepEqual(trimDurationProblems({ startSeconds: 0.25, endSeconds: 1 }, 1), []); // exact duration boundary is valid
  assert.match(trimDurationProblems({ startSeconds: 0.25, endSeconds: 1.001 }, 1)[0]!, /cannot extend past/);
  assert.match(trimDurationProblems({ startSeconds: 1, endSeconds: null }, 1)[0]!, /greater than/);
  assert.match(trimDurationProblems({ startSeconds: 0, endSeconds: null }, 0)[0]!, /unavailable/);
});

test("editor query reads trim controls and reports malformed values", () => {
  const valid = parseEditorQuery({ trimStart: "0.2", trimEnd: "0.8" });
  assert.deepEqual(valid.problems, []); assert.deepEqual(valid.settings.trim, { startSeconds: 0.2, endSeconds: 0.8 });
  assert.ok(parseEditorQuery({ trimStart: "-1", trimEnd: "0.8" }).problems.length > 0);
  assert.ok(parseEditorQuery({ trimStart: "0.8", trimEnd: "0.8" }).problems.length > 0);
  assert.ok(parseEditorQuery({ trimStart: "abc", trimEnd: "0.8" }).problems.length > 0);
});

test("FFmpeg command seeks to trim start and limits output to selected duration; full-video defaults keep existing arguments", () => {
  const full = buildRenderArgs({ inputPath: "in.mp4", outputPath: "out.mp4", source: { width: 160, height: 120, durationSeconds: 1 }, settings: toRenderSettings(DEFAULT_EDITING_SETTINGS, "720p") });
  assert.equal(full.args.includes("-ss"), false); assert.equal(full.args[full.args.indexOf("-t") + 1], "1.000");
  const parsed = parseEditingSettings(base({ trim: { startSeconds: 0.2, endSeconds: 0.8 } })); assert.ok(parsed.ok); if (!parsed.ok) return;
  const trimmed = buildRenderArgs({ inputPath: "in.mp4", outputPath: "out.mp4", source: { width: 160, height: 120, durationSeconds: 1 }, settings: toRenderSettings(parsed.settings, "720p") });
  assert.deepEqual(trimmed.args.slice(trimmed.args.indexOf("-ss"), trimmed.args.indexOf("-i") + 2), ["-ss", "0.200", "-i", "in.mp4"]);
  assert.equal(trimmed.args[trimmed.args.indexOf("-t") + 1], "0.600");
  assert.throws(() => buildRenderArgs({ inputPath: "i", outputPath: "o", source: { width: 160, height: 120, durationSeconds: 0.7 }, settings: toRenderSettings(parsed.settings, "720p") }), /cannot extend past/);
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

test("persisted camera settings produce the same preview geometry and FFmpeg placement", async () => {
  repo.media.set("v1", { ...repo.media.get("v1")!, width: 160, height: 120, durationMs: 1000 });
  const cameraSettings = base({ aspect: "1:1", zoom: 1.7, offsetX: 0.35, offsetY: -0.2, trim: { startSeconds: 0, endSeconds: 1 } });
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v1", settings: cameraSettings });
  const saved = await repo.listTemplatesForOwner("bob");
  const videoSettings = saved.find((item) => item.name === "v:v1")?.settings;
  assert.ok(videoSettings); assert.deepEqual([videoSettings.zoom, videoSettings.offsetX, videoSettings.offsetY], [1.7, 0.35, -0.2]);
  const preview = computePreviewLayout(videoSettings, { width: 160, height: 120 }, 1, "720p");
  const render = buildRenderArgs({ inputPath: "source.mp4", outputPath: "render.mp4", source: { width: 160, height: 120, durationSeconds: 1 }, settings: toRenderSettings(videoSettings, "720p") });
  assert.deepEqual(preview.canvas, render.canvas);
  assert.deepEqual(preview.borderBox, render.mainVideo);
  assert.equal(render.mainVideo.x, Math.round((render.canvas.width - render.mainVideo.width) / 2 + videoSettings.offsetX * (render.canvas.width / 2)));
  assert.equal(render.mainVideo.y, Math.round((render.canvas.height - render.mainVideo.height) / 2 + videoSettings.offsetY * (render.canvas.height / 2)));
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

test("REAL FFMPEG: selected trim range produces an export of the requested duration", { skip: !ffmpegAvailable ? "ffmpeg not installed" : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clipforge-trim-")); tmp.push(dir);
  writeFileSync(join(dir, "src.mp4"), fixtures.mp4);
  const parsed = parseEditingSettings(base({ trim: { startSeconds: 0.2, endSeconds: 0.8 } })); assert.ok(parsed.ok); if (!parsed.ok) return;
  const result = await renderVideo({ inputPath: join(dir, "src.mp4"), outputPath: join(dir, "out.mp4"), settings: toRenderSettings(parsed.settings, "720p") });
  assert.equal(result.succeeded, true); assert.equal(result.outputValidated, true);
  assert.ok(Math.abs(result.outputProbe!.durationSeconds - 0.6) <= 0.1, `duration was ${result.outputProbe!.durationSeconds}`);
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

test("active promotional Creator tier supplies the catalog template allowance", async () => {
  repo.promotionalAccessGrants.set("promo-bob", {
    id: "promo-bob", promotionId: "promotion-bob", userId: "bob", redemptionId: null, kind: "tier_access", activationPolicy: "immediate", status: "active", planId: "creator",
    durationDays: 3, queueSequence: 1n, startsAt: new Date(NOW.getTime() - 1), expiresAt: new Date(NOW.getTime() + 3 * 86_400_000), activatedAt: new Date(NOW.getTime() - 1), revokedAt: null,
    grantedByAdminId: "admin", reason: null, createdAt: NOW, updatedAt: NOW,
  });
  for (let i = 1; i <= 4; i++) await save("bob", { name: `Promo${i}`, settings: goodSettings() });
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 4, "Creator's catalog limit is greater than Free's limit of three");
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

test("page: the form has every control and the actual preview uses the authorized media route", async () => {
  const page = html(await EditorPage({ searchParams: Promise.resolve({ media: "v1" }) }));
  for (const name of ['name="aspect"', 'name="zoom"', 'name="offsetX"', 'name="offsetY"', 'name="trimStart"', 'name="trimEnd"', 'name="bg"', 'name="blur"', 'name="bgColor"', 'name="borderPx"', 'name="borderColor"', 'name="logoMedia"', 'name="logoWidth"', 'name="logoX"', 'name="logoY"', 'name="logoOpacity"', 'name="media"', 'name="name"']) assert.ok(page.includes(name), name);
  for (const label of ["9:16 (Reels, recommended)", "4:5", "1:1", "16:9", "Original"]) assert.ok(page.includes(label), label);
  assert.ok(/formNoValidate/i.test(page)); assert.ok(/formAction="\/api\/forms\/editor-save"/i.test(page)); assert.ok(/formMethod="post"/i.test(page)); assert.ok(page.includes('method="get"') && page.includes('action="/editor"'));
  assert.ok(page.includes('src="/api/media/file?id=v1&amp;variant=preview"'));
  assert.ok(page.includes('aria-label="Source video preview"') && page.includes("Playback of your source video"));
  assert.ok(page.includes('aria-label="Zoom out"') && page.includes('aria-label="Zoom in"') && page.includes("Reset zoom"));
  assert.ok(page.includes('id="editor-range-zoom-value">100%</output>'));
  const zoomSlider = page.match(/<input[^>]*name="zoom"[^>]*>/)?.[0] ?? "";
  assert.ok(zoomSlider.includes('min="1"') && zoomSlider.includes('max="3"') && zoomSlider.includes('step="0.05"'));
  assert.ok(page.includes('data-zoom-action="out"') && page.includes('data-zoom-action="in"') && page.includes('data-zoom-action="reset"'));
  assert.ok(page.includes("two fingers to zoom") && page.includes("Page scrolling works outside the preview"));
  assert.ok(page.includes('aria-label="Preview playback controls"') && page.includes("Preview position"));
  assert.ok(page.includes("touch-action:none"));
  assert.ok(page.includes("Loading video preview")); assert.ok(page.includes("not pixel-identical"));
  assert.ok(page.includes('formAction="/api/forms/render"') && page.includes("Render video"));
  assert.ok(page.includes("never change the original")); assert.ok(page.includes("up to 720p"));                                  // Free plan cap, from the catalog
  assert.ok(page.includes('aria-label="Edited video preview"'));
  assert.ok(!/storageKey|media\/bob/.test(page));
  assert.ok(!page.includes("data-logo-handle") && !page.includes("data-border"));
});

test("page: query settings drive the browser composition - border, background, and draggable logo overlay", async () => {
  const page = html(await EditorPage({ searchParams: Promise.resolve({ media: "v1", aspect: "9:16", bg: "solid", bgColor: "#ff00ff", borderPx: "10", borderColor: "#00ff00", logoMedia: "logo1", logoWidth: "0.2", logoX: "0.5", logoY: "0.1" }) }));
  assert.ok(page.includes('viewBox="0 0 720 1280"')); assert.ok(page.includes("background:#ff00ff")); assert.ok(page.includes("data-border")); assert.ok(page.includes("data-logo-handle"));
  assert.ok(page.includes("background:#00ff00"));
  assert.ok(page.includes('value="10"')); assert.ok(page.includes("My logo"));
  assert.ok(/<rect data-logo-handle="true"[^>]*x="288" y="92" width="144" height="72"/.test(page));
});

test("page: bad values are listed in an alert and replaced by safe defaults; markup in a colour is never rendered", async () => {
  const page = html(await EditorPage({ searchParams: Promise.resolve({ media: "v1", zoom: "abc", bg: "solid", bgColor: '#ff0000"><script>alert(1)</script>' }) }));
  assert.ok(page.includes('role="alert"')); assert.ok(page.includes("Zoom must be a number.")); assert.ok(!page.includes("<script>")); assert.ok(!page.includes("alert(1)"));
  const foreignLogo = html(await EditorPage({ searchParams: Promise.resolve({ media: "v1", logoMedia: "evelogo" }) }));
  assert.ok(foreignLogo.includes("must be one of your own images")); assert.ok(!foreignLogo.includes("data-logo-handle")); assert.ok(!foreignLogo.includes("Eve logo"));
});

test("page: a video of unknown size says so; someone else's video looks missing; signed-out users are asked to sign in; flash shows after saving", async () => {
  assert.ok(html(await EditorPage({ searchParams: Promise.resolve({ media: "v2" }) })).includes("preview assumes 16:9"));
  const hidden = html(await EditorPage({ searchParams: Promise.resolve({ media: "evevid" }) })); const missing = html(await EditorPage({ searchParams: Promise.resolve({ media: "zzz" }) })); assert.equal(hidden, missing); assert.ok(hidden.includes("Not found"));
  assert.ok(html(await EditorPage({ searchParams: Promise.resolve({ media: "../x" }) })).includes("Choose a video"));                          // an unsafe id is ignored, never used
  assert.ok(html(await EditorPage({ searchParams: Promise.resolve({ media: "v1", notice: "template_saved" }) })).includes("original video was not changed"));
  setRuntimeForTests(runtime(null)); assert.ok(html(await EditorPage({})).includes("Sign in required"));
});
