// PostgreSQL persistence through Prisma. NOT RUN against a real database or the real Prisma Client (no network here):
// it passes the shared contract tests only against a fake that follows Prisma's documented behaviour.
// Security/concurrency rules it must keep:
//   - version-checked saves are ONE conditional UPDATE each (updateMany ... where id AND version) and report count === 1,
//   - cycle status moves are conditional updates (where status = from),
//   - the storage quota check and insert happen in one transaction that first locks the owner's user row,
//   - read methods select only what the screens need and page large lists.
import { effectivePlanId, type SubscriptionState } from "../../lib/billing/subscription-state.ts";
import type { PlanId } from "../../lib/billing/catalog.ts";
import type { CaptionRevision } from "../../lib/domain/caption-cover-updates.ts";
import type { MediaSort } from "../../lib/domain/media-list.ts";
import type { CollectionPermissionGrant, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../../lib/domain/types.ts";
import type { UsageRecordDraft } from "../../lib/domain/usage-accounting.ts";
import type { AuditEntry, CycleRecord, EditingTemplateRecord, RenderOutputRecord, Repository, SaveRenderResult, SocialAccountRecord } from "../repository.ts";
import { cycleToRow, grantToRow, itemToMutableData, itemToRow, mediaToRow, rowToCollection, rowToCycle, rowToGrant, rowToItem, rowToMedia, rowToSocialAccount } from "./mappers.ts";
import { isUniqueViolation, type PrismaClientLike } from "./prisma-client-like.ts";

const ACTIVE_CYCLE_STATUSES = ["draft", "running", "paused"];

export class PrismaRepository implements Repository {
  private db: PrismaClientLike; private now: () => Date;
  constructor(db: PrismaClientLike, now: () => Date = () => new Date()) { this.db = db; this.now = now; }

  async getPlanIdForUser(userId: string): Promise<PlanId> {
    const row = await this.db.subscription.findUnique({ where: { userId } });
    if (!row) return "free";
    const state: SubscriptionState = { planId: row["planId"], interval: row["interval"], status: row["status"], lastEventAt: Number(row["lastEventAt"] ?? 0), processedEventIds: [], trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]) };
    return effectivePlanId(state, Math.floor(this.now().getTime() / 1000));
  }

  async getCycle(cycleId: string): Promise<CycleRecord | null> { const row = await this.db.publishingCycle.findUnique({ where: { id: cycleId } }); return row ? rowToCycle(row) : null; }
  async countActiveCycles(userId: string): Promise<number> { return this.db.publishingCycle.count({ where: { ownerId: userId, status: { in: ACTIVE_CYCLE_STATUSES } } }); }
  async createCycle(cycle: CycleRecord): Promise<void> { await this.db.publishingCycle.create({ data: cycleToRow(cycle) }); }
  async transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean> {
    const result = await this.db.publishingCycle.updateMany({ where: { id: cycleId, status: from }, data: { status: to, finalReviewConfirmed } });
    return result.count === 1;
  }
  async listCyclesForOwner(userId: string): Promise<CycleRecord[]> { return (await this.db.publishingCycle.findMany({ where: { ownerId: userId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })).map(rowToCycle); }

  async getCycleItems(cycleId: string): Promise<CycleItem[]> { return (await this.db.cycleItem.findMany({ where: { cycleId }, orderBy: [{ position: "asc" }, { id: "asc" }] })).map(rowToItem); }
  async addCycleItems(items: CycleItem[]): Promise<void> { if (items.length > 0) await this.db.cycleItem.createMany({ data: items.map(itemToRow) }); }
  async saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]> {
    const results: { itemId: string; saved: boolean }[] = [];
    for (const { item, expectedVersion } of updates) {
      // One conditional UPDATE: it changes the row only if nobody changed it since the caller read it.
      const outcome = await this.db.cycleItem.updateMany({ where: { id: item.id, version: expectedVersion }, data: itemToMutableData(item) });
      results.push({ itemId: item.id, saved: outcome.count === 1 });
    }
    return results;
  }

  async getMedia(mediaId: string): Promise<MediaAsset | null> { const row = await this.db.mediaAsset.findUnique({ where: { id: mediaId } }); return row ? rowToMedia(row) : null; }
  async getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]> { return mediaIds.length === 0 ? [] : (await this.db.mediaAsset.findMany({ where: { id: { in: mediaIds } } })).map(rowToMedia); }
  async listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image"; search?: string; sort?: MediaSort }): Promise<{ items: MediaAsset[]; total: number }> {
    const where = { ownerId: userId, status: { not: "deleted" }, ...(page.kind ? { kind: page.kind } : {}), ...(page.search ? { originalFilename: { contains: page.search, mode: "insensitive" } } : {}) };
    const tie = { id: "asc" as const };
    const orderBy = page.sort === "oldest" ? [{ createdAt: "asc" as const }, tie] : page.sort === "name" ? [{ originalFilename: "asc" as const }, tie] : page.sort === "size" ? [{ sizeBytes: "desc" as const }, tie] : [{ createdAt: "desc" as const }, tie];
    const [rows, total] = await Promise.all([this.db.mediaAsset.findMany({ where, orderBy, skip: page.offset, take: page.limit }), this.db.mediaAsset.count({ where })]);
    return { items: rows.map(rowToMedia), total };
  }
  async getStorageUsedBytes(userId: string): Promise<number> {
    const [mediaSum, renderSum] = await Promise.all([
      this.db.mediaAsset.aggregate({ where: { ownerId: userId, status: { not: "deleted" } }, _sum: { sizeBytes: true } }),
      this.db.mediaDerivative.aggregate({ where: { ownerId: userId, kind: "render" }, _sum: { sizeBytes: true } }),
    ]);
    return Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0);
  }

  async addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      // Lock this user's row so two uploads by the same user are checked one after the other.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${media.ownerId} FOR UPDATE`;
      const sum = await tx.mediaAsset.aggregate({ where: { ownerId: media.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
      if (Number(sum._sum["sizeBytes"] ?? 0) + media.sizeBytes > limitBytes) return false;
      await tx.mediaAsset.create({ data: mediaToRow(media, keys) });
      return true;
    });
  }
  async getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null> {
    const row = await this.db.mediaAsset.findUnique({ where: { id: mediaId } });
    return row ? { storageKey: row["storageKey"], thumbnailKey: row["thumbnailKey"] ?? null, mimeType: row["mimeType"] ?? null } : null;
  }

  private async collectionsFromRows(rows: Record<string, unknown>[]): Promise<VideoCollection[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r["id"] as string);
    const items = await this.db.collectionItem.findMany({ where: { collectionId: { in: ids } }, orderBy: [{ position: "asc" }, { mediaAssetId: "asc" }] });
    const byCollection = new Map<string, string[]>();
    for (const item of items) byCollection.set(item["collectionId"], [...(byCollection.get(item["collectionId"]) ?? []), item["mediaAssetId"]]);
    return rows.map((r) => rowToCollection(r, byCollection.get(r["id"] as string) ?? []));
  }
  async getCollection(collectionId: string): Promise<VideoCollection | null> {
    const row = await this.db.videoCollection.findUnique({ where: { id: collectionId } });
    return row ? (await this.collectionsFromRows([row]))[0] ?? null : null;
  }
  private async mediaRowsExist(db: PrismaClientLike, mediaIds: string[]): Promise<boolean> {
    if (new Set(mediaIds).size !== mediaIds.length) return false;
    if (mediaIds.length === 0) return true;
    return (await db.mediaAsset.count({ where: { id: { in: mediaIds } } })) === mediaIds.length;
  }
  async createCollection(collection: VideoCollection): Promise<boolean> {
    if (!(await this.mediaRowsExist(this.db, collection.mediaIds))) return false;
    try {
      await this.db.$transaction(async (tx) => {
        await tx.videoCollection.create({ data: { id: collection.id, ownerId: collection.ownerId, name: collection.name ?? collection.id, description: collection.description ?? null, visibility: collection.visibility, archived: collection.archived, ...(collection.createdAt ? { createdAt: collection.createdAt } : {}) } });
        if (collection.mediaIds.length > 0) await tx.collectionItem.createMany({ data: collection.mediaIds.map((mediaAssetId, position) => ({ collectionId: collection.id, mediaAssetId, position })) });
      });
      return true;
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; }
  }
  async updateCollection(collectionId: string, details: { name: string; description: string | null; visibility: VideoCollection["visibility"]; archived: boolean }): Promise<boolean> {
    const result = await this.db.videoCollection.updateMany({ where: { id: collectionId }, data: { name: details.name, description: details.description, visibility: details.visibility, archived: details.archived } });
    return result.count === 1;
  }
  async replaceCollectionMedia(collectionId: string, mediaIds: string[]): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      if (!(await tx.videoCollection.findUnique({ where: { id: collectionId } }))) return false;
      if (!(await this.mediaRowsExist(tx, mediaIds))) return false;
      await tx.collectionItem.deleteMany({ where: { collectionId } });
      if (mediaIds.length > 0) await tx.collectionItem.createMany({ data: mediaIds.map((mediaAssetId, position) => ({ collectionId, mediaAssetId, position })) });
      return true;
    });
  }
  async deleteCollection(collectionId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      if (!(await tx.videoCollection.findUnique({ where: { id: collectionId } }))) return false;
      await tx.collectionItem.deleteMany({ where: { collectionId } });
      await tx.collectionPermission.deleteMany({ where: { collectionId } });
      const removed = await tx.videoCollection.deleteMany({ where: { id: collectionId } });
      return removed.count === 1;
    });
  }
  async listCollectionsForOwner(userId: string): Promise<VideoCollection[]> { return this.collectionsFromRows(await this.db.videoCollection.findMany({ where: { ownerId: userId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })); }
  async listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]> {
    const grants = (await this.db.collectionPermission.findMany({ where: { granteeId: userId, status: "active" } })).filter((g) => g["expiresAt"] == null || (g["expiresAt"] as Date) > now);
    const ids = grants.map((g) => g["collectionId"] as string);
    if (ids.length === 0) return [];
    const rows = (await this.db.videoCollection.findMany({ where: { id: { in: ids } } })).filter((r) => r["ownerId"] !== userId);
    return this.collectionsFromRows(rows);
  }
  async listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]> {
    const links = await this.db.collectionItem.findMany({ where: { mediaAssetId: mediaId } });
    const ids = [...new Set(links.map((l) => l["collectionId"] as string))];
    return ids.length === 0 ? [] : this.collectionsFromRows(await this.db.videoCollection.findMany({ where: { id: { in: ids } } }));
  }

  async getGrants(collectionId: string): Promise<CollectionPermissionGrant[]> { return (await this.db.collectionPermission.findMany({ where: { collectionId } })).map(rowToGrant); }
  async upsertGrant(grant: CollectionPermissionGrant): Promise<void> {
    const row = grantToRow(grant);
    await this.db.collectionPermission.upsert({ where: { collectionId_granteeId: { collectionId: grant.collectionId, granteeId: grant.granteeId } }, create: row, update: { capabilities: row["capabilities"], status: row["status"], expiresAt: row["expiresAt"], grantedById: row["grantedById"], revokedAt: row["revokedAt"] } });
  }

  async getSocialAccount(accountId: string): Promise<SocialAccountRecord | null> { const row = await this.db.socialAccount.findUnique({ where: { id: accountId } }); return row ? rowToSocialAccount(row) : null; }
  async listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]> { return (await this.db.socialAccount.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(rowToSocialAccount); }

  private async usageSum(userId: string, kind: string, monthStart: Date): Promise<number> {
    const sum = await this.db.usageRecord.aggregate({ where: { userId, kind, periodStart: monthStart }, _sum: { amount: true } });
    return Number(sum._sum["amount"] ?? 0);
  }
  async getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }> {
    return { processingSeconds: await this.usageSum(userId, "processing_seconds", monthStart), exports: await this.usageSum(userId, "exports", monthStart) };
  }
  async getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number> { return this.usageSum(userId, "scheduled_items", monthStart); }

  async getRecentPublishTimes(userId: string, since: Date): Promise<Date[]> {
    const cycleIds = (await this.db.publishingCycle.findMany({ where: { ownerId: userId } })).map((c) => c["id"] as string);
    if (cycleIds.length === 0) return [];
    const items = await this.db.cycleItem.findMany({ where: { cycleId: { in: cycleIds }, status: "published", scheduledFor: { gte: since } } });
    return items.map((i) => i["scheduledFor"] as Date);
  }

  async listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]> {
    const rows = await this.db.editingTemplate.findMany({ where: { ownerId: userId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    return rows.map((r) => ({ id: r["id"], ownerId: r["ownerId"], name: r["name"], settings: r["settings"], createdAt: r["createdAt"] }));
  }
  async createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${template.ownerId} FOR UPDATE`; // serialise this user's saves
      const rows = await tx.editingTemplate.findMany({ where: { ownerId: template.ownerId } });
      const named = rows.filter((row) => !String(row["name"]).startsWith("v:")).length;
      if (named + 1 > limit) return false;
      await tx.editingTemplate.create({ data: { id: template.id, ownerId: template.ownerId, name: template.name, settings: template.settings, isDefault: false, createdAt: template.createdAt } });
      return true;
    });
  }
  async saveVideoSettings(template: EditingTemplateRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const existing = await tx.editingTemplate.findFirst({ where: { ownerId: template.ownerId, name: template.name } });
      if (existing) { await tx.editingTemplate.update({ where: { id: existing["id"] as string }, data: { settings: template.settings } }); return; }
      await tx.editingTemplate.create({ data: { id: template.id, ownerId: template.ownerId, name: template.name, settings: template.settings, isDefault: false, createdAt: template.createdAt } });
    });
  }
  async listAuditsForEntities(entityType: string, entityIds: string[]): Promise<{ entityId: string; action: string; metadata: Record<string, unknown> | null }[]> {
    if (entityIds.length === 0) return [];
    const rows = await this.db.auditLog.findMany({ where: { entityType, entityId: { in: entityIds } } });
    return rows.map((row) => ({ entityId: row["entityId"] as string, action: row["action"] as string, metadata: (row["metadata"] as Record<string, unknown> | null) ?? null }));
  }

  async saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void> {
    if (revisions.length > 0) await this.db.captionRevision.createMany({ data: revisions.map((r) => ({ cycleItemId: r.itemId, previousText: r.previousText, newText: r.newText, source: r.source, changedById: r.changedBy, changedAt: r.changedAt })) });
  }
  async findRenderOutput(ownerId: string, sourceMediaId: string, settingsHash: string): Promise<{ id: string; sizeBytes: number } | null> {
    const row = await this.db.mediaDerivative.findFirst({ where: { ownerId, mediaAssetId: sourceMediaId, kind: "render", settingsHash } });
    return row ? { id: row["id"], sizeBytes: Number(row["sizeBytes"]) } : null;
  }
  async countRenderOutputsSince(ownerId: string, since: Date): Promise<number> {
    return this.db.mediaDerivative.count({ where: { ownerId, kind: "render", createdAt: { gte: since } } });
  }
  async saveRenderOutput(record: { id: string; sourceMediaId: string; ownerId: string; storageKey: string; sizeBytes: number; settingsHash: string; createdAt: Date }, limitBytes: number): Promise<SaveRenderResult> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${record.ownerId} FOR UPDATE`;
      const existing = await tx.mediaDerivative.findFirst({ where: { ownerId: record.ownerId, mediaAssetId: record.sourceMediaId, kind: "render", settingsHash: record.settingsHash } });
      if (existing) return { status: "duplicate", id: existing["id"] as string };
      const mediaSum = await tx.mediaAsset.aggregate({ where: { ownerId: record.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
      const renderSum = await tx.mediaDerivative.aggregate({ where: { ownerId: record.ownerId, kind: "render" }, _sum: { sizeBytes: true } });
      if (Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + record.sizeBytes > limitBytes) return { status: "over_quota" };
      await tx.mediaDerivative.create({ data: { id: record.id, mediaAssetId: record.sourceMediaId, ownerId: record.ownerId, kind: "render", storageKey: record.storageKey, sizeBytes: BigInt(record.sizeBytes), settingsHash: record.settingsHash, createdAt: record.createdAt } });
      return { status: "saved", id: record.id };
    });
  }
  async listRenderOutputsForOwner(ownerId: string): Promise<RenderOutputRecord[]> {
    const rows = await this.db.mediaDerivative.findMany({ where: { ownerId, kind: "render" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 20 });
    return rows.map((row) => ({ id: row["id"], sourceMediaId: row["mediaAssetId"], ownerId: row["ownerId"], sizeBytes: Number(row["sizeBytes"]), createdAt: row["createdAt"] }));
  }
  async getRenderOutput(id: string): Promise<{ id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string } | null> {
    const row = await this.db.mediaDerivative.findUnique({ where: { id } });
    return row && row["kind"] === "render" ? { id: row["id"], ownerId: row["ownerId"], sourceMediaId: row["mediaAssetId"], sizeBytes: Number(row["sizeBytes"]), storageKey: row["storageKey"] } : null;
  }
  async addUsageRecords(records: UsageRecordDraft[]): Promise<void> {
    for (const record of records) {
      try {
        await this.db.usageRecord.create({ data: { userId: record.userId, kind: record.kind, amount: BigInt(record.amount), periodStart: record.periodStart, idempotencyKey: record.idempotencyKey } });
      } catch (error) { if (!isUniqueViolation(error)) throw error; }
    }
  }
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.db.auditLog.create({ data: { actorId: entry.actorId, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, metadata: entry.metadata ?? null } });
  }
}
