// In-memory Repository for tests (and local experiments). It follows the same rules as the real
// database must: every method that reads yields once (so concurrent requests really interleave),
// and the version-checked save is atomic.
import type { PlanId } from "../lib/billing/catalog.ts";
import type { CaptionRevision } from "../lib/domain/caption-cover-updates.ts";
import type { CollectionPermissionGrant, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../lib/domain/types.ts";
import type { AuditEntry, CycleRecord, EditingTemplateRecord, Repository, SocialAccountRecord } from "./repository.ts";

const clone = <T>(value: T): T => structuredClone(value);
/** Fields a version-checked save may change; identity fields (id, cycleId, cycleOwnerId) never do. */
const MUTABLE_ITEM_FIELDS = ["mediaAssetId", "sourceKind", "sourceCollectionId", "status", "position", "version", "scheduledFor", "captionText", "captionSource", "coverMediaId", "coverIsCustom", "coverState", "lockedBy", "lockExpiresAt", "reviewReason"] as const;
const tick = (): Promise<void> => Promise.resolve();

export class MemoryRepository implements Repository {
  plans = new Map<string, PlanId>();
  cycles = new Map<string, CycleRecord>();
  items = new Map<string, CycleItem>();
  media = new Map<string, MediaAsset>();
  collections = new Map<string, VideoCollection>();
  grants: CollectionPermissionGrant[] = [];
  socialAccounts = new Map<string, SocialAccountRecord>();
  captionRevisions: CaptionRevision[] = [];
  audit: AuditEntry[] = [];
  templates = new Map<string, EditingTemplateRecord>();
  storageKeys = new Map<string, string>();
  thumbnailKeys = new Map<string, string | null>();
  /** Usage per user AND month, like the UsageRecord table. Use setUsage() to fill it. */
  usageByMonth = new Map<string, { processingSeconds: number; exports: number; scheduledItems: number }>();
  setUsage(userId: string, monthStart: Date, usage: { processingSeconds: number; exports: number; scheduledItems: number }): void { this.usageByMonth.set(`${userId}|${monthStart.toISOString()}`, usage); }
  /** Test hook: runs right before a version-checked save, to simulate another request/worker winning the race. */
  beforeItemSave: (() => void) | null = null;

  async getPlanIdForUser(userId: string): Promise<PlanId> { await tick(); return this.plans.get(userId) ?? "free"; }

  async getCycle(cycleId: string): Promise<CycleRecord | null> { await tick(); const c = this.cycles.get(cycleId); return c ? clone(c) : null; }
  async countActiveCycles(userId: string): Promise<number> {
    await tick();
    return [...this.cycles.values()].filter((c) => c.ownerId === userId && (c.status === "draft" || c.status === "running" || c.status === "paused")).length;
  }
  async createCycle(cycle: CycleRecord): Promise<void> { await tick(); this.cycles.set(cycle.id, clone(cycle)); }
  async transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean> {
    await tick();
    const cycle = this.cycles.get(cycleId);
    if (!cycle || cycle.status !== from) return false; // someone else already changed it
    this.cycles.set(cycleId, { ...cycle, status: to, finalReviewConfirmed });
    return true;
  }

  async getCycleItems(cycleId: string): Promise<CycleItem[]> {
    await tick(); // queue order, like ORDER BY position, id
    return [...this.items.values()].filter((i) => i.cycleId === cycleId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(clone);
  }
  async addCycleItems(items: CycleItem[]): Promise<void> { await tick(); for (const item of items) this.items.set(item.id, clone(item)); }
  async saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]> {
    await tick();
    this.beforeItemSave?.();
    // No `await` below: the check-and-write of each item is atomic, like a single SQL UPDATE ... WHERE version = ?.
    return updates.map(({ item, expectedVersion }) => {
      const stored = this.items.get(item.id);
      if (!stored || stored.version !== expectedVersion) return { itemId: item.id, saved: false };
      const merged = { ...stored } as Record<string, unknown>;
      for (const field of MUTABLE_ITEM_FIELDS) merged[field] = clone(item[field]);
      this.items.set(item.id, merged as unknown as CycleItem);
      return { itemId: item.id, saved: true };
    });
  }

  private view(m: MediaAsset): MediaAsset { const copy = clone(m); if (this.thumbnailKeys.has(m.id)) copy.hasThumbnail = this.thumbnailKeys.get(m.id) != null; return copy; }
  async getMedia(mediaId: string): Promise<MediaAsset | null> { await tick(); const m = this.media.get(mediaId); return m ? this.view(m) : null; }
  async getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]> {
    await tick();
    return mediaIds.flatMap((id) => { const m = this.media.get(id); return m ? [this.view(m)] : []; });
  }
  async listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image" }): Promise<{ items: MediaAsset[]; total: number }> {
    await tick();
    const mine = [...this.media.values()].filter((m) => m.ownerId === userId && m.status !== "deleted" && (page.kind === undefined || (m.kind ?? "video") === page.kind))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
    return { items: mine.slice(page.offset, page.offset + page.limit).map((m) => this.view(m)), total: mine.length };
  }
  async addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean> {
    await tick();
    // No `await` between the check and the write: atomic, like one SQL transaction.
    const used = [...this.media.values()].filter((m) => m.ownerId === media.ownerId && m.status !== "deleted").reduce((sum, m) => sum + m.sizeBytes, 0);
    if (used + media.sizeBytes > limitBytes) return false;
    this.media.set(media.id, clone(media)); this.storageKeys.set(media.id, keys.storageKey); this.thumbnailKeys.set(media.id, keys.thumbnailKey);
    return true;
  }
  async getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null> {
    await tick();
    const key = this.storageKeys.get(mediaId);
    return key ? { storageKey: key, thumbnailKey: this.thumbnailKeys.get(mediaId) ?? null, mimeType: this.media.get(mediaId)?.mimeType ?? null } : null;
  }
  async listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]> { await tick(); return [...this.collections.values()].filter((c) => c.mediaIds.includes(mediaId)).map(clone); }
  async listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]> { await tick(); return [...this.socialAccounts.values()].filter((a) => a.userId === userId).map(clone); }
  async listCollectionsForOwner(userId: string): Promise<VideoCollection[]> { await tick(); return [...this.collections.values()].filter((c) => c.ownerId === userId).map(clone); }
  async listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]> {
    await tick();
    const validIds = new Set(this.grants.filter((g) => g.granteeId === userId && g.status === "active" && (g.expiresAt === null || g.expiresAt > now)).map((g) => g.collectionId));
    return [...this.collections.values()].filter((c) => validIds.has(c.id) && c.ownerId !== userId).map(clone);
  }
  async listCyclesForOwner(userId: string): Promise<CycleRecord[]> { await tick(); return [...this.cycles.values()].filter((c) => c.ownerId === userId).map(clone); }
  async getStorageUsedBytes(userId: string): Promise<number> {
    await tick();
    return [...this.media.values()].filter((m) => m.ownerId === userId && m.status !== "deleted").reduce((sum, m) => sum + m.sizeBytes, 0);
  }
  async getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }> {
    await tick(); const u = this.usageByMonth.get(`${userId}|${monthStart.toISOString()}`);
    return { processingSeconds: u?.processingSeconds ?? 0, exports: u?.exports ?? 0 };
  }

  async getCollection(collectionId: string): Promise<VideoCollection | null> { await tick(); const c = this.collections.get(collectionId); return c ? clone(c) : null; }
  async getGrants(collectionId: string): Promise<CollectionPermissionGrant[]> { await tick(); return this.grants.filter((g) => g.collectionId === collectionId).map(clone); }
  async upsertGrant(grant: CollectionPermissionGrant): Promise<void> {
    await tick();
    const index = this.grants.findIndex((g) => g.collectionId === grant.collectionId && g.granteeId === grant.granteeId);
    if (index === -1) this.grants.push(clone(grant)); else this.grants[index] = clone(grant); // unique (collection, grantee)
  }

  async getSocialAccount(accountId: string): Promise<SocialAccountRecord | null> { await tick(); const a = this.socialAccounts.get(accountId); return a ? clone(a) : null; }
  async getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number> { await tick(); return this.usageByMonth.get(`${userId}|${monthStart.toISOString()}`)?.scheduledItems ?? 0; }
  async getRecentPublishTimes(userId: string, since: Date): Promise<Date[]> {
    await tick();
    const ownCycleIds = new Set([...this.cycles.values()].filter((c) => c.ownerId === userId).map((c) => c.id));
    return [...this.items.values()].filter((i) => ownCycleIds.has(i.cycleId) && i.status === "published" && i.scheduledFor && i.scheduledFor >= since).map((i) => i.scheduledFor as Date);
  }

  async listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]> {
    await tick();
    return [...this.templates.values()].filter((t) => t.ownerId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }
  async createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean> {
    await tick(); // no await between the count and the write: atomic
    if ([...this.templates.values()].filter((t) => t.ownerId === template.ownerId).length + 1 > limit) return false;
    this.templates.set(template.id, clone(template)); return true;
  }

  async saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void> { await tick(); this.captionRevisions.push(...revisions.map(clone)); }
  async appendAudit(entry: AuditEntry): Promise<void> { await tick(); this.audit.push(clone(entry)); }
}
