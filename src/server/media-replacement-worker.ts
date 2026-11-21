import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { getPlan } from "../lib/billing/catalog.ts";
import type { RequestContext } from "./context.ts";
import { runNextMediaVerificationJob } from "./media-verification.ts";
import { mediaKeyFor, stagingKeyFor } from "./storage/media-storage.ts";

const LEASE_SECONDS = 180;
type HeartbeatScheduler = (beat: () => Promise<void>, intervalMs: number) => () => void;
const scheduleHeartbeat: HeartbeatScheduler = (beat, interval) => { const timer = setInterval(() => { void beat(); }, interval); return () => clearInterval(timer); };

async function checksum(filePath: string, assertOwned: () => void): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) { assertOwned(); hash.update(chunk as Uint8Array); }
  assertOwned(); return hash.digest("hex");
}

function createHeartbeat(ctx: RequestContext, jobId: string, ownerId: string, lockToken: string, leaseSeconds: number, scheduler: HeartbeatScheduler) {
  let lost = false; let stopped = false; let pending: Promise<void> | null = null;
  const beat = async () => {
    if (stopped || lost || pending) return pending ?? undefined;
    pending = (async () => { try { if (!(await ctx.repo.heartbeatEditedMediaReplacement({ jobId, ownerId, lockToken, now: new Date(), leaseSeconds }))) lost = true; } catch { lost = true; } })();
    try { await pending; } finally { pending = null; }
  };
  const cancel = scheduler(beat, Math.max(1000, leaseSeconds * 1000 / 3));
  return {
    get lost() { return lost; },
    assertOwned() { if (lost) throw new Error("replacement lease lost"); },
    async stop(renew = false) { if (renew && !lost) await beat(); stopped = true; cancel(); if (pending) await pending; return !lost; },
  };
}

export type MediaReplacementRunResult = "idle" | "queued_verification" | "completed" | "failed" | "stale" | "quota";

/** Copies a successful render into a normal private MediaAsset, verifies it through the standard lifecycle,
 * then atomically transfers memberships and schedules original cleanup. Only the cleanup worker deletes originals. */
