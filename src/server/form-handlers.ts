// The concrete form routes: how each HTML form's fields become a handler input, and where the user goes next.
import { bulkUpdateCaptions, bulkUpdateCovers, type BulkUpdateReport } from "./handlers/captions-covers.ts";
import { createCollection, deleteCollection, replaceCollectionMedia, setCollectionArchived, updateCollection } from "./handlers/collections.ts";
import { createGrant, decideCollectionAccessRequest, requestCollectionAccess, revokeCollectionShareLink, revokeGrant, updateCollectionShareLink } from "./handlers/sharing.ts";
import { changeCycleStatus, createCycle, mixIntoCycle, saveCycleSchedule, selectCycleItemRenderOutput, setCycleRepeat, startPublishingCycle, unmixFromCycle } from "./handlers/cycles.ts";
import { editorCandidateFromFields } from "../lib/domain/editing-settings.ts";
import { applyBulkEdit, reviewBulkEdit, startBulkRender } from "./bulk/bulk-service.ts";
import { saveCurrentVideoSettings, saveEditingTemplate } from "./handlers/editor.ts";
import { requestSharedMediaImport, retrySharedMediaImport, scheduleOwnedMediaDeletion } from "./handlers/media-import.ts";
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
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", name: f.get("name") ?? "", description: f.get("description") ?? "", visibility: f.get("visibility") ?? "" }),
  success: (_r, f) => ({ path: collectionPath(f), code: "collection_updated" }),
  failurePath: collectionPath,
});

export const archiveCollectionForm = formRoute({
  handler: setCollectionArchived,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", archived: f.get("archived") === "yes", confirm: f.get("confirm") === "yes" }),
  success: (_r, f) => ({ path: collectionPath(f), code: f.get("archived") === "yes" ? "collection_archived" : "collection_restored" }),
  failurePath: collectionPath,
});

export const deleteCollectionForm = formRoute({
  handler: deleteCollection,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", confirm: f.get("confirm") === "yes" }),
  success: () => ({ path: "/collections", code: "collection_deleted" }),
  failurePath: collectionPath,
});

export const collectionMediaForm = formRoute({
  handler: replaceCollectionMedia,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", mediaIds: f.getAll("mediaIds") }),
  success: (_r, f) => ({ path: collectionPath(f), code: "collection_media_saved" }),
  failurePath: collectionPath,
});

export const requestSharedMediaImportForm = formRoute({
  handler: requestSharedMediaImport,
  toInput: (f) => ({ sourceMediaId: f.get("sourceMediaId") ?? "", sourceCollectionId: f.get("sourceCollectionId") ?? "", warningAcknowledged: f.get("warningAcknowledged") === "yes" }),
  success: (r, f) => ({ path: `/collections/${safeId(f.get("sourceCollectionId")) ?? ""}`, code: r.status === "existing" ? "media_import_exists" : "media_import_queued" }),
  failurePath: (f) => `/collections/${safeId(f.get("sourceCollectionId")) ?? ""}`,
});

export const retrySharedMediaImportForm = formRoute({
  handler: retrySharedMediaImport,
  toInput: (f) => ({ jobId: f.get("jobId") ?? "" }),
  success: (r) => ({ path: `/collections/${r.collectionId}`, code: "media_import_queued" }),
  failurePath: (f) => `/collections/${safeId(f.get("collectionId")) ?? ""}`,
});

export const scheduleMediaDeletionForm = formRoute({
  handler: scheduleOwnedMediaDeletion,
  toInput: (f) => ({ mediaId: f.get("mediaId") ?? "", confirm: f.get("confirm") === "yes" }),
  success: (r) => ({ path: `/media/${r.mediaId}`, code: "media_deletion_scheduled" }),
  failurePath: (f) => `/media/${safeId(f.get("mediaId")) ?? ""}`,
});

export const collectionGrantForm = formRoute({
  handler: createGrant,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", granteeId: f.get("granteeId") ?? "", capabilities: f.getAll("capabilities"), expiresAt: f.get("expiresAt") || null }),
  success: (_r, f) => ({ path: collectionPath(f), code: "sharing_grant_created" }),
  failurePath: collectionPath,
});

export const collectionRevokeGrantForm = formRoute({
  handler: revokeGrant,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", granteeId: f.get("granteeId") ?? "" }),
  success: (_r, f) => ({ path: collectionPath(f), code: "sharing_grant_revoked" }),
  failurePath: collectionPath,
});

