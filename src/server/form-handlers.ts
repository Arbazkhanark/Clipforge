// The concrete form routes: how each HTML form's fields become a handler input, and where the user goes next.
import { bulkUpdateCaptions, bulkUpdateCovers, type BulkUpdateReport } from "./handlers/captions-covers.ts";
import { createCollection, replaceCollectionMedia, updateCollection } from "./handlers/collections.ts";
import { createCycle, mixIntoCycle, startPublishingCycle, unmixFromCycle } from "./handlers/cycles.ts";
import { editorCandidateFromFields } from "../lib/domain/editing-settings.ts";
import { applyBulkEdit, reviewBulkEdit, startBulkRender } from "./bulk/bulk-service.ts";
import { saveCurrentVideoSettings, saveEditingTemplate } from "./handlers/editor.ts";
import { startExport } from "./render/export-service.ts";
import { formRoute, safeId, type FormFields } from "./form-routes.ts";

const cyclePath = (f: FormFields): string => { const id = safeId(f.get("cycleId")); return id ? `/cycles/${id}` : "/cycles"; };
const collectionPath = (f: FormFields): string => { const id = safeId(f.get("collectionId")); return id ? `/collections/${id}` : "/collections"; };

/** Item versions the user saw, from hidden fields named "version.<itemId>". Built without a prototype. */
function readVersions(f: FormFields): Record<string, number> {
  const versions: Record<string, number> = Object.create(null);
  for (const [name, value] of f.entries()) if (name.startsWith("version.")) versions[name.slice(8)] = Number(value);
  return versions;
}
const targetFrom = (f: FormFields) => (f.get("scope") === "all" ? { kind: "all_upcoming" } : { kind: "selected", itemIds: f.getAll("itemIds") });
const bulkCounts = (r: BulkUpdateReport) => ({ updated: r.summary.updated, skipped: r.summary.skipped, conflicts: r.summary.conflicts, confirm: r.summary.needsConfirmation });

export const createCollectionForm = formRoute({
  handler: createCollection,
  toInput: (f) => ({ name: f.get("name") ?? "", description: f.get("description") ?? "", visibility: f.get("visibility") ?? "private", mediaIds: f.getAll("mediaIds") }),
  success: (r) => ({ path: `/collections/${r.collectionId}`, code: "collection_created" }),
  failurePath: () => "/collections",
});

export const updateCollectionForm = formRoute({
  handler: updateCollection,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", name: f.get("name") ?? "", description: f.get("description") ?? "", visibility: f.get("visibility") ?? "", archived: f.get("archived") === "yes" }),
  success: (_r, f) => ({ path: collectionPath(f), code: "collection_updated" }),
  failurePath: collectionPath,
});

export const collectionMediaForm = formRoute({
  handler: replaceCollectionMedia,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", mediaIds: f.getAll("mediaIds") }),
  success: (_r, f) => ({ path: collectionPath(f), code: "collection_media_saved" }),
  failurePath: collectionPath,
});

export const createCycleForm = formRoute({
  handler: createCycle,
  toInput: (f) => ({ name: f.get("name") ?? "", socialAccountId: f.get("socialAccountId") ?? "" }),
  success: (r) => ({ path: `/cycles/${r.cycleId}`, code: "cycle_created" }),
  failurePath: () => "/cycles",
});

export const startCycleForm = formRoute({
  handler: startPublishingCycle,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", confirmFinalReview: f.get("confirmFinalReview") === "yes" }),
  success: (_r, f) => ({ path: cyclePath(f), code: "cycle_started" }),
  failurePath: cyclePath,
});

export const captionsForm = formRoute({
  handler: bulkUpdateCaptions,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", target: targetFrom(f), caption: f.get("caption") ?? "", overwriteCustomConfirmed: f.get("overwriteCustomConfirmed") === "yes", expectedVersions: readVersions(f) }),
  success: (r, f) => ({ path: cyclePath(f), code: "captions_applied", counts: bulkCounts(r) }),
  failurePath: cyclePath,
});

export const coversForm = formRoute({
  handler: bulkUpdateCovers,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", target: targetFrom(f), coverMediaId: f.get("coverMediaId") ?? "", overwriteCustomConfirmed: f.get("overwriteCustomConfirmed") === "yes", expectedVersions: readVersions(f) }),
  success: (r, f) => ({ path: cyclePath(f), code: "covers_applied", counts: bulkCounts(r) }),
  failurePath: cyclePath,
});

