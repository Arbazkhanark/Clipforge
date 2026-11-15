import type { MediaVerificationJobRecord, MediaVerificationState, MediaVerificationStage } from "./repository.ts";

const stages: MediaVerificationStage[] = ["queued", "uploading", "uploaded_to_storage", "storage_verifying", "storage_verified", "media_probing", "media_verified", "thumbnail_generating", "thumbnail_verifying", "thumbnail_verified", "thumbnail_skipped", "completed"];
const thumbnails = ["pending", "verified", "failed", "skipped"] as const;
const messages: Record<string, string> = {
  storage_missing: "The uploaded object could not be found in private storage.",
  storage_unavailable: "Private storage could not be checked. You can retry verification.",
  storage_size_mismatch: "The stored file size did not match the uploaded file.",
  storage_checksum_mismatch: "The stored file did not match its upload checksum.",
  media_probe_unavailable: "Media verification is waiting for ffprobe on the worker.",
  media_probe_failed: "The stored media could not be decoded by the media probe.",
  media_metadata_mismatch: "The stored media metadata did not match the upload record.",
  worker_interrupted: "A verification worker stopped before completing. You can retry verification.",
};

export function mediaVerificationStateFromJob(job: MediaVerificationJobRecord | undefined, mediaId: string): MediaVerificationState {
  if (!job) return { mediaId, status: "legacy_unverified", stage: "queued", completedStages: [], errorCode: "legacy_unverified", errorMessage: "This upload predates end-to-end storage verification and has not been rechecked.", attempts: 0, retryable: false, updatedAt: null, thumbnailStatus: "skipped" };
  const payload = typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : {};
  const stage = stages.includes(payload["stage"] as MediaVerificationStage) ? payload["stage"] as MediaVerificationStage : "queued";
  const completedStages = Array.isArray(payload["completedStages"]) ? payload["completedStages"].filter((value): value is MediaVerificationStage => stages.includes(value as MediaVerificationStage)) : [];
  const status = payload["outcome"] === "verified" && job.status === "succeeded" ? "verified" : payload["outcome"] === "failed" && job.status === "failed" ? "failed" : payload["outcome"] === "incomplete" && job.status === "failed" ? "incomplete" : "processing";
  const errorCode = typeof payload["errorCode"] === "string" && Object.hasOwn(messages, payload["errorCode"]) ? payload["errorCode"] : null;
  const updatedAt = typeof payload["updatedAt"] === "string" && Number.isFinite(Date.parse(payload["updatedAt"])) ? new Date(payload["updatedAt"]) : job.finishedAt ?? job.createdAt;
  return { mediaId, status, stage, completedStages, errorCode, errorMessage: errorCode ? messages[errorCode] ?? null : null, attempts: job.attempts, retryable: payload["retryable"] === true, updatedAt, thumbnailStatus: thumbnails.includes(payload["thumbnailStatus"] as typeof thumbnails[number]) ? payload["thumbnailStatus"] as typeof thumbnails[number] : "pending" };
}