export const collectionAccessRequestForm = formRoute({
  handler: requestCollectionAccess,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", requestedCapabilities: f.getAll("requestedCapabilities") }),
  success: (r) => ({ path: "/collections", code: r.status === "existing" ? "access_request_existing" : "access_request_created" }),
  failurePath: () => "/collections",
});

export const collectionAccessRequestDecisionForm = formRoute({
  handler: decideCollectionAccessRequest,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", requestId: f.get("requestId") ?? "", decision: f.get("decision") ?? "" }),
  success: (r, f) => ({ path: collectionPath(f), code: r.status === "approved" ? "access_request_approved" : "access_request_rejected" }),
  failurePath: collectionPath,
});

export const collectionShareLinkUpdateForm = formRoute({
  handler: updateCollectionShareLink,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", shareLinkId: f.get("shareLinkId") ?? "", capabilities: f.getAll("capabilities"), expiresAt: f.get("expiresAt") || null }),
  success: (_r, f) => ({ path: collectionPath(f), code: "share_link_updated" }),
  failurePath: collectionPath,
});

export const collectionShareLinkRevokeForm = formRoute({
  handler: revokeCollectionShareLink,
  toInput: (f) => ({ collectionId: f.get("collectionId") ?? "", shareLinkId: f.get("shareLinkId") ?? "" }),
  success: (r, f) => ({ path: collectionPath(f), code: r.status === "already_revoked" ? "share_link_already_revoked" : "share_link_revoked" }),
  failurePath: collectionPath,
});

export const createCycleForm = formRoute({
  handler: createCycle,
  toInput: (f) => ({ name: f.get("name") ?? "", socialAccountId: f.get("socialAccountId") ?? "" }),
  success: (r) => ({ path: `/cycles/${r.cycleId}`, code: "cycle_created" }),
  failurePath: () => "/cycles",
});

export const cycleRepeatForm = formRoute({
  handler: setCycleRepeat,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", repeatBehavior: f.get("repeatBehavior") ?? "" }),
  success: (_r, f) => ({ path: cyclePath(f), code: "cycle_repeat_saved" }),
  failurePath: cyclePath,
});

export const startCycleForm = formRoute({
  handler: startPublishingCycle,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", confirmFinalReview: f.get("confirmFinalReview") === "yes" }),
  success: (_r, f) => ({ path: cyclePath(f), code: "cycle_started" }),
  failurePath: cyclePath,
});

export const cycleStatusForm = formRoute({
  handler: changeCycleStatus,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", action: f.get("action") ?? "", confirmStop: f.get("confirmStop") === "yes" }),
  success: (r) => ({ path: "/dashboard", code: r.status === "paused" ? "cycle_paused" : r.status === "running" ? "cycle_resumed" : "cycle_stopped" }),
  failurePath: () => "/dashboard",
});

export const cycleScheduleForm = formRoute({
  handler: saveCycleSchedule,
  toInput: (f) => ({
    cycleId: f.get("cycleId") ?? "", startDate: f.get("startDate") ?? "", timeZone: f.get("timeZone") ?? "",
    windowStart: f.get("windowStart") ?? "", windowEnd: f.get("windowEnd") ?? "",
    intervalMinutes: Number(f.get("intervalMinutes")), postsPerInterval: Number(f.get("postsPerInterval")),
    daysOfWeek: f.getAll("daysOfWeek").map((day) => Number(day)), dailyMax: f.get("dailyMax") === "" ? null : Number(f.get("dailyMax")),
    endDate: f.get("endDate") === "" ? null : f.get("endDate"),
  }),
  success: (r, f) => ({ path: cyclePath(f), code: "cycle_schedule_saved", counts: { updated: r.scheduled, skipped: r.unscheduled } }),
  failurePath: cyclePath,
});

export const cycleRenderOutputForm = formRoute({
  handler: selectCycleItemRenderOutput,
  toInput: (f) => ({ cycleId: f.get("cycleId") ?? "", itemId: f.get("itemId") ?? "", renderOutputId: f.get("renderOutputId") ?? "", expectedVersion: Number(f.get("expectedVersion")) }),
  success: (r, f) => ({ path: cyclePath(f), code: r.selected ? "cycle_render_output_saved" : "cycle_render_output_cleared" }),
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
  logoWidth: f.get("logoWidth") ?? "", logoOpacity: f.get("logoOpacity") ?? "", styleTemplateId: f.get("styleTemplateId") ?? "", copyTemplateTrim: f.get("copyTemplateTrim") === "yes" ? "yes" : "", draftId: f.get("draft") ?? "",
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
  failureExtra: (f) => { const draft = safeId(f.get("draft")); return draft ? { draft } : {}; },
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
