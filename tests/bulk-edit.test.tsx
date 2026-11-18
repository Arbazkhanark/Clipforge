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
import { BatchStatus, BulkConfirmation, BulkForm } from "../src/components/BulkViews.tsx";
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

test("library: every video has an Edit video link and a checkbox; images have neither", () => {
  const html = renderToStaticMarkup(<MediaTable library={{ items: [card("v1", "video", "Clip"), card("p1", "image", "Poster")], total: 2, page: 1, pageCount: 1, pageSize: 24 }} />);
  assert.ok(html.includes('href="/editor?media=v1"') && html.includes(">Edit video →</a>"));
  assert.ok(html.includes('aria-label="Select Clip"'));
  assert.ok(html.includes("Select all on this page") && html.includes("not to every filtered result") && html.includes("Clear selection") && html.includes("Bulk edit") && html.includes("selected"));
  assert.ok(html.includes('href="/media/p1"') && html.includes("View →"));
  assert.equal(html.includes('value="p1"'), false);
  assert.equal(html.includes('href="/editor?media=p1"'), false);
  const image = renderToStaticMarkup(<MediaDetailView timeZone="UTC" detail={{ mimeType: "image/png", addedAt: null, media: card("p1", "image", "Poster") }} />);
  assert.equal(image.includes("/editor?media=p1"), false);
});

test("bulk form offers saved styles and makes trim copying an explicit choice", () => {
  const html = renderToStaticMarkup(<BulkForm videos={[card("v1", "video", "Clip")]} images={[card("logo", "image", "Brand")]} templates={[{ id: "style1", name: "Brand look", summary: "1:1, zoom 2, border", settings: { ...DEFAULT_EDITING_SETTINGS, aspect: "1:1", zoom: 2 } }]} batchSize={5} />);
  assert.ok(html.includes('name="styleTemplateId"') && html.includes("Brand look") && html.includes('name="copyTemplateTrim"'));
  assert.ok(html.includes("trim ranges stay as they are"));
  assert.ok(html.includes("bulk-editor-page") && html.includes("Videos selected") && html.includes("Review changes"));
  assert.ok(html.includes("Individual settings") && html.includes("Nothing changes yet"));
  assert.ok(html.includes("See your changes") && html.includes('id="bulk-preview-video"') && html.includes('aria-label="Source video preview"'));
  assert.ok(html.includes('/api/media/file?id=v1&amp;variant=preview') && html.includes("This is a browser preview"));
});

test("bulk form keeps templates optional when the owner has not created one", () => {
  const html = renderToStaticMarkup(<BulkForm videos={[card("v1", "video", "Clip")]} images={[]} templates={[]} batchSize={5} />);
  assert.match(html, /No templates yet/);
  assert.match(html, /continue with individual settings/);
  assert.match(html, /name="use" value="aspect"/);
});

