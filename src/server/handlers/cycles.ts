// Creating cycles, mixing/unmixing videos, and starting a cycle.
import { getPlan } from "../../lib/billing/catalog.ts";
import { checkLimit } from "../../lib/billing/entitlements.ts";
import { monthStartUtc } from "../../lib/domain/usage-accounting.ts";
import { mixVideosIntoCycle, unmixItems, type MixCandidate, type MixRejection } from "../../lib/domain/mix-unmix.ts";
import type { PreflightReport } from "../../lib/domain/preflight.ts";
import { assignSlotsToItems, generateSlots, localDateKey, localDateOf, validateScheduleSettings, zonedTimeToUtc, type ScheduleSettings } from "../../lib/domain/schedule.ts";
import { canCycleTransition, moveItemToStatus, pauseCycle as pauseCycleRule, resumeCycle as resumeCycleRule, stopCycle as stopCycleRule } from "../../lib/domain/cycle-state.ts";
import { startCycle as startCycleRule } from "../../lib/domain/cycle-state.ts";
import type { RepeatBehavior } from "../../lib/domain/publish-workflow.ts";
import type { CollectionPermissionGrant, CycleItem, VideoCollection } from "../../lib/domain/types.ts";
import { buildPreflightReport } from "../preflight-service.ts";
import { canKeepUsingSourceForCycleItem } from "../../lib/domain/sharing-permissions.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, forbidden, notFound, planLimit } from "../errors.ts";
import { Problems, readBoolean, readId, readIdList, readObject, readText } from "../validation.ts";

async function loadOwnedCycle(ctx: RequestContext, userId: string, cycleId: string) {
  const cycle = await ctx.repo.getCycle(cycleId);
  if (!cycle || cycle.ownerId !== userId) throw notFound("Publishing cycle");
  return cycle;
}

export async function createCycle(ctx: RequestContext, rawInput: unknown): Promise<{ cycleId: string }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const name = readText(input, "name", problems, { min: 1, max: 100 });
  const socialAccountId = readId(input, "socialAccountId", problems);
  problems.throwIfAny();

  const account = await ctx.repo.getSocialAccount(socialAccountId);
  if (!account || account.userId !== userId) throw notFound("Social account");

  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const limit = checkLimit(planId, "activeCampaigns", await ctx.repo.countActiveCycles(userId), 1);
  if (!limit.allowed) throw planLimit(limit.message);

  const cycleId = ctx.newId();
  const created = await ctx.repo.createCycleWithinLimit({ id: cycleId, ownerId: userId, status: "draft", finalReviewConfirmed: false, name: name.trim(), socialAccountId, createdAt: ctx.now }, getPlan(planId).limits.activeCampaigns);
  if (!created) throw planLimit("Your current plan has reached its active campaign limit.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.created", entityType: "PublishingCycle", entityId: cycleId });
  return { cycleId };
}

export async function setCycleRepeat(ctx: RequestContext, rawInput: unknown): Promise<{ repeatBehavior: RepeatBehavior }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const repeatBehavior = input["repeatBehavior"];
  if (repeatBehavior !== "never" && repeatBehavior !== "ask" && repeatBehavior !== "automatic") {
    problems.add("repeatBehavior must be never, ask, or automatic.");
    problems.throwIfAny();
    throw new Error("unreachable");
  }
  problems.throwIfAny();
  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status === "stopped" || cycle.status === "completed") throw forbidden("This cycle has ended.");
  const saved = await ctx.repo.updateCycleRepeat(cycleId, userId, repeatBehavior);
  if (!saved) throw notFound("Publishing cycle");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.repeat_updated", entityType: "PublishingCycle", entityId: cycleId, metadata: { repeatBehavior } });
  return { repeatBehavior };
}

