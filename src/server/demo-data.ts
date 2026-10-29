// SAMPLE DATA for local demo mode only. Every title says "Sample". There are no real users, files,
// accounts or posts here, and nothing is stored anywhere except server memory.
import { MemoryRepository } from "./memory-repository.ts";
import type { CycleItem, MediaAsset } from "../lib/domain/types.ts";

export const DEMO_USER_ID = "demo-user";
export const DEMO_OTHER_USER_ID = "demo-other-user";
export const DEMO_CYCLE_ID = "demo-cycle-1";

const MB = 1024 * 1024;

export function seedDemoData(repo: MemoryRepository, now: Date): void {
  repo.plans.set(DEMO_USER_ID, "creator");
  repo.plans.set(DEMO_OTHER_USER_ID, "pro");

  const day = 86_400_000;
  const makeMedia = (id: string, ownerId: string, title: string, sizeMb: number, daysAgo: number, seconds: number): MediaAsset =>
    ({ id, ownerId, status: "active", sizeBytes: sizeMb * MB, deleteAfter: null, title, kind: "video", durationMs: seconds * 1000, createdAt: new Date(now.getTime() - daysAgo * day) });
  for (let i = 1; i <= 30; i++) repo.media.set(`demo-media-${i}`, makeMedia(`demo-media-${i}`, DEMO_USER_ID, `Sample clip ${String(i).padStart(2, "0")}`, 20 + (i % 7) * 15, i, 15 + (i % 5) * 10));
  for (let i = 1; i <= 4; i++) repo.media.set(`demo-shared-${i}`, makeMedia(`demo-shared-${i}`, DEMO_OTHER_USER_ID, `Sample shared clip ${i}`, 40, i, 30));

  repo.collections.set("demo-col-1", { id: "demo-col-1", ownerId: DEMO_USER_ID, visibility: "private", archived: false, name: "Sample collection - Client A", description: "Example collection of the sample clips.", mediaIds: ["demo-media-1", "demo-media-2", "demo-media-3", "demo-media-4", "demo-media-5"] });
  repo.collections.set("demo-col-2", { id: "demo-col-2", ownerId: DEMO_USER_ID, visibility: "link", archived: false, name: "Sample collection - Podcast clips", mediaIds: ["demo-media-6", "demo-media-7"] });
  repo.collections.set("demo-shared-col-1", { id: "demo-shared-col-1", ownerId: DEMO_OTHER_USER_ID, visibility: "private", archived: false, name: "Sample shared collection (use allowed)", description: "Shared with you by a sample user. You may use these in a cycle.", mediaIds: ["demo-shared-1", "demo-shared-2"] });
  repo.collections.set("demo-shared-col-2", { id: "demo-shared-col-2", ownerId: DEMO_OTHER_USER_ID, visibility: "private", archived: false, name: "Sample shared collection (view only)", mediaIds: ["demo-shared-3", "demo-shared-4"] });
  repo.grants.push(
    { collectionId: "demo-shared-col-1", granteeId: DEMO_USER_ID, capabilities: ["view", "use_in_cycle"], status: "active", expiresAt: null, grantedById: DEMO_OTHER_USER_ID },
    { collectionId: "demo-shared-col-2", granteeId: DEMO_USER_ID, capabilities: ["view"], status: "active", expiresAt: null, grantedById: DEMO_OTHER_USER_ID },
  );

  repo.socialAccounts.set("demo-account", { id: "demo-account", userId: DEMO_USER_ID, status: "connected" });
  repo.cycles.set(DEMO_CYCLE_ID, { id: DEMO_CYCLE_ID, ownerId: DEMO_USER_ID, status: "draft", finalReviewConfirmed: false, name: "Sample cycle (nothing is published)", socialAccountId: "demo-account" });

  const item = (n: number, over: Partial<CycleItem>): CycleItem => ({
    id: `demo-item-${n}`, cycleId: DEMO_CYCLE_ID, cycleOwnerId: DEMO_USER_ID, mediaAssetId: `demo-media-${n}`, sourceKind: "owned", sourceCollectionId: null,
    status: "upcoming", position: n, version: 1, scheduledFor: null, captionText: "", captionSource: "none", coverMediaId: null, coverIsCustom: false, coverState: "none",
    lockedBy: null, lockExpiresAt: null, reviewReason: null, ...over,
  });
  const hour = 3_600_000;
  repo.items.set("demo-item-1", item(1, { status: "scheduled", scheduledFor: new Date(now.getTime() + 24 * hour), captionText: "Sample caption one" }));
  repo.items.set("demo-item-2", item(2, { status: "scheduled", scheduledFor: new Date(now.getTime() + 48 * hour), captionText: "Sample caption two", coverMediaId: "demo-media-9", coverState: "saved_internally" }));
  repo.items.set("demo-item-3", item(3, {}));
  repo.items.set("demo-item-4", item(4, { mediaAssetId: "demo-shared-1", sourceKind: "shared_reference", sourceCollectionId: "demo-shared-col-1", position: 4, captionText: "Sample shared video" }));

  repo.scheduledItemsUsed.set(DEMO_USER_ID, 12);
  repo.monthlyUsage.set(DEMO_USER_ID, { processingSeconds: 45 * 60, exports: 8 });
}
