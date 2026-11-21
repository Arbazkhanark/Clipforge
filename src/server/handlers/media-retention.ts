import { requireUser, type RequestContext } from "../context.ts";
import { AppError } from "../errors.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export type RetentionStatus = "available" | "queued" | "processing" | "deleted" | "failed" | "unavailable";
type RetentionResult = { mediaId: string; status: "queued" | "existing" | "blocked" | "unknown"; message: string };

/** Read-only, owner-scoped reconciliation for the retention choice and cleanup lifecycle. */
export async function getEditedMediaRetentionStatus(ctx: RequestContext, rawMediaId: unknown, rawOutputId: unknown): Promise<{ mediaId: string; outputId: string; status: RetentionStatus; message: string }> {
  const ownerId = requireUser(ctx);
  if (typeof rawMediaId !== "string" || !ID.test(rawMediaId) || typeof rawOutputId !== "string" || !ID.test(rawOutputId)) throw new AppError(422, "invalid_retention_status_request", "Choose a valid edited video.");
  const [original, output, jobs] = await Promise.all([
    ctx.repo.getMedia(rawMediaId), ctx.repo.getRenderOutput(rawOutputId), ctx.repo.listRenderJobsForOwner(ownerId),
  ]);
  if (!original || original.ownerId !== ownerId || original.kind !== "video" || !output || output.ownerId !== ownerId || output.sourceMediaId !== original.id) throw new AppError(404, "not_found", "Edited video was not found.");
  if (!jobs.some((job) => job.status === "succeeded" && job.mediaAssetId === original.id && job.outputDerivativeId === output.id)) throw new AppError(404, "not_found", "Edited video was not found.");
  if (!ctx.media || ctx.media.unavailable) throw new AppError(503, "retention_status_unavailable", "The edited video status could not be verified right now.");
  const outputSize = await ctx.media.storage.statSize(output.storageKey);
  if (outputSize === null || outputSize !== output.sizeBytes) throw new AppError(404, "not_found", "Edited video was not found.");

  const replacement = await ctx.repo.getEditedMediaReplacementForOwner(ownerId, original.id, output.id);
  if (replacement && replacement.status !== "completed") {
    const processing = replacement.status === "copying" || replacement.status === "verifying";
    return { mediaId: original.id, outputId: output.id, status: processing ? "processing" : replacement.status === "failed" || replacement.status === "blocked" ? "failed" : "queued", message: processing ? "The edited video is being copied and verified. The original is still kept." : replacement.status === "failed" || replacement.status === "blocked" ? "The edited video could not be safely promoted. The original and its collections are still kept." : "The edited video replacement is queued. The original is still kept." };
  }
  const cleanup = await ctx.repo.getMediaCleanupJobForOwner(ownerId, original.id);
  if (cleanup?.status === "queued") return { mediaId: original.id, outputId: output.id, status: "queued", message: "Original deletion is queued; storage cleanup has not completed." };
  if (cleanup?.status === "running") return { mediaId: original.id, outputId: output.id, status: "processing", message: "Original storage cleanup is in progress." };
  if (cleanup?.status === "succeeded") return { mediaId: original.id, outputId: output.id, status: "deleted", message: "Original storage cleanup is complete." };
  if (cleanup?.status === "failed") return { mediaId: original.id, outputId: output.id, status: "failed", message: "Original cleanup needs attention." };
  if (original.status === "deleted") return { mediaId: original.id, outputId: output.id, status: "deleted", message: "Original is marked deleted; cleanup status is unavailable." };
  if (original.status !== "active" || original.validation !== "verified") return { mediaId: original.id, outputId: output.id, status: "unavailable", message: "The original is not eligible for replacement because it is not an active verified video." };
  return { mediaId: original.id, outputId: output.id, status: "available", message: "No original deletion request is recorded. The original remains available." };
}

/**
 * Queue a durable replacement. The existing cleanup worker removes the original object
 * only after the replacement has passed normal media verification and membership transfer.
 */
