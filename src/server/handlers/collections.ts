// Creating and editing collections. The signed-in user is the only owner these writes accept.
// Someone else's collection looks missing. Media that the user does not own is refused.
import { COLLECTION_VISIBILITIES, type CollectionVisibility, type VideoCollection } from "../../lib/domain/types.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, notFound } from "../errors.ts";
import { Problems, readBoolean, readId, readIdList, readObject, readText } from "../validation.ts";
import type { CollectionItemSettings } from "../../lib/domain/types.ts";

const settingModes = ["individual", "shared"] as const;

async function validateCollectionCover(ctx: RequestContext, userId: string, rawId: unknown, problems: Problems, field: string): Promise<string | null> {
  if (rawId === undefined || rawId === null || rawId === "") return null;
  if (typeof rawId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rawId)) { problems.add(`${field} must be a valid image in your library.`); return null; }
  const media = await ctx.repo.getMedia(rawId);
  if (!media || media.ownerId !== userId || media.status !== "active" || media.kind !== "image") { problems.add(`${field} must be an active image that you own.`); return null; }
  return rawId;
}

function parseItemSettings(raw: unknown, mediaIds: string[], problems: Problems): Map<string, Omit<CollectionItemSettings, "version">> {
  const result = new Map<string, Omit<CollectionItemSettings, "version">>();
  if (raw === undefined || raw === null || raw === "") return result;
  let entries: unknown = raw;
  if (typeof raw === "string") { try { entries = JSON.parse(raw); } catch { problems.add("Video settings could not be read. Review the selections and try again."); return result; } }
  if (!Array.isArray(entries) || entries.length > 200) { problems.add("Video settings must be a list of up to 200 videos."); return result; }
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) { problems.add("A video setting is invalid."); continue; }
    const row = entry as Record<string, unknown>;
    const mediaAssetId = row["mediaAssetId"];
    const captionText = row["captionText"];
    const coverMediaId = row["coverMediaId"];
    if (typeof mediaAssetId !== "string" || !mediaIds.includes(mediaAssetId) || result.has(mediaAssetId)) { problems.add("Video settings must match the selected videos exactly."); continue; }
    if (typeof captionText !== "string" || captionText.length > 2200) { problems.add("Captions must be at most 2,200 characters."); continue; }
    if (coverMediaId !== null && coverMediaId !== "" && (typeof coverMediaId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(coverMediaId))) { problems.add("Choose an eligible image for each cover."); continue; }
    result.set(mediaAssetId, { mediaAssetId, captionText, coverMediaId: typeof coverMediaId === "string" && coverMediaId !== "" ? coverMediaId : null });
  }
  if (result.size > 0 && result.size !== mediaIds.length) problems.add("Settings must be supplied for each selected video.");
  return result;
}

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
  const itemSettings = parseItemSettings(input["itemSettings"], mediaIds, problems);
  if (input["captionMode"] !== undefined && !settingModes.includes(input["captionMode"] as typeof settingModes[number])) problems.add("Choose individual or shared caption settings.");
  if (input["coverMode"] !== undefined && !settingModes.includes(input["coverMode"] as typeof settingModes[number])) problems.add("Choose individual or shared cover settings.");
  const captionMode = settingModes.includes(input["captionMode"] as typeof settingModes[number]) ? input["captionMode"] as typeof settingModes[number] : "individual";
  const coverMode = settingModes.includes(input["coverMode"] as typeof settingModes[number]) ? input["coverMode"] as typeof settingModes[number] : "individual";
  const sharedCaptionText = captionMode === "shared" ? readText(input, "sharedCaptionText", problems, { max: 2200 }) : null;
  const sharedCoverMediaId = coverMode === "shared" ? await validateCollectionCover(ctx, userId, input["sharedCoverMediaId"], problems, "Shared cover") : null;
  if (new Set(mediaIds).size !== mediaIds.length) problems.add("Each file can be added only once.");
  if ((captionMode === "shared" || coverMode === "shared") && mediaIds.length > 0 && input["confirmSharedSettings"] !== true) problems.add(`Confirm applying shared settings to all ${mediaIds.length} selected videos.`);
  for (const setting of itemSettings.values()) if (setting.coverMediaId) await validateCollectionCover(ctx, userId, setting.coverMediaId, problems, "Cover");
  problems.throwIfAny();

  await ownedMediaIds(ctx, userId, mediaIds);
  const collectionId = ctx.newId();
  const saved = await ctx.repo.createCollection({ id: collectionId, ownerId: userId, name, ...(description ? { description } : {}), visibility, archived: false, mediaIds, captionMode, sharedCaptionText, coverMode, sharedCoverMediaId, settingsVersion: 1, items: mediaIds.map((mediaAssetId) => ({ ...(itemSettings.get(mediaAssetId) ?? { mediaAssetId, captionText: "", coverMediaId: null }), version: 1 })), createdAt: ctx.now });
  if (!saved) throw conflict("That collection could not be saved.");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.created", entityType: "VideoCollection", entityId: collectionId });
  if (captionMode === "shared" || coverMode === "shared") await ctx.repo.appendAudit({ actorId: userId, action: "collection.shared_settings_applied", entityType: "VideoCollection", entityId: collectionId, metadata: { affected: mediaIds.length, captionMode, coverMode } });
  return { collectionId };
}

