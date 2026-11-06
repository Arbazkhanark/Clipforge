import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { applySettingsPatch, checkedPatch, parseBulkForm, selectionAfter } from "../src/lib/domain/bulk-edit.ts";
import { DEFAULT_EDITING_SETTINGS } from "../src/lib/domain/editing-settings.ts";
import { publicRenderFailure, renderDiagnostic } from "../src/lib/render/render-errors.ts";
import { MediaTable } from "../src/components/MediaTable.tsx";
import { MediaDetailView } from "../src/components/MediaDetailView.tsx";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { applyBulkEdit, clearBulkStateForTests, reviewBulkEdit, startBulkRender } from "../src/server/bulk/bulk-service.ts";
import { saveCurrentVideoSettings, saveEditingTemplate } from "../src/server/handlers/editor.ts";
import { createRenderScheduler, type ExportRunner } from "../src/server/render/export-service.ts";
import type { RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { getEditorPageData } from "../src/server/queries.ts";
import { NOW, makeMedia } from "./helpers.ts";
import EditorPage from "../app/(app)/editor/page.tsx";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";

const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (e) { assert.ok(e instanceof AppError, String(e)); return e as AppError; } assert.fail("expected error"); };
const card = (id: string, kind: "video" | "image", title: string) => ({ id, title, kind, sizeBytes: 1000, durationMs: kind === "video" ? 1000 : null, status: "active" as const, validation: "verified" as const, hasThumbnail: false, width: 160, height: 120 });

test("selection: select all, clear, and toggle only the ids on the page", () => {
  assert.deepEqual(selectionAfter([], ["a", "b"], "all"), ["a", "b"]);
  assert.deepEqual(selectionAfter(["a", "b"], ["a", "b"], "clear"), []);
  assert.deepEqual(selectionAfter(["a"], ["a", "b"], { toggle: "b" }), ["a", "b"]);
  assert.deepEqual(selectionAfter(["a", "b"], ["a", "b"], { toggle: "a" }), ["b"]);
});

test("library: every video has an Edit button and a checkbox; images have neither", () => {
  const html = renderToStaticMarkup(<MediaTable library={{ items: [card("v1", "video", "Clip"), card("p1", "image", "Poster")], total: 2, page: 1, pageCount: 1, pageSize: 24 }} />);
  assert.ok(html.includes('href="/editor?media=v1"') && html.includes(">Edit</a>"));
  assert.ok(html.includes('aria-label="Select Clip"'));
  assert.ok(html.includes("Select all on this page") && html.includes("not to every filtered result") && html.includes("Clear selection") && html.includes("Bulk edit") && html.includes("selected"));
  assert.ok(html.includes("No editor"));
  assert.equal(html.includes('value="p1"'), false);
  assert.equal(html.includes('href="/editor?media=p1"'), false);
  const image = renderToStaticMarkup(<MediaDetailView timeZone="UTC" detail={{ mimeType: "image/png", addedAt: null, media: card("p1", "image", "Poster") }} />);
  assert.equal(image.includes("/editor?media=p1"), false);
});

test("patch: only ticked settings change, and a colour is not forced onto a blurred video", () => {
  const current = { ...DEFAULT_EDITING_SETTINGS, zoom: 1.4, offsetX: 0.2, border: { thicknessPx: 6, colorHex: "#112233" } };
  const aspectOnly = applySettingsPatch(current, { aspect: "1:1" });
  assert.equal(aspectOnly.settings.aspect, "1:1");
  assert.equal(aspectOnly.settings.zoom, 1.4);
  assert.equal(aspectOnly.settings.offsetX, 0.2);
  assert.equal(aspectOnly.settings.border.thicknessPx, 6);
  assert.equal(aspectOnly.settings.background.kind, "blur");
  const color = applySettingsPatch(current, { solidColor: "#ff00ff" });
  assert.equal(color.settings.background.kind, "blur");
  assert.ok(color.notes.some((note) => note.includes("Solid colour")));
  const solid = checkedPatch(current, { backgroundKind: "solid", solidColor: "#ff00ff", zoom: 2 });
  assert.ok(solid.ok); if (!solid.ok) return;
  assert.deepEqual(solid.settings.background, { kind: "solid", colorHex: "#ff00ff" });
  assert.equal(solid.settings.zoom, 2);
  assert.equal(solid.settings.offsetX, 0.2);
  const noLogo = applySettingsPatch(current, { logoPosition: { centerX: 0.2, centerY: 0.3 } });
  assert.equal(noLogo.settings.logo, null);
  assert.ok(noLogo.notes.some((note) => note.includes("no logo")));
});

