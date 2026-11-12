"use client";

import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { UploadInfo } from "../server/queries.ts";

const ACCEPT = ".mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp";

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileType(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toUpperCase();
  return extension ? `${extension} file` : "Unknown file type";
}

/**
 * Keeps the existing multipart form endpoint. Drag-and-drop simply places one
 * file in the same native input used by the picker; validation and storage
 * remain on the server.
 */
export function UploadForm({ info }: { info: UploadInfo }) {
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState("");

  useEffect(() => {
    // Dropping a file outside the zone must not navigate the browser to it.
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);

  function setSelectedFile(selected: File | null, extraMessage = "") {
    setFile(selected);
    setSelectionMessage(selected ? extraMessage : "No file selected.");
  }

  function handlePickerChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFile(event.currentTarget.files?.[0] ?? null);
  }

  type DropEvent = globalThis.DragEvent & { currentTarget: HTMLDivElement };

  function handleDragOver(event: DropEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDrop(event: DropEvent) {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    const selected = files[0] ?? null;
    if (!selected || !inputElement) return;

    // The existing upload endpoint accepts one `file` field per request.
    // Do not silently discard additional dropped files.
    if (files.length > 1) {
      setSelectionMessage("This upload form accepts one file at a time. The first file is selected; upload the others separately.");
    } else {
      setSelectionMessage("File ready to upload.");
    }
    const transfer = new DataTransfer();
    transfer.items.add(selected);
    inputElement.files = transfer.files;
    setFile(selected);
  }

  function handleSubmit() {
    if (!file) return;
    setSubmitting(true);
  }

  function removeFile() {
    if (inputElement) inputElement.value = "";
    setSelectedFile(null);
    setSubmitting(false);
  }

  return (
    <section aria-labelledby="upload-heading" className="media-upload-card">
      <div className="media-upload-details">
        <h3 id="upload-heading">Upload your media</h3>
        <p>Drag and drop your videos or images here, or browse files from your device.</p>
        <p className="media-upload-limits">
          MP4, MOV or WebM video · JPEG, PNG or WebP images · Up to {info.maxMegabytes} MB per file
        </p>
        <p role="note" className="media-upload-storage-note" data-storage-kind={info.storageKind ?? "none"}>
          Storage: <strong>{info.storage.label}</strong>. {info.storage.warning}
        </p>
      </div>

      {info.available ? (
        <form
          className="media-upload-form"
          method="post"
          action="/api/forms/media-upload"
          encType="multipart/form-data"
          onSubmit={handleSubmit}
        >
          <div
            className={`media-drop-zone${dragActive ? " is-drag-active" : ""}${file ? " has-file" : ""}`}
            role="region"
            onDragEnter={(event: DropEvent) => {
              if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={handleDragOver}
            onDragLeave={(event: DropEvent) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
            }}
            onDrop={handleDrop}
            aria-label="Media upload drop area"
          >
            <span className="media-drop-icon" aria-hidden="true">↑</span>
            <strong>{dragActive ? "Drop your file to add it" : "Drop a file here"}</strong>
            <span>or choose one from your device</span>
            <input
              ref={setInputElement}
              className="media-file-input"
              type="file"
              name="file"
              accept={ACCEPT}
              required
              onChange={handlePickerChange}
              aria-label="Choose a video or image to upload"
            />
            <button
              type="button"
              className="media-select-files-button"
              onClick={() => inputElement?.click()}
              disabled={submitting}
            >
              Select Files
            </button>
            <span className="media-upload-accessible-hint">One file per upload. You can repeat this for more files.</span>
          </div>

          {file && (
            <div className="media-upload-queue" aria-label="Upload queue">
              <span className={`media-queue-file-icon ${file.type.startsWith("image/") ? "is-image" : ""}`} aria-hidden="true">
                {file.type.startsWith("image/") ? "▧" : "▶"}
              </span>
              <div className="media-queue-file-details">
                <strong title={file.name}>{file.name}</strong>
                <span>{fileType(file)} · {formatFileSize(file.size)}</span>
                <span className="media-upload-status">{submitting ? "Uploading…" : "Ready to upload"}</span>
              </div>
              {!submitting && (
                <button type="button" className="media-remove-file-button" onClick={removeFile} aria-label={`Remove ${file.name}`}>
                  Remove
                </button>
              )}
            </div>
          )}
          <p className="media-upload-live-status" aria-live="polite">{selectionMessage}</p>
          <div className="media-upload-actions">
            <button type="submit" className="media-upload-submit-button" disabled={!file || submitting}>
              {submitting ? "Uploading…" : "Upload media"}
            </button>
          </div>
        </form>
      ) : (
        <p className="media-upload-unavailable">Uploads are not available in this build until storage is configured.</p>
      )}
      <p className="media-upload-cloud-note">Cloud (S3) storage is not connected.</p>
    </section>
  );
}