export async function mixIntoCycle(ctx: RequestContext, rawInput: unknown): Promise<{ added: number; rejected: MixRejection[] }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const rawVideos = input["videos"];
  const confirmedDuplicateMediaIds = readIdList(input, "confirmedDuplicateMediaIds", problems, { max: 200 });
  const requested: { mediaAssetId: string; collectionId: string; isImportedCopy: boolean }[] = [];
  if (!Array.isArray(rawVideos) || rawVideos.length < 1 || rawVideos.length > 200) problems.add("videos must be a list of 1 to 200 entries.");
  else for (const entry of rawVideos) {
    const entryProblems = new Problems();
    const entryObject = readObject(entry, entryProblems, "Each video");
    const mediaAssetId = readId(entryObject, "mediaAssetId", entryProblems);
    const collectionId = readId(entryObject, "collectionId", entryProblems);
    const isImportedCopy = readBoolean(entryObject, "isImportedCopy", entryProblems, false);
    try { entryProblems.throwIfAny(); requested.push({ mediaAssetId, collectionId, isImportedCopy }); } catch { problems.add("Each video needs a valid mediaAssetId and collectionId."); break; }
  }
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status === "stopped" || cycle.status === "completed") throw forbidden("This cycle has ended; start a new one to add videos.");

  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const plan = getPlan(planId);
  const batch = checkLimit(planId, "batchSize", 0, requested.length);
  if (!batch.allowed) throw planLimit(`Your plan allows adding up to ${batch.limit} videos at a time.`);

  // Load every video + collection. Anything missing or unreachable is rejected WITHOUT saying which part was missing.
  const candidates: MixCandidate[] = [];
  const unavailable: MixRejection[] = [];
  const grantsByCollection = new Map<string, CollectionPermissionGrant[]>();
  const collectionCache = new Map<string, VideoCollection | null>();
  for (const video of requested) {
    if (!collectionCache.has(video.collectionId)) collectionCache.set(video.collectionId, await ctx.repo.getCollection(video.collectionId));
    const collection = collectionCache.get(video.collectionId) ?? null;
    const media = await ctx.repo.getMedia(video.mediaAssetId);
    if (!collection || !media) { unavailable.push({ mediaAssetId: video.mediaAssetId, reason: "This video is not available to you." }); continue; }
    if (!grantsByCollection.has(collection.id)) {
      const grants = await ctx.repo.getGrants(collection.id);
      grantsByCollection.set(collection.id, grants);
    }
    candidates.push({ media, collection, isImportedCopy: video.isImportedCopy });
  }
  const existingItems = await ctx.repo.getCycleItems(cycleId);
  const allGrants = [...grantsByCollection.values()].flat();

  const mixed = mixVideosIntoCycle({ userId, candidates, existingItems, grants: allGrants, planFeatures: plan.features, confirmedDuplicateMediaIds, now: ctx.now });
  const unavailableCovers: MixRejection[] = [];
  const newItems: CycleItem[] = [];
  const expectedCollectionSettingsVersions: Record<string, number> = Object.create(null);
  for (const draft of mixed.accepted) {
    const collection = collectionCache.get(draft.sourceCollectionId);
    const member = collection?.items?.find((item) => item.mediaAssetId === draft.mediaAssetId);
    expectedCollectionSettingsVersions[draft.sourceCollectionId] = collection?.settingsVersion ?? 1;
    const captionMode = collection?.captionMode ?? "individual";
    const coverMode = collection?.coverMode ?? "individual";
    const captionText = captionMode === "shared" ? collection?.sharedCaptionText ?? "" : member?.captionText ?? "";
    const coverMediaId = coverMode === "shared" ? collection?.sharedCoverMediaId ?? null : member?.coverMediaId ?? null;
    if (coverMediaId) {
      const cover = await ctx.repo.getMedia(coverMediaId);
      if (!cover || cover.ownerId !== collection?.ownerId || cover.kind !== "image" || cover.status !== "active") {
        unavailableCovers.push({ mediaAssetId: draft.mediaAssetId, reason: "This collection's saved cover is no longer available." });
        continue;
      }
    }
    newItems.push({
      id: ctx.newId(), cycleId, cycleOwnerId: userId, mediaAssetId: draft.mediaAssetId, selectedRenderOutputId: null, sourceKind: draft.sourceKind, sourceCollectionId: draft.sourceCollectionId,
      status: "upcoming", position: draft.position, version: 1, scheduledFor: null, captionText,
      captionSource: captionText.length === 0 ? "none" : captionMode === "shared" ? "bulk" : "individual",
      coverMediaId, coverIsCustom: coverMediaId !== null, coverState: coverMediaId ? "saved_internally" : "none", lockedBy: null, lockExpiresAt: null, reviewReason: null,
    });
  }
  if (newItems.length > 0 && !(await ctx.repo.addCycleItems(newItems, expectedCollectionSettingsVersions))) throw conflict("This cycle or its collection settings changed while adding videos. Reload and try again.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.videos_mixed", entityType: "PublishingCycle", entityId: cycleId, metadata: { added: newItems.length, rejected: mixed.rejected.length + unavailable.length } });
  return { added: newItems.length, rejected: [...unavailable, ...mixed.rejected, ...unavailableCovers] };
}

