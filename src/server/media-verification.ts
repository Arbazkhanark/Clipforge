import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { RequestContext } from "./context.ts";
import type { MediaVerificationJobRecord, MediaVerificationStage } from "./repository.ts";
import { CANONICAL_MIME, sniffMedia } from "./storage/media-inspection.ts";

const LEASE_SECONDS = 180;
const AUTO_RETRY_LIMIT = 3;
const PROBE_TIMEOUT_MS = 120_000;
type FailureCode = "storage_missing" | "storage_unavailable" | "storage_size_mismatch" | "storage_checksum_mismatch" | "media_probe_unavailable" | "media_probe_failed" | "media_metadata_mismatch";
class VerificationFailure extends Error {
  constructor(readonly code: FailureCode, readonly retryable = false, readonly outcome: "failed" | "incomplete" = "failed") { super(code); }
}

async function checksumFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readHeader(filePath: string): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try { const bytes = new Uint8Array(32); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, bytesRead); }
  finally { await handle.close(); }
}

function payloadObject(payload: unknown): Record<string, unknown> { return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : {}; }

export async function runNextMediaVerificationJob(ctx: RequestContext, workerId: string, requestedJobId?: string): Promise<"idle" | "verified" | "failed" | "incomplete"> {
  const job = await ctx.repo.claimNextMediaVerificationJob({ workerId, now: ctx.now, leaseSeconds: LEASE_SECONDS, ...(requestedJobId ? { jobId: requestedJobId } : {}) });
  if (!job) return "idle";
  const media = await ctx.repo.getMedia(job.mediaAssetId);
  const storageInfo = media?.ownerId === job.ownerId && media.status === "active" ? await ctx.repo.getMediaStorageInfo(media.id) : null;
  let payload = payloadObject(job.payload);
  let stage = payload["stage"] as MediaVerificationStage;
  let completed = Array.isArray(payload["completedStages"]) ? payload["completedStages"].filter((value): value is MediaVerificationStage => typeof value === "string") : [];
  let thumbnailStatus: "pending" | "verified" | "failed" | "skipped" = media?.hasThumbnail ? "pending" : "skipped";
  const update = async (next: MediaVerificationStage) => {
    stage = next; payload = { ...payload, stage, outcome: "processing", completedStages: completed, thumbnailStatus, updatedAt: new Date().toISOString() };
    const saved = await ctx.repo.updateMediaVerificationJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: new Date(), leaseSeconds: LEASE_SECONDS, payload });
    if (!saved) throw new VerificationFailure("storage_unavailable", true);
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let activeFailure: VerificationFailure | null = null;
  try {
    if (!media || media.ownerId !== job.ownerId || media.status !== "active" || !storageInfo) throw new VerificationFailure("storage_missing");
    if (!ctx.media || ctx.media.unavailable) throw new VerificationFailure("storage_unavailable", true);
    const storage = ctx.media.storage;
    await update("storage_verifying");
    heartbeat = setInterval(() => { void ctx.repo.updateMediaVerificationJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: new Date(), leaseSeconds: LEASE_SECONDS, payload }).catch(() => undefined); }, 45_000);
    const metadata = await storage.getPrivateMetadata(storageInfo.storageKey).catch(() => { throw new VerificationFailure("storage_unavailable", true); });
    if (!metadata) throw new VerificationFailure("storage_missing");
    if (metadata.sizeBytes !== media.sizeBytes) throw new VerificationFailure("storage_size_mismatch");
    if (metadata.storageKind === "s3" && metadata.contentType !== media.mimeType) throw new VerificationFailure("media_metadata_mismatch");
    await update("storage_verified"); completed = [...completed, "storage_verified"];
    if (!ctx.media.probe) throw new VerificationFailure("media_probe_unavailable", true, "incomplete");
    await update("media_probing");
    const probed = await storage.runWithCommittedFile(storageInfo.storageKey, async (filePath) => {
      const info = await stat(filePath);
      if (!info.isFile() || info.size !== media.sizeBytes) throw new VerificationFailure("storage_size_mismatch");
      const header = await readHeader(filePath); const sniffed = sniffMedia(header);
      if (!sniffed || sniffed.kind !== media.kind || CANONICAL_MIME[sniffed.type] !== media.mimeType) throw new VerificationFailure("media_metadata_mismatch");
      if (!media.checksumSha256 || await checksumFile(filePath) !== media.checksumSha256) throw new VerificationFailure("storage_checksum_mismatch");
      return ctx.media!.probe!(filePath, PROBE_TIMEOUT_MS).catch(() => { throw new VerificationFailure("media_probe_failed"); });
    }).catch((error) => {
      if (error instanceof VerificationFailure) throw error;
      throw new VerificationFailure("storage_unavailable", true);
    });
    if (!(probed.width > 0 && probed.height > 0) || (media.kind === "video" && !(probed.durationSeconds > 0))) throw new VerificationFailure("media_probe_failed");
    completed = [...completed, "media_verified"];
    if (media.hasThumbnail && storageInfo.thumbnailKey) {
      try {
        await update("thumbnail_verifying");
        const thumbnailMeta = await storage.getPrivateMetadata(storageInfo.thumbnailKey);
        if (!thumbnailMeta || thumbnailMeta.sizeBytes <= 0) throw new Error("thumbnail unavailable");
        await storage.runWithCommittedFile(storageInfo.thumbnailKey, async (filePath) => {
          const image = await readHeader(filePath);
          if (image[0] !== 0xff || image[1] !== 0xd8 || !(await stat(filePath)).isFile()) throw new Error("invalid thumbnail");
          const decoded = await ctx.media!.probe!(filePath, PROBE_TIMEOUT_MS).catch(() => null);
          if (!decoded || !(decoded.width > 0 && decoded.height > 0)) throw new Error("thumbnail decode failed");
        });
        thumbnailStatus = "verified"; completed = [...completed, "thumbnail_verified"];
      } catch { thumbnailStatus = "failed"; }
    } else { thumbnailStatus = "skipped"; completed = [...completed, "thumbnail_skipped"]; }
    await update("completed"); completed = [...completed, "completed"];
    payload = { ...payload, stage: "completed", outcome: "verified", completedStages: completed, errorCode: null, retryable: false, thumbnailStatus, updatedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString() };
    if (!(await ctx.repo.completeMediaVerificationJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, finishedAt: new Date(), payload, width: probed.width, height: probed.height, durationMs: media.kind === "video" ? Math.round(probed.durationSeconds * 1000) : null }))) throw new VerificationFailure("storage_unavailable", true);
    return "verified";
  } catch (error) {
    activeFailure = error instanceof VerificationFailure ? error : new VerificationFailure("storage_unavailable", true);
    const retryAt = activeFailure.retryable && job.attempts < AUTO_RETRY_LIMIT ? new Date(Date.now() + 15_000 * (2 ** (job.attempts - 1))) : undefined;
    payload = { ...payload, stage, outcome: retryAt ? "processing" : activeFailure.outcome, completedStages: completed, errorCode: activeFailure.code, retryable: activeFailure.retryable && job.attempts < 6, thumbnailStatus, updatedAt: new Date().toISOString() };
    const messages: Record<FailureCode, string> = { storage_missing: "The committed private object is missing.", storage_unavailable: "Private storage could not be verified.", storage_size_mismatch: "Stored size does not match the uploaded file.", storage_checksum_mismatch: "Stored bytes do not match the upload checksum.", media_probe_unavailable: "The worker does not have ffprobe available.", media_probe_failed: "The stored media could not be decoded.", media_metadata_mismatch: "Stored media does not match its recorded type." };
    await ctx.repo.failMediaVerificationJob({ id: job.id, ownerId: job.ownerId, lockToken: job.lockToken!, now: new Date(), payload, errorMessage: messages[activeFailure.code], ...(retryAt ? { retryAt } : {}) });
    return activeFailure.outcome === "incomplete" ? "incomplete" : "failed";
  } finally { if (heartbeat) clearInterval(heartbeat); }
}

export const newMediaVerificationId = (): string => randomUUID();
