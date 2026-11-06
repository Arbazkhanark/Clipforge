// Creating and editing collections. The signed-in user is the only owner these writes accept.
// Someone else's collection looks missing. Media that the user does not own is refused.
import { COLLECTION_VISIBILITIES, type CollectionVisibility, type VideoCollection } from "../../lib/domain/types.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { conflict, notFound } from "../errors.ts";
import { Problems, readBoolean, readId, readIdList, readObject, readText } from "../validation.ts";

function readVisibility(source: Record<string, unknown>, problems: Problems): CollectionVisibility {
  const value = source["visibility"];
  if (typeof value !== "string" || !(COLLECTION_VISIBILITIES as readonly string[]).includes(value)) {
    problems.add("visibility must be private, link, or public_view.");
    return "private";
  }
  return value as CollectionVisibility;
}

function readDescription(source: Record<string, unknown>, problems: Problems): string | null {
  if (source["description"] === undefined || source["description"] === null) return null;
  const text = readText(source, "description", problems, { max: 500 }).trim();
  return text.length > 0 ? text : null;
}

async function ownedMediaIds(ctx: RequestContext, userId: string, mediaIds: string[]): Promise<void> {
  for (const mediaId of mediaIds) {
    const media = await ctx.repo.getMedia(mediaId);
    if (!media || media.ownerId !== userId || media.status === "deleted") throw notFound("File");
  }
}

async function ownedCollection(ctx: RequestContext, userId: string, collectionId: string): Promise<VideoCollection> {
  const collection = await ctx.repo.getCollection(collectionId);
  if (!collection || collection.ownerId !== userId) throw notFound("Collection");
  return collection;
}

export async function createCollection(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 }).trim();
  const description = readDescription(input, problems);
  const visibility = readVisibility(input, problems);
  const mediaIds = readIdList(input, "mediaIds", problems, { max: 200 });
  if (new Set(mediaIds).size !== mediaIds.length) problems.add("Each file can be added only once.");
  problems.throwIfAny();

  await ownedMediaIds(ctx, userId, mediaIds);
  const collectionId = ctx.newId();
  const saved = await ctx.repo.createCollection({ id: collectionId, ownerId: userId, name, ...(description ? { description } : {}), visibility, archived: false, mediaIds });
  if (!saved) throw conflict("That collection could not be saved.");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.created", entityType: "VideoCollection", entityId: collectionId });
  return { collectionId };
}

export async function updateCollection(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 }).trim();
  const description = readDescription(input, problems);
  const visibility = readVisibility(input, problems);
  const archived = readBoolean(input, "archived", problems, false);
  problems.throwIfAny();

  await ownedCollection(ctx, userId, collectionId);
  const saved = await ctx.repo.updateCollection(collectionId, { name, description, visibility, archived });
  if (!saved) throw notFound("Collection");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.updated", entityType: "VideoCollection", entityId: collectionId });
  return { collectionId };
}

export async function replaceCollectionMedia(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const mediaIds = readIdList(input, "mediaIds", problems, { max: 200 });
  if (new Set(mediaIds).size !== mediaIds.length) problems.add("Each file can be added only once.");
  problems.throwIfAny();

  await ownedCollection(ctx, userId, collectionId);
  await ownedMediaIds(ctx, userId, mediaIds);
  const saved = await ctx.repo.replaceCollectionMedia(collectionId, mediaIds);
  if (!saved) throw notFound("Collection");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.media_replaced", entityType: "VideoCollection", entityId: collectionId, metadata: { count: mediaIds.length } });
  return { collectionId };
}