test("render failures shown to a user never include a path", () => {
  assert.equal(publicRenderFailure(["ffmpeg exited with code 1: /tmp/secret/output.mp4"]).includes("/tmp"), false);
  assert.equal(renderDiagnostic(["ffmpeg exited with code 1: /tmp/secret/output.mp4"]).includes("/tmp"), false);
  assert.ok(renderDiagnostic(["ffmpeg exited with code 1: /tmp/secret/output.mp4"]).includes("[path]"));
  assert.match(publicRenderFailure(["Rendering took too long and was stopped."]), /took too long/);
});

let repo: MemoryRepository; let counter = 0;
const ctxFor = (userId: string | null, renders?: RequestContext["renders"], storage?: MemoryMediaStorage): RequestContext => ({
  userId, now: NOW, repo, newId: () => `id${++counter}`, config: { coverSupport: "unknown" },
  ...(renders ? { renders } : {}),
  ...(storage ? { media: { storage, probe: null, maxUploadBytes: 1000 } } : {}),
});
beforeEach(() => {
  repo = new MemoryRepository(); counter = 0; clearBulkStateForTests();
  repo.plans.set("bob", "free"); repo.plans.set("eve", "pro");
  repo.media.set("v1", makeMedia({ id: "v1", ownerId: "bob", kind: "video", title: "One", width: 160, height: 120, durationMs: 1000, validation: "verified" }));
  repo.media.set("v2", makeMedia({ id: "v2", ownerId: "bob", kind: "video", title: "Two", width: 160, height: 120, durationMs: 1000, validation: "verified" }));
  repo.media.set("poster", makeMedia({ id: "poster", ownerId: "bob", kind: "image", title: "Poster" }));
  repo.media.set("evevid", makeMedia({ id: "evevid", ownerId: "eve", kind: "video", title: "Eve clip", width: 160, height: 120, durationMs: 1000, validation: "verified" }));
});

const fields = (over: Record<string, string | string[]> = {}) => ({ media: ["v1", "v2"], use: ["aspect"], aspect: "1:1", ...over });

test("bulk review does not save, cancel leaves every video untouched, and apply changes only the ticked field", async () => {
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields());
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 0);
  const applied = await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
  assert.deepEqual([applied.updated, applied.skipped], [2, 0]);
  const again = await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
  assert.equal(again.updated, 2);
  const rows = await repo.listTemplatesForOwner("bob");
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.settings.aspect === "1:1" && row.settings.zoom === 1 && row.settings.background.kind === "blur"), true);
  const bytesBefore = JSON.stringify([...repo.media.values()]);
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v2", settings: { ...DEFAULT_EDITING_SETTINGS, aspect: "1:1", background: { kind: "solid", colorHex: "#00ff00" } } });
  const one = (await repo.listTemplatesForOwner("bob")).find((row) => row.name === "v:v1")!;
  const two = (await repo.listTemplatesForOwner("bob")).find((row) => row.name === "v:v2")!;
  assert.equal(one.settings.background.kind, "blur");
  assert.deepEqual(two.settings.background, { kind: "solid", colorHex: "#00ff00" });
  assert.equal(one.settings.aspect, "1:1");
  assert.equal(JSON.stringify([...repo.media.values()]), bytesBefore);
});