export async function updateCollectionItemSettings(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx); const problems = new Problems(); const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems); const mediaAssetId = readId(input, "mediaAssetId", problems);
  const captionText = readText(input, "captionText", problems, { max: 2200 });
  const rawCover = input["coverMediaId"];
  if (rawCover !== undefined && rawCover !== null && rawCover !== "" && (typeof rawCover !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rawCover))) problems.add("Cover must be a valid image in your library.");
  const expectedVersion = input["expectedVersion"];
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) problems.add("Reload this collection before saving its video settings.");
  problems.throwIfAny(); await ownedCollection(ctx, userId, collectionId);
  const coverProblems = new Problems(); const coverMediaId = await validateCollectionCover(ctx, userId, rawCover, coverProblems, "Cover"); coverProblems.throwIfAny();
  const saved = await ctx.repo.saveCollectionItemSettings({ collectionId, ownerId: userId, mediaAssetId, captionText, coverMediaId, expectedVersion: expectedVersion as number });
  if (!saved) throw conflict("This video setting changed or is no longer in the collection. Reload and try again.");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.video_settings_updated", entityType: "CollectionItem", entityId: mediaAssetId });
  return { collectionId };
}

export async function updateCollectionSharedSettings(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string; affected: number }> {
  const userId = requireUser(ctx); const problems = new Problems(); const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems); const expectedVersion = input["expectedVersion"];
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) problems.add("Reload this collection before changing shared settings.");
  const captionModeRaw = input["captionMode"]; const coverModeRaw = input["coverMode"];
  if (!settingModes.includes(captionModeRaw as typeof settingModes[number]) || !settingModes.includes(coverModeRaw as typeof settingModes[number])) problems.add("Choose individual or shared settings for captions and covers.");
  const captionMode = captionModeRaw as "individual" | "shared"; const coverMode = coverModeRaw as "individual" | "shared";
  const rawSharedCaptionText = captionMode === "shared" ? readText(input, "sharedCaptionText", problems, { max: 2200 }) : undefined;
  const rawSharedCover = input["sharedCoverMediaId"];
  if (coverMode === "shared" && rawSharedCover !== undefined && rawSharedCover !== null && rawSharedCover !== "" && (typeof rawSharedCover !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rawSharedCover))) problems.add("Shared cover must be a valid image in your library.");
  problems.throwIfAny();
  const current = await ownedCollection(ctx, userId, collectionId); const affected = current.mediaIds.length;
  const sharedCaptionText = rawSharedCaptionText ?? current.sharedCaptionText ?? null;
  const coverProblems = new Problems();
  const sharedCoverMediaId = coverMode === "shared" ? await validateCollectionCover(ctx, userId, rawSharedCover, coverProblems, "Shared cover") : current.sharedCoverMediaId ?? null;
  coverProblems.throwIfAny();
  // Switching back to individual mode only reveals the preserved per-item values.
  // Confirmation is for applying/changing a shared value across the collection.
  const changesAffectAll = (captionMode === "shared" && ((current.captionMode ?? "individual") !== "shared" || sharedCaptionText !== (current.sharedCaptionText ?? "")))
    || (coverMode === "shared" && ((current.coverMode ?? "individual") !== "shared" || sharedCoverMediaId !== (current.sharedCoverMediaId ?? null)));
  if (changesAffectAll && affected > 0 && input["confirmSharedSettings"] !== true) throw new AppError(422, "validation_failed", `Confirm changing settings for all ${affected} videos.`);
  const saved = await ctx.repo.saveCollectionSharedSettings({ collectionId, ownerId: userId, actorId: userId, affected, expectedVersion: expectedVersion as number, captionMode, sharedCaptionText, coverMode, sharedCoverMediaId });
  if (!saved) throw conflict("Collection settings changed while you were editing. Reload and try again.");
  return { collectionId, affected };
}

export async function updateCollection(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 }).trim();
  const description = readDescription(input, problems);
  const visibility = readVisibility(input, problems);
  problems.throwIfAny();

  const current = await ownedCollection(ctx, userId, collectionId);
  const saved = await ctx.repo.updateCollection(collectionId, { name, description, visibility, archived: current.archived });
  if (!saved) throw notFound("Collection");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.updated", entityType: "VideoCollection", entityId: collectionId });
  return { collectionId };
}

export async function setCollectionArchived(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const archived = readBoolean(input, "archived", problems, false);
  if (input["confirm"] !== true) problems.add("Tick the confirmation box before archiving or restoring a collection.");
  problems.throwIfAny();

  const current = await ownedCollection(ctx, userId, collectionId);
  const saved = await ctx.repo.updateCollection(collectionId, { name: current.name ?? "Untitled collection", description: current.description ?? null, visibility: current.visibility, archived });
  if (!saved) throw notFound("Collection");
  await ctx.repo.appendAudit({ actorId: userId, action: archived ? "collection.archived" : "collection.restored", entityType: "VideoCollection", entityId: collectionId });
  return { collectionId };
}

export async function deleteCollection(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  if (input["confirm"] !== true) problems.add("Tick the confirmation box before deleting a collection.");
  problems.throwIfAny();

  await ownedCollection(ctx, userId, collectionId);
  const removed = await ctx.repo.deleteCollection(collectionId);
  if (!removed) throw notFound("Collection");
  await ctx.repo.appendAudit({ actorId: userId, action: "collection.deleted", entityType: "VideoCollection", entityId: collectionId });
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
