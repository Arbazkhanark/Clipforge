import { buildImportIdempotencyKey } from "../../lib/domain/media-lifecycle.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, notFound, planLimit } from "../errors.ts";
import { Problems, readId, readObject } from "../validation.ts";

export async function requestSharedMediaImport(ctx: RequestContext, rawInput: unknown): Promise<{ jobId: string; status: "pending" | "existing" }> {
  const importerId = requireUser(ctx);
  if (!ctx.durableMediaImports) throw new AppError(503, "durable_import_unavailable", "Imports require the configured persistent database and private storage.");
  const problems = new Problems(); const input = readObject(rawInput, problems);
  if (Object.keys(input).some((key) => !["sourceMediaId", "sourceCollectionId", "warningAcknowledged"].includes(key))) problems.add("The request contains unsupported fields.");
  const sourceMediaId = readId(input, "sourceMediaId", problems); const sourceCollectionId = readId(input, "sourceCollectionId", problems);
  if (input["warningAcknowledged"] !== true) problems.add("Confirm the import warning before continuing.");
  problems.throwIfAny();
  // Resolve the current plan first so queued promotional access is activated using the
  // repository's established entitlement rules; the quota itself is rechecked atomically inside it.
  await ctx.repo.getPlanIdForUser(importerId, ctx.now);
  const result = await ctx.repo.createOrGetMediaImportJob({ id: ctx.newId(), importerId, sourceMediaId, sourceCollectionId, resultMediaAssetId: ctx.newId(), idempotencyKey: buildImportIdempotencyKey(importerId, sourceMediaId), now: ctx.now });
  if (result.status === "not_found") throw notFound("Shared video");
  if (result.status === "unauthorized") throw notFound("Shared video");
  if (result.status === "quota") throw planLimit("There is not enough storage available for this import.");
  if (result.status === "conflict") throw conflict("This import request conflicts with an existing import.");
  if (result.status !== "created" && result.status !== "existing") throw conflict("This import request could not be recorded.");
  return { jobId: result.job.id, status: result.status === "existing" ? "existing" : "pending" };
}

export async function retrySharedMediaImport(ctx: RequestContext, rawInput: unknown): Promise<{ jobId: string; collectionId: string; status: "pending" }> {
  const importerId = requireUser(ctx);
  if (!ctx.durableMediaImports) throw new AppError(503, "durable_import_unavailable", "Imports require the configured persistent database and private storage.");
  const problems = new Problems(); const input = readObject(rawInput, problems);
  if (Object.keys(input).some((key) => key !== "jobId")) problems.add("The request contains unsupported fields.");
  const jobId = readId(input, "jobId", problems); problems.throwIfAny();
  const job = await ctx.repo.getMediaImportJobForOwner(importerId, jobId); if (!job) throw notFound("Import job");
  if (job.status !== "failed") throw conflict("Only a failed import can be retried.");
  if (!(await ctx.repo.retryMediaImportJob(importerId, jobId, ctx.now))) throw conflict("The import changed before it could be retried.");
  return { jobId, collectionId: job.sourceCollectionId, status: "pending" };
}

export async function scheduleOwnedMediaDeletion(ctx: RequestContext, rawInput: unknown): Promise<{ mediaId: string; deleteAfter: string }> {
  const ownerId = requireUser(ctx); const problems = new Problems(); const input = readObject(rawInput, problems);
  if (Object.keys(input).some((key) => !["mediaId", "confirm"].includes(key))) problems.add("The request contains unsupported fields.");
  const mediaId = readId(input, "mediaId", problems); if (input["confirm"] !== true) problems.add("Confirm the removal request first."); problems.throwIfAny();
  const result = await ctx.repo.scheduleMediaDeletion({ mediaId, ownerId, now: ctx.now, graceDays: 7 });
  if (result === "missing") throw notFound("File");
  if (result === "import_pending") throw conflict("A recipient import is still pending. Wait until it completes before scheduling removal.");
  if (result === "already_pending") throw conflict("This file is already scheduled for removal.");
  const media = await ctx.repo.getMedia(mediaId);
  if (!media?.deleteAfter) throw new AppError(500, "deletion_state_unavailable", "The removal schedule could not be verified.");
  return { mediaId, deleteAfter: media.deleteAfter.toISOString() };
}