export async function unmixFromCycle(ctx: RequestContext, rawInput: unknown): Promise<{ removedItemIds: string[]; blocked: { itemId: string; reason: string }[] }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const itemIds = readIdList(input, "itemIds", problems, { min: 1, max: 500 });
  problems.throwIfAny();

  await loadOwnedCycle(ctx, userId, cycleId);
  const items = await ctx.repo.getCycleItems(cycleId);
  const outcome = unmixItems(items, itemIds);

  const beforeById = new Map(items.map((i) => [i.id, i]));
  const updates = outcome.items.filter((i) => outcome.removedItemIds.includes(i.id)).map((item) => ({ item, expectedVersion: (beforeById.get(item.id) as CycleItem).version }));
  const saved = updates.length > 0 ? await ctx.repo.saveCycleItemsIfVersionMatches(updates) : [];
  const savedIds = new Set(saved.filter((s) => s.saved).map((s) => s.itemId));
  const blocked = [...outcome.blocked, ...outcome.removedItemIds.filter((id) => !savedIds.has(id)).map((itemId) => ({ itemId, reason: "This item changed while removing it (it may have just started publishing). Reload to see its status." }))];
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.videos_unmixed", entityType: "PublishingCycle", entityId: cycleId, metadata: { removed: savedIds.size, blocked: blocked.length } });
  return { removedItemIds: [...savedIds], blocked };
}

export async function selectCycleItemRenderOutput(ctx: RequestContext, rawInput: unknown): Promise<{ selected: boolean }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const itemId = readId(input, "itemId", problems);
  const rawOutputId = input["renderOutputId"];
  const renderOutputId = rawOutputId === null || rawOutputId === "" ? null : typeof rawOutputId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawOutputId) ? rawOutputId : "invalid";
  if (renderOutputId === "invalid") problems.add("Choose an available rendered output.");
  const expectedVersion = input["expectedVersion"];
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion) || expectedVersion < 1) problems.add("Reload the cycle before choosing a rendered output.");
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status !== "draft") throw forbidden("Rendered outputs can only be selected while the cycle is a draft.");
  const item = (await ctx.repo.getCycleItems(cycleId)).find((candidate) => candidate.id === itemId);
  if (!item || item.cycleOwnerId !== userId) throw notFound("Cycle item");
  if (item.version !== expectedVersion || (item.status !== "upcoming" && item.status !== "scheduled")) throw conflict("This cycle item changed or can no longer be edited. Reload and try again.");
  if (renderOutputId !== null) {
    const output = await ctx.repo.getRenderOutput(renderOutputId);
    if (!output || output.ownerId !== userId || output.sourceMediaId !== item.mediaAssetId) throw notFound("Rendered output");
    const media = await ctx.repo.getMedia(item.mediaAssetId);
    const collection = item.sourceCollectionId ? await ctx.repo.getCollection(item.sourceCollectionId) : null;
    const grants = collection ? await ctx.repo.getGrants(collection.id) : [];
    if (!canKeepUsingSourceForCycleItem(item, media, collection, grants, ctx.now).allowed) throw forbidden("This source video is no longer available for the cycle.");
  }
  const saved = await ctx.repo.selectCycleItemRenderOutput({ cycleId, itemId, ownerId: userId, renderOutputId, expectedVersion: expectedVersion as number });
  if (!saved) throw conflict("The cycle item or rendered output changed while saving. Reload and try again.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle_item.render_output_selected", entityType: "CycleItem", entityId: itemId, metadata: { selected: renderOutputId !== null } });
  return { selected: renderOutputId !== null };
}