test("bulk: someone else's video is listed as not available and is not changed; a bad id is rejected", async () => {
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields({ media: ["v1", "evevid", "poster"] }));
  const { getBulkDraft } = await import("../src/server/bulk/bulk-service.ts");
  const draft = getBulkDraft(reviewed.draftId)!;
  assert.deepEqual(draft.videos.map((video) => video.title), ["One"]);
  assert.equal(draft.skipped.length, 2);
  assert.equal(JSON.stringify(draft).includes("Eve clip"), false);
  await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
  assert.equal((await repo.listTemplatesForOwner("eve")).length, 0);
  assert.equal((await errorOf(reviewBulkEdit(ctxFor("bob"), fields({ media: ["../x"], use: ["aspect"], aspect: "1:1" })))).status, 422);
  assert.equal((await errorOf(reviewBulkEdit(ctxFor("eve"), { draftId: reviewed.draftId }))).status, 422);
  assert.equal((await errorOf(applyBulkEdit(ctxFor("eve"), { draftId: reviewed.draftId }))).status, 404);
});

test("bulk: the plan's batch size is enforced and nothing is written", async () => {
  for (let i = 3; i <= 6; i++) repo.media.set(`v${i}`, makeMedia({ id: `v${i}`, ownerId: "bob", kind: "video", title: `V${i}`, width: 10, height: 10, durationMs: 1000, validation: "verified" }));
  const denied = await errorOf(reviewBulkEdit(ctxFor("bob"), fields({ media: ["v1", "v2", "v3", "v4", "v5", "v6"] })));
  assert.equal(denied.code, "plan_limit");
  assert.match(denied.message, /5 videos/);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 0);
});

test("templates: the same name and settings are not stored twice, and per-video rows do not use the cap of 3", async () => {
  const settings = { ...DEFAULT_EDITING_SETTINGS, aspect: "4:5" as const };
  const first = await saveEditingTemplate(ctxFor("bob"), { name: "Look", settings });
  const second = await saveEditingTemplate(ctxFor("bob"), { name: "Look", settings });
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.templateId, second.templateId);
  assert.equal((await repo.listTemplatesForOwner("bob")).filter((row) => row.name === "Look").length, 1);
  assert.equal((await errorOf(saveEditingTemplate(ctxFor("bob"), { name: "v:secret", settings }))).status, 422);
  for (const id of ["v1", "v2"]) await repo.saveVideoSettings({ id: `row-${id}`, ownerId: "bob", name: `v:${id}`, settings: DEFAULT_EDITING_SETTINGS, createdAt: NOW });
  for (let i = 1; i <= 2; i++) await saveEditingTemplate(ctxFor("bob"), { name: `Extra ${i}`, settings });
  const denied = await errorOf(saveEditingTemplate(ctxFor("bob"), { name: "Extra 3", settings }));
  assert.equal(denied.code, "plan_limit");
});

test("editor page keeps saved settings, and Reset returns to them", async () => {
  const runtime = (userId: string | null): Runtime => ({ mode: "demo", repo, currentUserId: async () => userId, newId: () => `t${++counter}`, now: () => NOW });
  setRuntimeForTests(runtime("bob"));
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v1", settings: { ...DEFAULT_EDITING_SETTINGS, aspect: "16:9", zoom: 1.25 } });
  const saved = await getEditorPageData(ctxFor("bob"), { mediaId: "v1", search: { job: "missing" } });
  assert.equal(saved.settings.aspect, "16:9"); assert.equal(saved.settings.zoom, 1.25); assert.equal(saved.settingsSource, "saved");
  const preview = await getEditorPageData(ctxFor("bob"), { mediaId: "v1", search: { aspect: "1:1", zoom: "2" } });
  assert.equal(preview.settings.aspect, "1:1"); assert.equal(preview.settingsSource, "preview");
  const page = renderToStaticMarkup(await EditorPage({ searchParams: { media: "v1" } }));
  assert.ok(page.includes(">Undo</button>") && page.includes('href="/editor?media=v1"') && page.includes('href="/media/v1"') && page.includes("Save settings"));
  assert.ok(page.includes("not a rendered video"));
  setRuntimeForTests(null);
});

