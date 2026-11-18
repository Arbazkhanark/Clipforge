import type { Repository } from "../repository.ts";
import type { MediaStorage } from "../storage/media-storage.ts";

export type MediaCleanupResult = "idle" | "deleted" | "retrying" | "stale";

/** Removes only tombstoned media after a fresh reference check; object deletes are idempotent. */
export async function runNextMediaCleanupJob(input: { repo: Repository; storage: MediaStorage; workerId: string; now?: Date }): Promise<MediaCleanupResult> {
  const now = input.now ?? new Date();
  const job = await input.repo.claimMediaCleanupJob({ workerId: input.workerId, now, leaseSeconds: 120 });
  if (!job) return "idle";
  try {
    if (!(await input.repo.canCleanupMediaAsset(job.mediaAssetId))) {
      await input.repo.failMediaCleanupJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken ?? "", now, errorCode: "media_still_referenced", retryAt: new Date(now.getTime() + 60_000) });
      return "retrying";
    }
    const info = await input.repo.getMediaStorageInfo(job.mediaAssetId);
    if (!info) throw new Error("media_storage_reference_missing");
    await input.storage.deleteCommittedMediaObject(info.storageKey);
    if (info.thumbnailKey) await input.storage.deleteCommittedMediaObject(info.thumbnailKey);
    const completed = await input.repo.finishMediaCleanupJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken ?? "", now: new Date() });
    return completed ? "deleted" : "stale";
  } catch {
    await input.repo.failMediaCleanupJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken ?? "", now, errorCode: "private_storage_delete_failed", retryAt: new Date(now.getTime() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(job.attempts, 8))) });
    return "retrying";
  }
}
