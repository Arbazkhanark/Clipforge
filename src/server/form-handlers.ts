// The concrete form routes: how each HTML form's fields become a handler input, and where the user goes next.
import { bulkUpdateCaptions, bulkUpdateCovers, type BulkUpdateReport } from "./handlers/captions-covers.ts";
import { createCycle, mixIntoCycle, startPublishingCycle, unmixFromCycle } from "./handlers/cycles.ts";
import { formRoute, safeId, type FormFields } from "./form-routes.ts";

const cyclePath = (f: FormFields): string => { const id = safeId(f.get("cycleId")); return id ? `/cycles/${id}` : "/cycles"; };

/** Item versions the user saw, from hidden fields named "version.<itemId>". Built without a prototype. */
function readVersions(f: FormFields): Record<string, number> {
  const versions: Record<string, number> = Object.create(null);
  for (const [name, value] of f.entries()) if (name.startsWith("version.")) versions[name.slice(8)] = Number(value);
  return versions;
}
const targetFrom = (f: FormFields) => (f.get("scope") === "all" ? { kind: "all_upcoming" } : { kind: "selected", itemIds: f.getAll("itemIds") });
const bulkCounts = (r: BulkUpdateReport) => ({ updated: r.summary.updated, skipped: r.summary.skipped, conflicts: r.summary.conflicts, confirm: r.summary.needsConfirmation });

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
