"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { UploadInfo } from "../server/queries.ts";
import type { MediaVerificationState } from "../server/repository.ts";
import { MediaVerificationStatus } from "./MediaVerificationStatus.tsx";
import { retryableUploads, runBoundedUploads, UploadRunGuard } from "./upload-queue.ts";

const ACCEPT = ".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp";
const UPLOAD_CONCURRENCY = 2;

type UploadState = "queued" | "uploading" | "failed";
type QueueItem = { id: string; file: File; status: UploadState; progress: number; error?: string; uncertain?: boolean };
type UploadedItem = { id: string; name: string; mediaId: string; storage: string; destinationConfirmed: boolean; verification: MediaVerificationState };

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toUpperCase();
  return extension ? `${extension} file` : "Unknown file type";
}

function safeResponseError(xhr: XMLHttpRequest): { message: string; uncertain: boolean } {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return { message: body.error.message, uncertain: xhr.status >= 500 };
  } catch { /* The server response is not shown verbatim. */ }
  return { message: xhr.status >= 500 ? "The server could not confirm whether this file was saved. Check your library before retrying." : "This file could not be uploaded.", uncertain: xhr.status >= 500 };
}

function uploadOne(file: File, onProgress: (percent: number) => void, collectionId?: string): Promise<{ mediaId: string; storage: string; collectionId?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/forms/media-upload");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const error = safeResponseError(xhr);
        reject(Object.assign(new Error(error.message), { uncertain: error.uncertain }));
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as { mediaId?: unknown; storage?: unknown; verificationStatus?: unknown; collectionId?: unknown };
        if (typeof body.mediaId !== "string" || typeof body.storage !== "string" || body.verificationStatus !== "processing") throw new Error("invalid upload response");
        if (collectionId && body.collectionId !== collectionId) throw new Error("collection association was not confirmed");
        resolve({ mediaId: body.mediaId, storage: body.storage, ...(typeof body.collectionId === "string" ? { collectionId: body.collectionId } : {}) });
      } catch {
        reject(Object.assign(new Error("The server may have saved this file, but its result could not be confirmed. Check your library before retrying."), { uncertain: true }));
      }
    });
    xhr.addEventListener("error", () => reject(Object.assign(new Error("The connection ended before this upload could be confirmed. Check your library before retrying."), { uncertain: true })));
    xhr.addEventListener("abort", () => reject(Object.assign(new Error("The upload was interrupted. Check your library before retrying."), { uncertain: true })));
    const form = new FormData();
    form.append("file", file, file.name);
    if (collectionId) form.append("collectionId", collectionId);
    xhr.send(form);
  });
}

function destinationDescription(info: UploadInfo): string {
  const destination = info.destination;
  if (!destination) return "Storage destination unavailable";
  if (destination.provider === "s3") return `AWS S3 · ${destination.environment === "production" ? "Production" : "Development"} · ${destination.bucket} · ${destination.region} · Private`;
  return `${destination.providerLabel} · ${destination.locationLabel} · Private`;
}

function storageProviderLabel(info: UploadInfo): string {
  return info.destination?.providerLabel ?? "Unavailable";
}

