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

export async function getOwnedMediaDeletionPreview(ctx: RequestContext, rawMediaId: unknown): Promise<{ mediaId: string; title: string; collections: { id: string; name: string }[] }> {
  const ownerId = requireUser(ctx);
  if (typeof rawMediaId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rawMediaId)) throw new AppError(422, "invalid_media_id", "Select a valid media item.");
  const media = await ctx.repo.getMedia(rawMediaId);
  if (!media || media.ownerId !== ownerId || media.status === "deleted") throw notFound("File");
  const collections = await ctx.repo.listCollectionsContainingMedia(media.id);
  return { mediaId: media.id, title: media.title ?? "Untitled media", collections: collections.filter((collection) => collection.mediaIds.includes(media.id)).map(({ id, name }) => ({ id, name: name ?? "Untitled collection" })) };
}

export async function requestPermanentOwnedMediaDeletion(ctx: RequestContext, rawInput: unknown): Promise<{ mediaId: string; jobId: string; status: "queued" | "existing"; removedCollectionIds: string[] }> {
  const ownerId = requireUser(ctx); const problems = new Problems(); const input = readObject(rawInput, problems);
  if (Object.keys(input).some((key) => !["mediaId", "confirm", "expectedCollectionIds"].includes(key))) problems.add("The request contains unsupported fields.");
  const mediaId = readId(input, "mediaId", problems);
  if (input["confirm"] !== true) problems.add("Confirm permanent deletion first.");
  const rawCollections = input["expectedCollectionIds"];
  if (!Array.isArray(rawCollections) || rawCollections.length > 100 || rawCollections.some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) || (Array.isArray(rawCollections) && new Set(rawCollections).size !== rawCollections.length)) problems.add("Refresh the collection list before deleting this media.");
  problems.throwIfAny();
  const result = await ctx.repo.requestPermanentMediaDeletion({ id: ctx.newId(), mediaId, ownerId, expectedCollectionIds: rawCollections as string[], now: ctx.now });
  if (result.status === "missing" || result.status === "already_deleted") throw notFound("File");
  if (result.status === "collections_changed") throw conflict("This media's collection membership changed. Refresh and review the affected collections before confirming again.");
  if (result.status === "in_use") throw conflict("This media is used by a cycle, publishing job, or render. Remove it from those workflows before permanent deletion.");
  if (result.status === "cover_in_use") {
    const resources = result.dependencies.map(({ type, name }) => `${type === "collection" ? "collection" : "publishing cycle"} “${name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80) || "Untitled"}”`);
    const list = resources.length === 1 ? resources[0] : `${resources.slice(0, -1).join(", ")} and ${resources.at(-1)}`;
    throw conflict(`This media is still used as a cover by active ${list}. Change the cover in that resource before permanent deletion.`);
  }
  if (result.status === "import_in_progress") throw conflict("A media import is still using this file. Wait for it to finish before permanent deletion.");
  if (result.status === "conflict") throw conflict("The media deletion request conflicts with another change. Refresh and try again.");
  if (result.status !== "queued" && result.status !== "existing") throw conflict("The media deletion request could not be confirmed. Refresh and try again.");
  return { mediaId, jobId: result.job.id, status: result.status, removedCollectionIds: result.removedCollectionIds };
}