export async function startPublishingCycle(ctx: RequestContext, rawInput: unknown): Promise<{ status: "running"; report: PreflightReport }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const confirmFinalReview = readBoolean(input, "confirmFinalReview", problems, false);
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  const items = await ctx.repo.getCycleItems(cycleId);
  const currentPlan = getPlan(await ctx.repo.getPlanIdForUser(userId, ctx.now));
  if (await ctx.repo.countActiveCycles(userId) > currentPlan.limits.activeCampaigns) throw planLimit("Your current plan's active campaign limit has been reached. Review your active cycles before starting another.");
  const report = await buildPreflightReport(ctx, userId, cycle, items, confirmFinalReview);
  if (!report.canStart) throw new AppError(409, "preflight_failed", "This cycle cannot start yet.", { report });

  const rule = startCycleRule({ ...cycle, finalReviewConfirmed: confirmFinalReview }, items);
  if (!rule.ok) throw conflict(rule.reason);
  // Compare-and-set: if two requests start the same cycle, exactly one wins.
  const won = await ctx.repo.transitionCycleStatus(cycleId, "draft", "running", true);
  if (!won) throw conflict("This cycle was already started or changed. Reload to see its current state.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.started", entityType: "PublishingCycle", entityId: cycleId, metadata: { items: items.length } });
  return { status: "running", report };
}