/** Reuses the existing, server-validated single-file endpoint with bounded client concurrency. */
export function UploadForm({ info, collectionId, collectionName }: { info: UploadInfo; collectionId?: string; collectionName?: string }) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [uploaded, setUploaded] = useState<UploadedItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState("");
  const activeRun = useRef(new UploadRunGuard());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  function addFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setQueue((current) => [...current, ...selected.map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as const, progress: 0 }))]);
    setSelectionMessage(`${selected.length} file${selected.length === 1 ? "" : "s"} ready to upload.`);
  }

  function handlePickerChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  }

  async function uploadBatch(items: QueueItem[]) {
    if (!info.available || items.length === 0 || !activeRun.current.begin()) return;
    setUploading(true);
    setSelectionMessage(`Uploading ${items.length} file${items.length === 1 ? "" : "s"} with up to ${UPLOAD_CONCURRENCY} at a time.`);
    setQueue((current) => current.map((item) => items.some((candidate) => candidate.id === item.id) ? { ...item, status: "uploading", progress: 0, error: undefined, uncertain: false } : item));
    let succeeded = 0;
    let failed = 0;
    await runBoundedUploads(items, UPLOAD_CONCURRENCY, async (item) => {
      try {
        const result = await uploadOne(item.file, (progress) => setQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, progress } : candidate)), collectionId);
        const destinationConfirmed = result.storage === info.storageKind && info.destination !== null;
        setUploaded((current) => [...current, { id: item.id, name: item.file.name, mediaId: result.mediaId, storage: result.storage, destinationConfirmed, verification: { mediaId: result.mediaId, status: "processing", stage: "queued", completedStages: [], errorCode: null, errorMessage: null, attempts: 0, retryable: false, updatedAt: null, thumbnailStatus: "pending" } }]);
        setQueue((current) => current.filter((candidate) => candidate.id !== item.id));
        succeeded += 1;
      } catch (error) {
        const uncertain = typeof error === "object" && error !== null && "uncertain" in error && error.uncertain === true;
        setQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "failed", progress: 0, error: error instanceof Error ? error.message : "This file could not be uploaded.", uncertain } : candidate));
        failed += 1;
      }
    });
    activeRun.current.end();
    setUploading(false);
    setSelectionMessage(`${succeeded} uploaded${failed ? ` · ${failed} failed` : ""}.`);
  }

  const retryable = retryableUploads(queue);
  const successfulCount = uploaded.length;
  const failedCount = queue.filter((item) => item.status === "failed").length;

  return (
    <section aria-labelledby="upload-heading" className="media-upload-card">
      <div className="media-upload-details">
        <h3 id="upload-heading">Upload your media</h3>
        <p>Drag and drop your videos or images here, or browse files from your device.</p>
        {collectionId && <p className="upload-collection-note">Uploads will be added to <strong>{collectionName ?? "this collection"}</strong> after the media and verification job are saved together.</p>}
        <p className="media-upload-limits">MP4, MOV or WebM video · JPEG, PNG or WebP images · Up to {info.maxMegabytes} MB per file</p>
      </div>

      <section className="media-storage-info" aria-label="Media storage information" data-storage-status={info.storageStatus} data-storage-kind={info.storageKind ?? "none"}>
        <div className="media-storage-info-heading">
          <div><span className="media-storage-label">STORAGE</span><strong>{info.available ? "Ready for uploads" : "Unavailable"}</strong></div>
          <span className={`media-storage-state${info.available ? " is-available" : " is-unavailable"}`}>{info.available ? "Available" : "Unavailable"}</span>
        </div>
        <dl className="media-storage-details">
          <div><dt>Provider</dt><dd>{storageProviderLabel(info)}</dd></div>
          {info.destination?.provider === "s3" ? <>
            <div><dt>Environment</dt><dd>{info.destination.environment === "production" ? "Production" : "Development"}</dd></div>
            <div><dt>Bucket</dt><dd>{info.destination.bucket}</dd></div>
            <div><dt>Region</dt><dd>{info.destination.region}</dd></div>
          </> : <div><dt>Location</dt><dd>{info.destination?.locationLabel ?? "Not configured"}</dd></div>}
          <div><dt>Privacy</dt><dd>{info.destination?.privacy ?? "Not confirmed"}</dd></div>
        </dl>
        <p className="media-storage-warning">{info.storage.warning}</p>
      </section>

      {info.available ? <>
        <div className={`media-drop-zone${dragActive ? " is-drag-active" : ""}${queue.length ? " has-file" : ""}`}
          role="region" aria-label="Media upload drop area"
          onDragEnter={(event: DragEvent<HTMLDivElement>) => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragActive(true); } }}
          onDragOver={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragActive(true); }}
          onDragLeave={(event: DragEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
          onDrop={handleDrop}>
          <span className="media-drop-icon" aria-hidden="true">↑</span>
          <strong>{dragActive ? "Drop your files to add them" : "Drop files here"}</strong>
          <span>Choose multiple videos or images in one selection</span>
          <input ref={input} className="media-file-input" type="file" accept={ACCEPT} multiple onChange={handlePickerChange} aria-label="Choose videos and images to upload" />
          <button type="button" className="media-select-files-button" onClick={() => input.current?.click()} disabled={uploading}>Select Files</button>
          <span className="media-upload-accessible-hint">Each file is validated and uploaded separately.</span>
        </div>

        {queue.length > 0 && <section className="media-upload-queue-list" aria-label="Pending uploads">
          <div className="media-upload-queue-heading"><h4>Pending uploads <span>{queue.length}</span></h4><button type="button" className="media-upload-secondary" onClick={() => setQueue((current) => current.filter((item) => item.status !== "queued"))} disabled={uploading}>Remove queued files</button></div>
          {queue.map((item) => <article className="media-upload-queue" key={item.id}>
            <span className={`media-queue-file-icon${item.file.type.startsWith("image/") ? " is-image" : ""}`} aria-hidden="true">{item.file.type.startsWith("image/") ? "▧" : "▶"}</span>
            <div className="media-queue-file-details"><strong title={item.file.name}>{item.file.name}</strong><span>{fileType(item.file)} · {formatFileSize(item.file.size)}</span>
              <span className={`media-upload-status is-${item.status}`} role="status">{item.status === "queued" ? "Ready" : item.status === "uploading" ? `Uploading · ${item.progress}%` : item.uncertain ? "Needs confirmation" : "Upload failed"}</span>
              {item.error && <span className="media-upload-error">{item.error}</span>}
              {item.status === "uploading" && <progress max="100" value={item.progress} aria-label={`Upload progress for ${item.file.name}`}>{item.progress}%</progress>}
            </div>
            {item.status === "failed" && !item.uncertain ? <button type="button" className="media-upload-secondary" onClick={() => setQueue((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, status: "queued", progress: 0, error: undefined } : candidate))} disabled={uploading}>Retry</button>
              : item.status === "queued" || item.status === "failed" ? <button type="button" className="media-remove-file-button" onClick={() => setQueue((current) => current.filter((candidate) => candidate.id !== item.id))} disabled={uploading} aria-label={`Remove ${item.file.name}`}>Remove</button> : null}
          </article>)}
          {queue.some((item) => item.uncertain) && <p className="media-upload-caution" role="alert">Some results could not be confirmed. Refresh or search your library before attempting those files again.</p>}
          <div className="media-upload-actions">
            {retryable.length > 0 && <button type="button" className="media-upload-secondary" onClick={() => void uploadBatch(retryable)} disabled={uploading}>Retry failed files ({retryable.length})</button>}
            <button type="button" className="media-upload-submit-button" onClick={() => void uploadBatch(queue.filter((item) => item.status === "queued"))} disabled={uploading || queue.every((item) => item.status !== "queued")}>
              {uploading ? "Uploading…" : `Upload ${queue.filter((item) => item.status === "queued").length} selected`}
            </button>
          </div>
        </section>}

        <p className="media-upload-live-status" aria-live="polite">{selectionMessage}</p>
        {(successfulCount > 0 || failedCount > 0) && <section className="media-upload-results" aria-label="Upload results">
          <div className="media-upload-results-heading"><h4>Upload summary</h4><span>{successfulCount} successful · {failedCount} failed</span></div>
          {uploaded.map((item) => <div className="media-upload-result-item" key={item.id}><p><strong>{item.name}</strong><span>{item.destinationConfirmed ? `Saved to ${destinationDescription(info)}` : `Upload saved; destination could not be confirmed. Storage type: ${item.storage}.`}</span></p><MediaVerificationStatus mediaId={item.mediaId} initial={item.verification} /></div>)}
          <button type="button" className="media-upload-secondary" onClick={() => window.location.reload()}>Refresh media library</button>
        </section>}
      </> : <p className="media-upload-unavailable" role="status">Uploads are unavailable: {info.storage.warning}</p>}
    </section>
  );
}
