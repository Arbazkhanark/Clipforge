import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { canImportVideo } from "../../lib/domain/sharing-permissions.ts";
import type { MediaAsset } from "../../lib/domain/types.ts";
import type { Repository } from "../repository.ts";
import type { MediaStorage } from "../storage/media-storage.ts";

async function checksum(path: string, assertOwned?: () => void | Promise<void>): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    await assertOwned?.();
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

type HeartbeatScheduler = (heartbeat: () => Promise<void>, intervalMs: number) => () => void;
type ChecksumFile = (path: string, assertOwned: () => void | Promise<void>) => Promise<string>;
const defaultHeartbeatScheduler: HeartbeatScheduler = (heartbeat, intervalMs) => {
  const timer = setInterval(() => { void heartbeat(); }, intervalMs);
  return () => clearInterval(timer);
};

function createLeaseHeartbeat(args: {
  repo: Repository; jobId: string; lockToken: string; now: () => Date; leaseSeconds: number;
  schedule: HeartbeatScheduler;
}) {
  let stopped = false;
  let lost = false;
  let inFlight: Promise<void> | null = null;
  const heartbeat = async (): Promise<void> => {
    if (stopped || lost) return;
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        if (!(await args.repo.heartbeatMediaImportJob({ jobId: args.jobId, lockToken: args.lockToken, now: args.now(), leaseSeconds: args.leaseSeconds }))) lost = true;
      } catch {
        // A failed or unavailable heartbeat is loss of ownership, never a successful renewal.
        lost = true;
      }
    })();
    inFlight = request;
    try { await request; } finally { if (inFlight === request) inFlight = null; }
  };
  const intervalMs = Math.max(1, Math.floor((args.leaseSeconds * 1000) / 3));
  const cancel = args.schedule(heartbeat, intervalMs);
  return {
    get lost() { return lost; },
    assertOwned() {
      if (lost) throw new Error("Media import lease was lost.");
    },
    heartbeat,
    async renewAndStop(): Promise<boolean> {
      if (!stopped && !lost) await heartbeat();
      stopped = true;
      cancel();
      const pending = inFlight;
      if (pending) await pending;
      return !lost;
    },
    async stop(): Promise<void> {
      stopped = true;
      cancel();
      const pending = inFlight;
      if (pending) await pending;
    },
  };
}

export type MediaImportRunResult = "idle" | "succeeded" | "failed" | "stale" | "unauthorized" | "quota";