test("render batch uses video cards with real status, refusal reason, preview, and successful export actions", () => {
  const html = renderToStaticMarkup(<BatchStatus items={[
    { title: "Needs verification.mp4", mediaId: "v1", status: "refused", message: "This video has not been fully checked, so it cannot be rendered.", outputId: null, hasThumbnail: true, durationMs: 12_000 },
    { title: "Finished.mp4", mediaId: "v2", status: "completed", message: null, outputId: "output-2", hasThumbnail: false, durationMs: 8_000 },
  ]} />);
  assert.match(html, /Your render batch/);
  assert.match(html, /2 of 2 items finished/);
  assert.match(html, /Needs verification\.mp4/);
  assert.match(html, /Not eligible/);
  assert.match(html, /has not been fully checked/);
  assert.match(html, /Watch preview of Needs verification\.mp4/);
  assert.match(html, /\/api\/media\/file\?id=v1&amp;variant=thumbnail/);
  assert.match(html, /Download export/);
  assert.match(html, /\/api\/renders\/file\?id=output-2/);
  assert.match(html, /\/api\/renders\/preview\?id=output-2/);
  assert.match(html, /Edited export/);
  assert.match(html, /Original upload/);
  assert.match(html, /\/editor\?media=v1/);
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

test("bulk form accepts an owned saved style exclusively and makes trim copying explicit", () => {
  const selectedStyle = parseBulkForm((key) => ({ styleTemplateId: "style1", copyTemplateTrim: "yes" }[key]), (key) => key === "media" ? ["v1"] : []);
  assert.deepEqual(selectedStyle, { ok: true, mediaIds: ["v1"], patch: {}, lines: [], styleTemplateId: "style1", copyTemplateTrim: true });
  assert.equal(parseBulkForm((key) => ({ styleTemplateId: "style1" }[key]), (key) => key === "media" ? ["v1"] : []).ok, true);
  assert.equal(parseBulkForm((key) => ({ styleTemplateId: "style1" }[key]), (key) => key === "media" ? ["v1"] : ["zoom"]).ok, false);
  assert.equal(parseBulkForm((key) => ({ copyTemplateTrim: "yes" }[key]), (key) => key === "media" ? ["v1"] : ["aspect"]).ok, false);
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

test("bulk rejects missing, mixed-owner, and non-video selections without changing any selected media", async () => {
  for (const ids of [["v1", "evevid"], ["v1", "poster"], ["v1", "missing"]]) {
    await assert.rejects(() => reviewBulkEdit(ctxFor("bob"), fields({ media: ids })), AppError);
  }
  assert.equal((await repo.listTemplatesForOwner("eve")).length, 0);
  assert.equal((await errorOf(reviewBulkEdit(ctxFor("bob"), fields({ media: ["../x"], use: ["aspect"], aspect: "1:1" })))).status, 422);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 0);
});

test("bulk applies an owned reusable style, preserving each video's trim unless copying is explicitly selected", async () => {
  const templateSettings = { ...DEFAULT_EDITING_SETTINGS, aspect: "1:1" as const, background: { kind: "solid" as const, colorHex: "#aa1122" }, zoom: 2.4, offsetX: 0.3, offsetY: -0.25, border: { thicknessPx: 12, colorHex: "#ffffff" }, trim: { startSeconds: 0.2, endSeconds: 0.8 }, logo: { mediaId: "poster", widthFraction: 0.3, centerX: 0.4, centerY: 0.6, opacity: 0.7 } };
  const saved = await saveEditingTemplate(ctxFor("bob"), { name: "Reel style", settings: templateSettings });
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v1", settings: { ...DEFAULT_EDITING_SETTINGS, trim: { startSeconds: 0.05, endSeconds: 0.9 } } });
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v2", settings: { ...DEFAULT_EDITING_SETTINGS, trim: { startSeconds: 0.1, endSeconds: 0.7 } } });
  const reviewed = await reviewBulkEdit(ctxFor("bob"), { media: ["v1", "v2"], styleTemplateId: saved.templateId });
  const { getBulkDraft } = await import("../src/server/bulk/bulk-service.ts");
  const draft = getBulkDraft(reviewed.draftId)!;
  assert.equal(draft.styleName, "Reel style");
  assert.deepEqual(draft.videos.map((video) => video.after.trim), [{ startSeconds: 0.05, endSeconds: 0.9 }, { startSeconds: 0.1, endSeconds: 0.7 }]);
  assert.deepEqual([draft.videos[0]!.after.zoom, draft.videos[0]!.after.offsetX, draft.videos[0]!.after.offsetY], [2.4, 0.3, -0.25]);
  assert.deepEqual(draft.videos[0]!.after.logo, templateSettings.logo);
  const reviewedMarkup = renderToStaticMarkup(<BulkConfirmation draft={draft} />);
  assert.ok(reviewedMarkup.includes("Reel style") && reviewedMarkup.includes("Each video keeps its current trim") && reviewedMarkup.includes("Layout sketch") && reviewedMarkup.includes("data-preview-border") && reviewedMarkup.includes("data-preview-logo"));
  await applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId });
  const rows = await repo.listTemplatesForOwner("bob");
  const v1 = rows.find((row) => row.name === "v:v1")!.settings; const v2 = rows.find((row) => row.name === "v:v2")!.settings;
  for (const applied of [v1, v2]) assert.deepEqual([applied.zoom, applied.offsetX, applied.offsetY, applied.border, applied.background, applied.logo], [2.4, 0.3, -0.25, templateSettings.border, templateSettings.background, templateSettings.logo]);
  assert.deepEqual([v1.trim, v2.trim], [{ startSeconds: 0.05, endSeconds: 0.9 }, { startSeconds: 0.1, endSeconds: 0.7 }]);

  const copyReview = await reviewBulkEdit(ctxFor("bob"), { media: ["v1", "v2"], styleTemplateId: saved.templateId, copyTemplateTrim: "yes" });
  await applyBulkEdit(ctxFor("bob"), { draftId: copyReview.draftId });
  const copiedRows = await repo.listTemplatesForOwner("bob");
  assert.deepEqual([copiedRows.find((row) => row.name === "v:v1")!.settings.trim, copiedRows.find((row) => row.name === "v:v2")!.settings.trim], [templateSettings.trim, templateSettings.trim]);
});

test("bulk apply is atomic, audit failure rolls back every video, and retries/concurrent duplicates are idempotent", async () => {
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v1", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 1.25, offsetX: 0.1 } });
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v2", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 1.5, offsetY: -0.1 } });
  const before = await repo.listTemplatesForOwner("bob");
  const auditBefore = structuredClone(repo.audit);
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields({ use: ["zoom", "offsetX"], zoom: "2", offsetX: "0.4" }));
  repo.beforeBulkSettingsAuditInsert = () => false;
  await assert.rejects(() => applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId }));
  assert.deepEqual(await repo.listTemplatesForOwner("bob"), before);
  assert.deepEqual(repo.audit, auditBefore);
  assert.equal(repo.audit.some((entry) => entry.action === "editor.bulk_applied"), false);
  const { getBulkDraft } = await import("../src/server/bulk/bulk-service.ts");
  assert.equal(getBulkDraft(reviewed.draftId)?.videos.every((video) => video.applyStatus === "failed"), true);
  repo.beforeBulkSettingsAuditInsert = null;
  const [first, second] = await Promise.all([applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId }), applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId })]);
  assert.deepEqual([first.updated, second.updated], [2, 2]);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 2);
  assert.equal(repo.audit.filter((entry) => entry.action === "editor.bulk_applied").length, 1);
});