test("bulk render tracks each video, refuses one that cannot render, and a failed job does not keep a path or change the original", async () => {
  const storage = new MemoryMediaStorage();
  storage.objects.set("media/bob/v1", new Uint8Array([1, 2, 3, 4]));
  repo.storageKeys.set("v1", "media/bob/v1");
  repo.media.set("v2", { ...repo.media.get("v2")!, durationMs: null, validation: "incomplete" });
  const renders = createRenderScheduler(2);
  const runner: ExportRunner = { async render() { return { succeeded: false, outputValidated: false, problems: ["ffmpeg exited with code 1: /tmp/secret/output.mp4"], processingSeconds: 0.01, outputProbe: null }; } };
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields());
  await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
  const started = await startBulkRender(ctxFor("bob", renders, storage), { draftId: reviewed.draftId }, runner);
  const again = await startBulkRender(ctxFor("bob", renders, storage), { draftId: reviewed.draftId }, runner);
  assert.equal(again.batchId, started.batchId);
  const { getRenderBatch, batchJobs } = await import("../src/server/bulk/bulk-service.ts");
  const batch = getRenderBatch(started.batchId)!;
  assert.equal(batch.items.filter((item) => item.jobId).length, 1);
  assert.match(batch.items.find((item) => item.mediaId === "v2")?.refused ?? "", /duration|checked/);
  for (let i = 0; i < 40 && renders.jobs.get(batch.items.find((item) => item.jobId)?.jobId ?? "")?.status !== "failed"; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const jobs = batchJobs(ctxFor("bob", renders, storage), batch);
  const failed = jobs.find((job) => job.mediaId === "v1");
  assert.equal(failed?.status, "failed");
  assert.equal((failed?.message ?? "").includes("/tmp"), false);
  assert.deepEqual([...storage.objects.get("media/bob/v1")!], [1, 2, 3, 4]);
  assert.equal((await repo.listRenderOutputsForOwner("bob")).length, 0);
  const audits = await repo.listAuditsForEntities("MediaAsset", ["v1"]);
  assert.equal(JSON.stringify(audits).includes("/tmp"), false);
  assert.ok(JSON.stringify(audits).includes("[path]"));
});

test("REAL FFMPEG: a bulk render makes a separate export for each selected video and leaves both originals unchanged", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg not installed" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clipforge-bulk-"));
  try {
    const red = path.join(dir, "red.mp4");
    const blue = path.join(dir, "blue.mp4");
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=160x120:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", red]).status, 0);
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", blue]).status, 0);
    const storage = new MemoryMediaStorage();
    const redBytes = readFileSync(red);
    const blueBytes = readFileSync(blue);
    storage.objects.set("media/bob/v1", redBytes);
    storage.objects.set("media/bob/v2", blueBytes);
    repo.storageKeys.set("v1", "media/bob/v1");
    repo.storageKeys.set("v2", "media/bob/v2");
    const renders = createRenderScheduler(2);
    const reviewed = await reviewBulkEdit(ctxFor("bob"), fields());
    await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
    const started = await startBulkRender(ctxFor("bob", renders, storage), { draftId: reviewed.draftId });
    const { getRenderBatch, batchJobs } = await import("../src/server/bulk/bulk-service.ts");
    const batch = getRenderBatch(started.batchId)!;
    for (let i = 0; i < 80 && batchJobs(ctxFor("bob", renders, storage), batch).some((job) => job.status === "queued" || job.status === "processing"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const jobs = batchJobs(ctxFor("bob", renders, storage), batch);
    assert.equal(jobs.length, 2);
    for (const job of jobs) assert.equal(job.status, "completed", `${job.title}: ${job.message ?? ""}`);
    assert.equal(new Set(jobs.map((job) => job.outputId)).size, 2);
    assert.deepEqual([...storage.objects.get("media/bob/v1")!], [...redBytes]);
    assert.deepEqual([...storage.objects.get("media/bob/v2")!], [...blueBytes]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

afterEach(() => setRuntimeForTests(null));