export async function runNextEditedMediaReplacement(ctx: RequestContext, workerId: string, requestedJobId?: string, scheduler = scheduleHeartbeat): Promise<MediaReplacementRunResult> {
  const now = () => new Date();
  if (!ctx.media || ctx.media.unavailable || ctx.media.storage.kind === "memory") return "idle";
  const job = await ctx.repo.claimNextEditedMediaReplacement({ workerId, now: now(), leaseSeconds: LEASE_SECONDS, ...(requestedJobId ? { jobId: requestedJobId } : {}) });
  if (!job) return "idle";
  const heartbeat = createHeartbeat(ctx, job.id, job.ownerId, job.lockToken!, LEASE_SECONDS, scheduler);
  const fail = async (code: string, retryAt: Date | null = null): Promise<MediaReplacementRunResult> => {
    const owns = await heartbeat.stop(true);
    if (!owns) return "stale";
    return await ctx.repo.failEditedMediaReplacement({ jobId: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: now(), errorCode: code, retryAt }) ? (code === "quota" ? "quota" : "failed") : "stale";
  };
  const finalize = async (sourceId: string): Promise<MediaReplacementRunResult> => {
    if (!(await heartbeat.stop(true))) return "stale";
    const result = await ctx.repo.finalizeEditedMediaReplacement({ jobId: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: now(), cleanupJobId: `cleanup-${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}` });
    return result === "applied" || result === "existing" ? "completed" : result === "stale" ? "stale" : "failed";
  };
  const verifyAndFinalize = async (replacementId: string, sourceId: string): Promise<MediaReplacementRunResult> => {
    const replacement = await ctx.repo.getMedia(replacementId);
    if (!replacement || replacement.ownerId !== job.ownerId || replacement.status !== "active") return await fail("replacement_missing");
    if (replacement.validation !== "verified") {
      const state = await ctx.repo.getMediaVerificationForOwner(job.ownerId, replacement.id);
      if (state?.status === "failed" || state?.status === "incomplete") {
        if (!state.retryable || await ctx.repo.retryMediaVerification(job.ownerId, replacement.id, now()) === "not_retryable") return await fail("replacement_verification_failed");
      }
      const verificationJobId = `replacement-verification-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}`;
      const outcome = await runNextMediaVerificationJob({ ...ctx, now: now() }, workerId, verificationJobId);
      heartbeat.assertOwned();
      const verified = await ctx.repo.getMedia(replacementId);
      if (outcome !== "verified" || verified?.validation !== "verified") {
        const nextState = await ctx.repo.getMediaVerificationForOwner(job.ownerId, replacement.id);
        const retryAt = nextState?.retryable ? new Date(now().getTime() + 30_000) : null;
        return await fail("replacement_verification_incomplete", retryAt);
      }
    }
    return await finalize(sourceId);
  };
  try {
    heartbeat.assertOwned();
    const source = await ctx.repo.getMedia(job.sourceMediaAssetId);
    const derivative = await ctx.repo.getRenderOutput(job.sourceDerivativeId);
    if (!source || source.ownerId !== job.ownerId || source.status !== "active" || source.validation !== "verified" || !derivative || derivative.ownerId !== job.ownerId || derivative.sourceMediaId !== source.id) return await fail("source_or_output_changed");
    const renderJobs = await ctx.repo.listRenderJobsForOwner(job.ownerId);
    if (!renderJobs.some((entry) => entry.status === "succeeded" && entry.mediaAssetId === source.id && entry.outputDerivativeId === derivative.id)) return await fail("render_not_verified");

    if (job.replacementMediaAssetId) return await verifyAndFinalize(job.replacementMediaAssetId, source.id);

    const storage = ctx.media.storage;
    const sourceSize = await storage.statSize(derivative.storageKey); heartbeat.assertOwned();
    if (sourceSize === null || sourceSize !== derivative.sizeBytes || sourceSize <= 0) return await fail("render_output_missing");
    const stagingKey = job.stagingObjectKey ?? stagingKeyFor(`replacement-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}-${job.attempts}`);
    const finalKey = mediaKeyFor(job.ownerId, job.plannedReplacementMediaAssetId);
    const finalExists = await storage.exists(finalKey); heartbeat.assertOwned();
    const expectedHash = await storage.runWithCommittedFile(derivative.storageKey, (path) => checksum(path, heartbeat.assertOwned));
    heartbeat.assertOwned();
    if (finalExists) {
      const finalSize = await storage.statSize(finalKey); heartbeat.assertOwned();
      const finalHash = await storage.runWithCommittedFile(finalKey, (path) => checksum(path, heartbeat.assertOwned)); heartbeat.assertOwned();
      if (finalSize !== sourceSize || finalHash !== expectedHash) return await fail("replacement_object_mismatch");
    } else {
      const copiedSize = await storage.copyCommittedToStaging(derivative.storageKey, stagingKey, heartbeat.assertOwned);
      const stagedSize = await storage.statSize(stagingKey); heartbeat.assertOwned();
      const stagedHash = await storage.runWithStagedFile(stagingKey, (path) => checksum(path, heartbeat.assertOwned)); heartbeat.assertOwned();
      if (copiedSize !== sourceSize || stagedSize !== sourceSize || stagedHash !== expectedHash) return await fail("replacement_copy_mismatch");
      heartbeat.assertOwned();
      await storage.commit(stagingKey, finalKey);
    }

    const baseTitle = (source.title ?? "Edited video").replace(/\.[^./\\]+$/, "").slice(0, 220);
    const title = `${baseTitle} (edited).mp4`;
    const replacement = { ...source, id: job.plannedReplacementMediaAssetId, ownerId: job.ownerId, title, status: "active" as const, deleteAfter: null, sizeBytes: sourceSize, durationMs: null, width: null, height: null, validation: "incomplete" as const, hasThumbnail: false, checksumSha256: expectedHash, importedFromId: null, mimeType: "video/mp4", createdAt: now() };
    const verificationJobId = `replacement-verification-${createHash("sha256").update(job.id).digest("hex").slice(0, 32)}`;
    const verificationJob = { id: verificationJobId, ownerId: job.ownerId, mediaAssetId: replacement.id, status: "queued" as const, progressPercent: 0, attempts: 0, idempotencyKey: `media-verification:${replacement.id}`, lockedBy: null, lockToken: null, lockExpiresAt: null, errorMessage: null, createdAt: now(), finishedAt: null, payload: { stage: "queued", outcome: "processing", completedStages: ["uploaded_to_storage"], errorCode: null, retryable: false, updatedAt: now().toISOString(), thumbnailStatus: "skipped" } };
    const planId = await ctx.repo.getPlanIdForUser(job.ownerId, now());
    const commit = await ctx.repo.commitEditedMediaReplacement({ jobId: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: now(), media: replacement, storageKey: finalKey, verificationJob, limitBytes: getPlan(planId).limits.storageBytes });
    if (commit === "quota") { await storage.deleteUnreferencedUpload(finalKey).catch(() => undefined); return await fail("quota"); }
    if (commit !== "applied" && commit !== "existing") return await fail(`commit_${commit}`);
    await storage.discardStaged(stagingKey).catch(() => undefined);
    // Run the ordinary verification lifecycle for this exact asset/job before transfer.
    const outcome = await runNextMediaVerificationJob({ ...ctx, now: now() }, workerId, verificationJobId);
    heartbeat.assertOwned();
    const verified = await ctx.repo.getMedia(replacement.id);
    if (outcome !== "verified" || verified?.validation !== "verified") {
      const state = await ctx.repo.getMediaVerificationForOwner(job.ownerId, replacement.id);
      return await fail("replacement_verification_incomplete", state?.retryable ? new Date(now().getTime() + 30_000) : null);
    }
    return await finalize(source.id);
  } catch {
    return await fail("worker_interrupted", new Date(now().getTime() + 30_000));
  } finally { await heartbeat.stop(); }
}

export const newMediaReplacementWorkerId = (): string => randomUUID();