export async function changeCycleStatus(ctx: RequestContext, rawInput: unknown): Promise<{ status: "running" | "paused" | "stopped" }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const action = input["action"];
  if (action !== "pause" && action !== "resume" && action !== "stop") problems.add("Choose pause, resume, or stop.");
  const confirmStop = readBoolean(input, "confirmStop", problems, false);
  if (action === "stop" && !confirmStop) problems.add("Confirm that you want to stop this cycle.");
  problems.throwIfAny();
  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  const items = action === "stop" || action === "pause" ? await ctx.repo.getCycleItems(cycleId) : [];
  const result = action === "pause" ? pauseCycleRule(cycle, items) : action === "resume" ? resumeCycleRule(cycle) : stopCycleRule(cycle, items);
  if (!result.ok) throw conflict(result.reason);
  if (action === "stop") {
    const before = new Map(items.map((item) => [item.id, item]));
    const updates = result.cancelledItemIds.map((id) => {
      const item = before.get(id);
      if (!item) throw conflict("A cycle item changed while stopping. Reload and try again.");
      return { item: moveItemToStatus(item, "cancelled", { scheduledFor: null }), expectedVersion: item.version };
    });
    const saved = await ctx.repo.stopCycle(cycleId, userId, cycle.status, cycle.finalReviewConfirmed, updates);
    if (!saved) throw conflict("This cycle or one of its videos changed while stopping. Reload and try again.");
  } else {
    const next = action === "pause" ? "paused" : "running";
    if (!canCycleTransition(cycle.status, next)) throw conflict(`A cycle that is "${cycle.status}" cannot be moved to ${next}.`);
    const saved = await ctx.repo.transitionCycleStatus(cycleId, cycle.status, next, cycle.finalReviewConfirmed);
    if (!saved) throw conflict("This cycle changed while updating its status. Reload and try again.");
  }
  const status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
  await ctx.repo.appendAudit({ actorId: userId, action: action === "pause" ? "cycle.paused" : action === "resume" ? "cycle.resumed" : "cycle.stopped", entityType: "PublishingCycle", entityId: cycleId });
  return { status };
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function saveCycleSchedule(ctx: RequestContext, rawInput: unknown): Promise<{ scheduled: number; unscheduled: number }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const cycleId = readId(input, "cycleId", problems);
  const startDate = readText(input, "startDate", problems, { min: 1, max: 10 });
  const timeZone = readText(input, "timeZone", problems, { min: 1, max: 100 });
  const windowStart = readText(input, "windowStart", problems, { min: 1, max: 5 });
  const windowEnd = readText(input, "windowEnd", problems, { min: 1, max: 5 });
  const intervalMinutes = typeof input["intervalMinutes"] === "number" ? input["intervalMinutes"] : Number.NaN;
  const postsPerInterval = typeof input["postsPerInterval"] === "number" ? input["postsPerInterval"] : Number.NaN;
  const dailyMax = input["dailyMax"] === null ? null : typeof input["dailyMax"] === "number" ? input["dailyMax"] : Number.NaN;
  const endDate = input["endDate"] === null ? null : typeof input["endDate"] === "string" ? input["endDate"] : "invalid";
  const daysRaw = input["daysOfWeek"];
  const daysOfWeek = Array.isArray(daysRaw) && daysRaw.every((day) => typeof day === "number") ? daysRaw as number[] : [];
  if (!Array.isArray(daysRaw) || !daysRaw.every((day) => typeof day === "number")) problems.add("Choose one or more valid publishing days.");
  if (!validCalendarDate(startDate)) problems.add("Start date must be a real calendar date in YYYY-MM-DD format.");
  const settings: ScheduleSettings = { timeZone, intervalMinutes, postsPerInterval, daysOfWeek, windowStart, windowEnd, dailyMax, endDate };
  const validation = validateScheduleSettings(settings);
  for (const problem of validation.problems) problems.add(problem);
  if (endDate !== null && !validCalendarDate(endDate)) problems.add("End date must be a real calendar date in YYYY-MM-DD format.");
  if (validCalendarDate(startDate) && endDate !== null && validCalendarDate(endDate) && endDate < startDate) problems.add("End date cannot be before the start date.");
  problems.throwIfAny();

  const cycle = await loadOwnedCycle(ctx, userId, cycleId);
  if (cycle.status !== "draft") throw forbidden("Only draft cycles can have their schedule edited.");
  const today = localDateKey(localDateOf(timeZone, ctx.now));
  if (startDate < today) throw conflict("Choose today or a future date for the schedule.");

  const items = await ctx.repo.getCycleItems(cycleId);
  const editable = items.filter((item) => item.status === "upcoming" || item.status === "scheduled");
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const scheduledLimit = getPlan(planId).limits.scheduledItemsPerMonth;
  const scheduledUsed = await ctx.repo.getScheduledItemsUsedThisMonth(userId, monthStartUtc(ctx.now));
  if (editable.length > Math.max(0, scheduledLimit - scheduledUsed)) {
    throw planLimit(`Your current plan has room for ${Math.max(0, scheduledLimit - scheduledUsed)} more scheduled item(s) this month. This cycle has ${editable.length} editable item(s).`);
  }
  const [year, month, day] = startDate.split("-").map(Number);
  const startFrom = zonedTimeToUtc(timeZone, year!, month!, day!, Number(windowStart.slice(0, 2)), Number(windowStart.slice(3, 5)));
  const now = ctx.now.getTime();
  const result = generateSlots({ settings, startFrom: new Date(Math.max(startFrom.getTime(), now)), count: editable.length });
  const assignment = assignSlotsToItems(items, result.slots);
  const before = new Map(items.map((item) => [item.id, item]));
  const updates = assignment.items.filter((item) => item.version !== before.get(item.id)?.version)
    .map((item) => ({ item, expectedVersion: (before.get(item.id) as CycleItem).version }));
  const saved = await ctx.repo.saveCycleSchedule(cycleId, userId, { ...settings, startDate }, updates);
  if (!saved) throw conflict("The cycle or one of its videos changed while saving. Reload and try again.");
  await ctx.repo.appendAudit({ actorId: userId, action: "cycle.schedule_saved", entityType: "PublishingCycle", entityId: cycleId, metadata: { scheduled: editable.length - assignment.unscheduledItemIds.length, unscheduled: assignment.unscheduledItemIds.length } });
  return { scheduled: editable.length - assignment.unscheduledItemIds.length, unscheduled: assignment.unscheduledItemIds.length };
}