export const unmixForm = formRoute({
  handler: unmixFromCycle,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", itemIds: f.getAll("itemIds") }),
  success: (r, f) => ({ path: cyclePath(f), code: "videos_removed", counts: { removed: r.removedItemIds.length, blocked: r.blocked.length } }),
  failurePath: cyclePath,
});

/** Each ticked video is "collectionId|mediaId"; anything else becomes an invalid entry the handler rejects. */
export const mixForm = formRoute({
  handler: mixIntoCycle,
  toInput: (f) => ({
    cycleId: f.get("cycleId") ?? "",
    videos: f.getAll("video").map((v) => { const [collectionId = "", mediaAssetId = ""] = v.split("|"); return { collectionId, mediaAssetId }; }),
  }),
  success: (r, f) => ({ path: cyclePath(f), code: "videos_added", counts: { added: r.added, rejected: r.rejected.length } }),
  failurePath: (f) => { const c = safeId(f.get("collectionId")); return c ? `/collections/${c}` : cyclePath(f); },
});

const editorExtra = (f: FormFields) => { const media = safeId(f.get("media")); return media ? { media } : {}; };

/** Renders a new file from the current editor settings. The original media is not touched. */
export const renderExportForm = formRoute({
  handler: startExport,
  toInput: (f) => ({ mediaId: f.get("media") ?? "", templateId: f.get("template") ?? "", useTemplate: f.get("useTemplate") === "yes", settings: editorCandidateFromFields((k) => f.get(k) ?? undefined, () => Number.NaN) }),
  success: (r, f) => ({ path: "/editor", code: "render_queued", extra: { ...editorExtra(f), job: r.jobId } }),
  failurePath: () => "/editor",
  failureExtra: editorExtra,
});

/** Saves the current editor settings onto this video only. */
export const editorSettingsForm = formRoute({
  handler: saveCurrentVideoSettings,
  toInput: (f) => ({ mediaId: f.get("media") ?? "", settings: editorCandidateFromFields((k) => f.get(k) ?? undefined, () => Number.NaN) }),
  success: (_r, f) => ({ path: "/editor", code: "settings_saved", extra: editorExtra(f) }),
  failurePath: () => "/editor",
  failureExtra: editorExtra,
});

const bulkFields = (f: FormFields) => ({
  media: f.getAll("media"), use: f.getAll("use"), aspect: f.get("aspect") ?? "", bg: f.get("bg") ?? "", bgColor: f.get("bgColor") ?? "", bgImage: f.get("bgImage") ?? "",
  blur: f.get("blur") ?? "", zoom: f.get("zoom") ?? "", offsetX: f.get("offsetX") ?? "", offsetY: f.get("offsetY") ?? "", borderOn: f.get("borderOn") ?? "",
  borderColor: f.get("borderColor") ?? "", borderPx: f.get("borderPx") ?? "", logoMedia: f.get("logoMedia") ?? "", logoX: f.get("logoX") ?? "", logoY: f.get("logoY") ?? "",
  logoWidth: f.get("logoWidth") ?? "", logoOpacity: f.get("logoOpacity") ?? "", draftId: f.get("draft") ?? "",
});

export const bulkReviewForm = formRoute({
  handler: reviewBulkEdit,
  toInput: bulkFields,
  success: (r) => ({ path: "/editor/bulk", code: "bulk_review", extra: { draft: r.draftId } }),
  failurePath: () => "/editor/bulk",
});

export const bulkApplyForm = formRoute({
  handler: applyBulkEdit,
  toInput: (f) => ({ draftId: f.get("draft") ?? "" }),
  success: (r) => ({ path: "/editor/bulk", code: "bulk_applied", counts: { updated: r.updated, skipped: r.skipped }, extra: { draft: r.draftId } }),
  failurePath: () => "/editor/bulk",
});

export const bulkRenderForm = formRoute({
  handler: startBulkRender,
  toInput: (f) => ({ draftId: f.get("draft") ?? "" }),
  success: (r) => ({ path: "/editor/batch", code: "renders_queued", extra: { batch: r.batchId } }),
  failurePath: () => "/editor/bulk",
});

/** Saves the editor's current settings as a template. The original media is not touched. */
export const editorSaveForm = formRoute({
  handler: saveEditingTemplate,
  toInput: (f) => ({ name: f.get("name") ?? "", settings: editorCandidateFromFields((k) => f.get(k) ?? undefined, () => NaN) }), // a non-number becomes NaN, which the strict parser refuses
  success: (r, f) => ({ path: "/editor", code: r.created ? "template_saved" : "template_exists", extra: editorExtra(f) }),
  failurePath: () => "/editor",
  failureExtra: editorExtra,
});