export async function requestEditedMediaRetention(ctx: RequestContext, raw: unknown): Promise<{ results: RetentionResult[] }> {
  const ownerId = requireUser(ctx);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError(422, "invalid_retention_request", "Choose the edited videos to keep.");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "confirm" && key !== "items") || input.confirm !== true || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
    throw new AppError(422, "invalid_retention_request", "Confirm the original-video deletion request.");
  }
  const seen = new Set<string>();
  const pairs: { mediaId: string; outputId: string }[] = [];
  for (const value of input.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(422, "invalid_retention_request", "The edited-video selection is not valid.");
    const pair = value as Record<string, unknown>;
    if (Object.keys(pair).some((key) => key !== "mediaId" && key !== "outputId") || typeof pair.mediaId !== "string" || !ID.test(pair.mediaId) || typeof pair.outputId !== "string" || !ID.test(pair.outputId) || seen.has(pair.mediaId)) {
      throw new AppError(422, "invalid_retention_request", "The edited-video selection is not valid.");
    }
    seen.add(pair.mediaId);
    pairs.push({ mediaId: pair.mediaId, outputId: pair.outputId });
  }

  const results: RetentionResult[] = [];
  for (const pair of pairs) {
    try {
      const original = await ctx.repo.getMedia(pair.mediaId);
      const output = await ctx.repo.getRenderOutput(pair.outputId);
      if (!original || original.ownerId !== ownerId || original.kind !== "video" || !output || output.ownerId !== ownerId || output.sourceMediaId !== original.id) {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: "The original and its completed edited version could not both be verified. The original was kept." });
        continue;
      }
      // A derivative record alone is not proof that the specific render operation
      // completed: failed or superseded renders may leave an output record behind.
      // Require the durable render job to confirm this exact owner/source/output link.
      const renderJobs = await ctx.repo.listRenderJobsForOwner(ownerId);
      const completedRender = renderJobs.some((job) =>
        job.status === "succeeded" && job.mediaAssetId === original.id && job.outputDerivativeId === output.id,
      );
      if (!completedRender) {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: "A completed render for this edited version could not be verified. The original was kept." });
        continue;
      }
      if (!ctx.media || ctx.media.unavailable) {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: "Private media storage is unavailable, so the original was kept." });
        continue;
      }
      const outputSize = await ctx.media.storage.statSize(output.storageKey);
      if (outputSize === null || outputSize !== output.sizeBytes) {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: "The edited version could not be verified in storage. The original was kept." });
        continue;
      }

      const priorReplacement = await ctx.repo.getEditedMediaReplacementForOwner(ownerId, original.id, output.id);
      if (original.status === "deleted" && !priorReplacement) {
        const cleanup = await ctx.repo.getMediaCleanupJobForOwner(ownerId, original.id);
        results.push({ mediaId: pair.mediaId, status: cleanup ? "existing" : "blocked", message: cleanup ? "Original cleanup was already requested. No new action was submitted." : "The original is already deleted and no replacement request is recorded." });
        continue;
      }

      if (ctx.media.storage.kind === "memory") {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: "Original replacement requires persistent private storage. The original was kept." });
        continue;
      }
      const replacement = await ctx.repo.createOrGetEditedMediaReplacement({
        id: ctx.newId(), ownerId, sourceMediaAssetId: original.id, sourceDerivativeId: output.id,
        plannedReplacementMediaAssetId: ctx.newId(), idempotencyKey: `edited-replacement:${ownerId}:${original.id}:${output.id}`, now: ctx.now,
      });
      if (replacement.status !== "created" && replacement.status !== "existing") {
        const message = replacement.status === "quota" ? "There is not enough storage to create a verified edited copy. The original was kept." : replacement.status === "dependency" ? "An active publishing, import, render, or cover dependency blocks replacement. The original was kept." : replacement.status === "not_verified" ? "The original has not passed verification. The original was kept." : "The edited replacement could not be safely queued. The original was kept.";
        results.push({ mediaId: pair.mediaId, status: "blocked", message });
        continue;
      }
      results.push({
        mediaId: pair.mediaId,
        status: replacement.status === "created" ? "queued" : "existing",
        message: replacement.job.status === "completed" ? "The edited video replaced the original in its collections. Original cleanup is handled by private storage cleanup." : replacement.status === "created" ? "Replacement queued. The original stays available until its edited copy is verified and its collection memberships are transferred." : "This replacement request already exists. The original stays available until safe replacement finishes.",
      });
    } catch (error) {
      if (error instanceof AppError && error.status < 500) {
        results.push({ mediaId: pair.mediaId, status: "blocked", message: error.message });
      } else {
        // Keep this operation's failure isolated; never return internal storage/database details.
        // The database may have committed before a later operation failed. The client
        // must reconcile this state instead of claiming that the original was kept.
        results.push({ mediaId: pair.mediaId, status: "unknown", message: "The request result could not be confirmed." });
      }
    }
  }
  return { results };
}