test("bulk confirmation rejects stale per-video settings instead of overwriting a concurrent editor save", async () => {
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields({ use: ["zoom"], zoom: "2" }));
  await saveCurrentVideoSettings(ctxFor("bob"), { mediaId: "v1", settings: { ...DEFAULT_EDITING_SETTINGS, zoom: 1.4 } });
  await assert.rejects(() => applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId }), (error: unknown) => error instanceof AppError && error.code === "conflict");
  assert.equal((await repo.listTemplatesForOwner("bob")).filter((row) => row.name === "v:v1")[0]!.settings.zoom, 1.4);
  assert.equal((await repo.listTemplatesForOwner("bob")).some((row) => row.name === "v:v2"), false);
  assert.equal(repo.audit.some((entry) => entry.action === "editor.bulk_applied"), false);
});

test("bulk: the plan's batch size is enforced and nothing is written", async () => {
  for (let i = 3; i <= 6; i++) repo.media.set(`v${i}`, makeMedia({ id: `v${i}`, ownerId: "bob", kind: "video", title: `V${i}`, width: 10, height: 10, durationMs: 1000, validation: "verified" }));
  const denied = await errorOf(reviewBulkEdit(ctxFor("bob"), fields({ media: ["v1", "v2", "v3", "v4", "v5", "v6"] })));
  assert.equal(denied.code, "plan_limit");
  assert.match(denied.message, /5 videos/);
  assert.equal((await repo.listTemplatesForOwner("bob")).length, 0);
});

test("bulk apply rechecks entitlement after a reviewed promotional batch expires", async () => {
  for (let i = 3; i <= 6; i++) repo.media.set(`v${i}`, makeMedia({ id: `v${i}`, ownerId: "bob", kind: "video", title: `V${i}`, width: 10, height: 10, durationMs: 1000, validation: "verified" }));
  const promo = {
    id: "promo-bulk", promotionId: "promotion-bulk", userId: "bob", redemptionId: null, kind: "tier_access" as const, activationPolicy: "immediate" as const, status: "active" as const, planId: "pro" as const,
    durationDays: 3, queueSequence: 1n, startsAt: new Date(NOW.getTime() - 1), expiresAt: new Date(NOW.getTime() + 60_000), activatedAt: new Date(NOW.getTime() - 1), revokedAt: null,
    grantedByAdminId: "admin", reason: null, createdAt: NOW, updatedAt: NOW,
  };
  repo.promotionalAccessGrants.set(promo.id, promo);
  const reviewed = await reviewBulkEdit(ctxFor("bob"), fields({ media: ["v1", "v2", "v3", "v4", "v5", "v6"] }));
  assert.equal(repo.promotionalAccessGrants.get(promo.id)?.status, "active");
  repo.promotionalAccessGrants.set(promo.id, { ...promo, status: "revoked", revokedAt: NOW, expiresAt: NOW });
  const denied = await errorOf(applyBulkEdit(ctxFor("bob"), { draftId: reviewed.draftId }));
  assert.equal(denied.code, "plan_limit");
  assert.match(denied.message, /current plan can edit 5 videos/);
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
  const page = renderToStaticMarkup(await EditorPage({ searchParams: Promise.resolve({ media: "v1" }) }));
  assert.ok(page.includes(">Undo</button>") && page.includes('href="/editor?media=v1"') && page.includes('href="/media/v1"') && page.includes("Save settings"));
  assert.ok(page.includes("not pixel-identical"));
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
