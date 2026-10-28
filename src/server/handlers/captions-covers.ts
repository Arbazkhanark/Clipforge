// Bulk caption and cover updates for a publishing cycle.
// Order of every handler: sign-in -> validate input -> load -> OWNERSHIP check -> plan check -> business rule
// -> version-checked save -> audit log -> honest per-item report.
import { applyBulkCaptionUpdate, applyBulkCoverUpdate, type ItemResult } from "../../lib/domain/caption-cover-updates.ts";
import type { CycleItem } from "../../lib/domain/types.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { notFound, validationFailed } from "../errors.ts";
import { Problems, readBoolean, readId, readObject, readTarget, readText, readVersionMap } from "../validation.ts";

export interface BulkUpdateReport {
  results: ItemResult[];
  summary: { updated: number; skipped: number; conflicts: number; needsConfirmation: number };
  /** Cover updates only: says plainly whether Instagram will receive the cover. */
  warning?: string | null;
}

/** Loads a cycle the signed-in user OWNS. Someone else's cycle looks exactly like a missing one. */
async function loadOwnedCycle(ctx: RequestContext, userId: string, cycleId: string) {
  const cycle = await ctx.repo.getCycle(cycleId);
  if (!cycle || cycle.ownerId !== userId) throw notFound("Publishing cycle");
  return cycle;
}

/** Saves changed items with a version check; anything that lost a race is reported as a conflict, not overwritten. */
async function saveWithVersionCheck(ctx: RequestContext, before: CycleItem[], after: CycleItem[], results: ItemResult[]): Promise<{ results: ItemResult[]; savedIds: Set<string> }> {
  const beforeById = new Map(before.map((i) => [i.id, i]));
  const updatedIds = new Set(results.filter((r) => r.outcome === "updated").map((r) => r.itemId));
  const updates = after.filter((i) => updatedIds.has(i.id)).map((item) => ({ item, expectedVersion: (beforeById.get(item.id) as CycleItem).version }));
  const saveResults = updates.length > 0 ? await ctx.repo.saveCycleItemsIfVersionMatches(updates) : [];
  const savedIds = new Set(saveResults.filter((r) => r.saved).map((r) => r.itemId));
  const finalResults = results.map((r): ItemResult =>
    r.outcome === "updated" && !savedIds.has(r.itemId) ? { itemId: r.itemId, outcome: "conflict", reason: "Changed by someone else while saving. Reload and try again." } : r);
  return { results: finalResults, savedIds };
}

const summarise = (results: ItemResult[]): BulkUpdateReport["summary"] => ({
  updated: results.filter((r) => r.outcome === "updated").length,
  skipped: results.filter((r) => r.outcome === "skipped").length,
  conflicts: results.filter((r) => r.outcome === "conflict").length,
  needsConfirmation: results.filter((r) => r.outcome === "needs_overwrite_confirmation").length,
});

export async function bulkUpdateCaptions(ctx: RequestContext, rawInput: unknown): Promise<BulkUpdateReport> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const target = readTarget(input, problems);
  const caption = readText(input, "caption", problems, { max: 20_000 });
  const overwriteCustomConfirmed = readBoolean(input, "overwriteCustomConfirmed", problems, false);
  const expectedVersions = readVersionMap(input, "expectedVersions", problems, 500);
  problems.throwIfAny();

  await loadOwnedCycle(ctx, userId, cycleId);
  const items = await ctx.repo.getCycleItems(cycleId);

  const outcome = applyBulkCaptionUpdate({ items, target, newCaption: caption, overwriteCustomConfirmed, expectedVersions, changedBy: userId, now: ctx.now });
  if (!outcome.ok) throw validationFailed(outcome.problems);

  const saved = await saveWithVersionCheck(ctx, items, outcome.items, outcome.results);
  // Only items that were REALLY saved get a revision record.
  await ctx.repo.saveCaptionRevisions(outcome.revisions.filter((r) => saved.savedIds.has(r.itemId)));
  const summary = summarise(saved.results);
  await ctx.repo.appendAudit({ actorId: userId, action: "caption.bulk_update", entityType: "PublishingCycle", entityId: cycleId, metadata: { ...summary, captionLength: caption.length, target: target.kind } });
  return { results: saved.results, summary };
}

export async function bulkUpdateCovers(ctx: RequestContext, rawInput: unknown): Promise<BulkUpdateReport> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const target = readTarget(input, problems);
  const coverMediaId = readId(input, "coverMediaId", problems);
  const overwriteCustomConfirmed = readBoolean(input, "overwriteCustomConfirmed", problems, false);
  const expectedVersions = readVersionMap(input, "expectedVersions", problems, 500);
  problems.throwIfAny();

  await loadOwnedCycle(ctx, userId, cycleId);
  const coverMedia = await ctx.repo.getMedia(coverMediaId);
  // For now a cover must be an active file the user OWNS. (Using shared images as covers is a later decision.)
  const userMayUseCoverMedia = coverMedia !== null && coverMedia.ownerId === userId && coverMedia.status === "active";
  const items = await ctx.repo.getCycleItems(cycleId);

  const outcome = applyBulkCoverUpdate({ items, target, newCoverMediaId: coverMediaId, overwriteCustomConfirmed, expectedVersions, userMayUseCoverMedia, coverSupport: ctx.config.coverSupport });
  if (!outcome.ok) throw validationFailed(outcome.problems);

  const saved = await saveWithVersionCheck(ctx, items, outcome.items, outcome.results);
  const summary = summarise(saved.results);
  await ctx.repo.appendAudit({ actorId: userId, action: "cover.bulk_update", entityType: "PublishingCycle", entityId: cycleId, metadata: { ...summary, coverMediaId, target: target.kind } });
  return { results: saved.results, summary, warning: outcome.warning };
}