/** One leased unit of work. A stale worker can only leave an attempt-scoped staging object; it cannot finalize. */
export async function runNextMediaImportJob(args: { repo: Repository; storage: MediaStorage; workerId: string; now?: () => Date; leaseSeconds?: number; jobId?: string; scheduleHeartbeat?: HeartbeatScheduler; checksumFile?: ChecksumFile }): Promise<MediaImportRunResult> {
  const now = args.now ?? (() => new Date());
  const leaseSeconds = args.leaseSeconds ?? 120;
  const checksumFile = args.checksumFile ?? checksum;
  const claimed = await args.repo.claimNextMediaImportJob({ workerId: args.workerId, now: now(), leaseSeconds, ...(args.jobId ? { jobId: args.jobId } : {}) });
  if (!claimed) return "idle";
  const heartbeat = createLeaseHeartbeat({ repo: args.repo, jobId: claimed.id, lockToken: claimed.lockToken!, now, leaseSeconds, schedule: args.scheduleHeartbeat ?? defaultHeartbeatScheduler });
  const discardAttempt = async (): Promise<void> => {
    if (claimed.stagingObjectKey) await args.storage.discardStaged(claimed.stagingObjectKey).catch(() => undefined);
  };
  const fail = async (reason: string): Promise<MediaImportRunResult> => {
    const stillOwner = await heartbeat.renewAndStop();
    await discardAttempt();
    if (!stillOwner) return "stale";
    const failed = await args.repo.failMediaImportJob({ jobId: claimed.id, lockToken: claimed.lockToken!, now: now(), reason }).catch(() => false);
    return failed ? "failed" : "stale";
  };
  try {
    // A previous process may have stopped after writing its attempt object. Its lease was
    // fenced out by this claim, and each attempt has a distinct staging key.
    for (const key of claimed.attemptStorageKeys) {
      heartbeat.assertOwned();
      if (key !== claimed.stagingObjectKey) await args.storage.discardStaged(key).catch(() => undefined);
    }
    const source = await args.repo.getMedia(claimed.sourceMediaId);
    const collection = await args.repo.getCollection(claimed.sourceCollectionId);
    const grants = await args.repo.getGrants(claimed.sourceCollectionId);
    heartbeat.assertOwned();
    if (!source || !collection || collection.ownerId !== source.ownerId || source.kind === "image" || !collection.mediaIds.includes(source.id) || !canImportVideo(claimed.importerId, source, collection, grants, now()).allowed) return fail("Source access is no longer authorized.");
    const sourceStorage = await args.repo.getMediaStorageInfo(source.id);
    heartbeat.assertOwned();
    if (!sourceStorage) return fail("Source media is unavailable.");
    const sourceHash = await args.storage.runWithCommittedFile(sourceStorage.storageKey, (path) => checksumFile(path, heartbeat.assertOwned));
    heartbeat.assertOwned();
    const copiedSize = await args.storage.copyCommittedToStaging(sourceStorage.storageKey, claimed.stagingObjectKey!, heartbeat.assertOwned);
    heartbeat.assertOwned();
    const leaseNow = now();
    if (!(await args.repo.markMediaImportVerifying({ jobId: claimed.id, lockToken: claimed.lockToken!, now: leaseNow }))) {
      await heartbeat.stop();
      await discardAttempt();
      return "stale";
    }
    heartbeat.assertOwned();
    const stagedSize = await args.storage.statSize(claimed.stagingObjectKey!);
    heartbeat.assertOwned();
    const stagedHash = await args.storage.runWithStagedFile(claimed.stagingObjectKey!, (path) => checksumFile(path, heartbeat.assertOwned));
    heartbeat.assertOwned();
    if (copiedSize !== source.sizeBytes || stagedSize !== source.sizeBytes || stagedHash !== sourceHash || (source.checksumSha256 && source.checksumSha256 !== sourceHash)) return fail("The copied media did not pass size and checksum verification.");
    const current = await args.repo.getMedia(source.id);
    heartbeat.assertOwned();
    if (!current || current.ownerId !== source.ownerId || current.sizeBytes !== source.sizeBytes || current.status === "deleted") return fail("Source media changed while the copy was being verified.");
    const finalKey = claimed.newObjectKey;
    const finalExists = await args.storage.exists(finalKey);
    heartbeat.assertOwned();
    if (finalExists) {
      const finalSize = await args.storage.statSize(finalKey);
      heartbeat.assertOwned();
      const finalHash = await args.storage.runWithCommittedFile(finalKey, (path) => checksumFile(path, heartbeat.assertOwned));
      heartbeat.assertOwned();
      if (finalSize !== source.sizeBytes || finalHash !== sourceHash) return fail("A previous import output failed integrity verification.");
    }
    const imported: MediaAsset = {
      ...source, id: claimed.resultMediaAssetId, ownerId: claimed.importerId, status: "active", deleteAfter: null,
      importedFromId: source.id, checksumSha256: sourceHash, hasThumbnail: false, createdAt: now(),
    };
    // Renew once before finalization, then stop the timer and await any in-flight heartbeat.
    // The repository rechecks the fencing token under its transaction locks.
    if (!(await heartbeat.renewAndStop())) { await discardAttempt(); return "stale"; }
    const result = await args.repo.finalizeMediaImportJob({
      jobId: claimed.id, lockToken: claimed.lockToken!, importerId: claimed.importerId, now: now(), media: imported, storageKey: finalKey,
      // If a prior DB transaction failed after the object commit, the deterministic key is adopted only after exact verification above.
      commitStagedObject: finalExists ? async () => undefined : () => args.storage.commit(claimed.stagingObjectKey!, finalKey),
    });
    if (result === "applied") {
      await discardAttempt();
      return "succeeded";
    }
    if (result === "quota") { await fail("There is no longer enough storage available to complete this import."); return "quota"; }
    if (result === "unauthorized") { await fail("Source access changed before this import completed."); return "unauthorized"; }
    await discardAttempt();
    return "stale";
  } catch {
    return fail("The import worker failed. The source remains available and the job can be retried.");
  } finally {
    await heartbeat.stop();
  }
}

export const newMediaImportWorkerId = (): string => randomUUID();
