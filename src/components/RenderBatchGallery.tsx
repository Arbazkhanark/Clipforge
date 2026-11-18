"use client";

import { useRef, useState } from "react";
import { MediaThumbnail } from "./MediaThumbnail.tsx";

export type RenderBatchGalleryItem = {
  title: string;
  mediaId: string;
  status: "queued" | "processing" | "completed" | "failed" | "refused";
  message: string | null;
  outputId: string | null;
  hasThumbnail: boolean;
  durationMs: number | null;
};

const statusLabel: Record<RenderBatchGalleryItem["status"], string> = {
  queued: "Queued",
  processing: "Rendering",
  completed: "Ready",
  failed: "Failed",
  refused: "Not eligible",
};

export function RenderBatchGallery({ items }: { items: RenderBatchGalleryItem[] }) {
  const [active, setActive] = useState<RenderBatchGalleryItem | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const finished = items.filter((item) => ["completed", "failed", "refused"].includes(item.status)).length;

  function openPreview(item: RenderBatchGalleryItem) {
    setActive(item);
    requestAnimationFrame(() => {
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    });
  }

  function closePreview() {
    dialogRef.current?.close();
    setActive(null);
  }

  return (
    <>
      <section className="render-batch-page" aria-labelledby="render-batch-heading">
        <header className="render-batch-header">
          <div>
            <p className="render-batch-eyebrow">CLIPFORGE STUDIO · EXPORTS</p>
            <h1 id="render-batch-heading">Your render batch</h1>
            <p>Review each video, its render status, and any action needed.</p>
          </div>
          <div className="render-batch-progress" aria-label={`${finished} of ${items.length} items finished`}>
            <strong>{finished}<span> / {items.length}</span></strong>
            <small>finished</small>
          </div>
        </header>

        <div className="render-batch-summary" role="status">
          <span className="render-batch-summary-icon" aria-hidden="true">{finished === items.length ? "✓" : "↻"}</span>
          <p><strong>{finished === items.length ? "Batch review complete" : "Your exports are being prepared"}</strong><br />Each successful export is a new file. Originals and successful exports are not changed by another item&apos;s failure.</p>
          <div className="render-batch-counts">
            {(["completed", "processing", "queued", "failed", "refused"] as const).map((status) => {
              const count = items.filter((item) => item.status === status).length;
              return count > 0 ? <span key={status} data-status={status}>{count} {statusLabel[status].toLowerCase()}</span> : null;
            })}
          </div>
        </div>

        {items.length === 0 ? <div className="render-batch-empty"><strong>No videos in this batch</strong><p>Return to the editor and choose videos to render.</p><a href="/editor">Open video editor</a></div> : (
          <div className="render-batch-grid" aria-label="Videos in this render batch">
            {items.map((item) => (
              <article className="render-batch-card" key={item.mediaId}>
                <button className="render-batch-cover" type="button" onClick={() => openPreview(item)} aria-label={`Watch preview of ${item.title}`}>
                  <span className="render-batch-thumbnail">
                    {item.status === "completed" && item.outputId
                      ? <video className="render-batch-edited-preview" src={`/api/renders/preview?id=${encodeURIComponent(item.outputId)}`} muted playsInline preload="metadata" aria-label={`Edited export preview of ${item.title}`} />
                      : <MediaThumbnail media={{ id: item.mediaId, hasThumbnail: item.hasThumbnail, kind: "video" }} />}
                  </span>
                  <span className="render-batch-play" aria-hidden="true">▶</span>
                  <span className={`render-batch-status is-${item.status}`}>{statusLabel[item.status]}</span>
                  {item.status === "completed" && item.outputId && <span className="render-batch-preview-kind">Edited export</span>}
                  {!(item.status === "completed" && item.outputId) && <span className="render-batch-preview-kind">Original upload</span>}
                  {item.durationMs && <span className="render-batch-duration">{Math.max(1, Math.round(item.durationMs / 1000))} sec</span>}
                </button>
                <div className="render-batch-card-body">
                  <h2 title={item.title}>{item.title}</h2>
                  {item.message && <p className={`render-batch-message is-${item.status}`}>{item.message}</p>}
                  <div className="render-batch-actions">
                    {item.status === "completed" && item.outputId ? <a className="render-batch-download" href={`/api/renders/file?id=${encodeURIComponent(item.outputId)}`}>Download export</a> : <span className="render-batch-action-hint">{item.status === "refused" ? "Update the source checks, then render again." : item.status === "failed" ? "Review the video and try again." : "This is a preview of your original upload."}</span>}
                    <a className="render-batch-edit" href={`/editor?media=${encodeURIComponent(item.mediaId)}`}>Edit video <span aria-hidden="true">→</span></a>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <dialog ref={dialogRef} className="render-batch-dialog" aria-label={active ? `Video preview: ${active.title}` : "Video preview"} onClose={() => setActive(null)}>
        {active && <div className="render-batch-dialog-content">
          <header><div><p className="render-batch-eyebrow">VIDEO PREVIEW · {statusLabel[active.status].toUpperCase()}</p><h2>{active.title}</h2></div><button type="button" className="render-batch-close" onClick={closePreview} aria-label="Close video preview">×</button></header>
          <video key={`${active.mediaId}:${active.outputId ?? "original"}`} src={active.status === "completed" && active.outputId ? `/api/renders/preview?id=${encodeURIComponent(active.outputId)}` : `/api/media/file?id=${encodeURIComponent(active.mediaId)}&variant=preview`} controls playsInline preload="metadata" />
          <p className="render-batch-preview-note">{active.status === "completed" && active.outputId ? "Playing the finished edited export." : "No finished export is available for this item yet; this is the original upload preview."}</p>
          {active.message && <p className={`render-batch-message is-${active.status}`}>{active.message}</p>}
          <footer><a href={`/editor?media=${encodeURIComponent(active.mediaId)}`}>Edit this video</a>{active.status === "completed" && active.outputId && <a className="render-batch-download" href={`/api/renders/file?id=${encodeURIComponent(active.outputId)}`}>Download export</a>}</footer>
        </div>}
      </dialog>
    </>
  );
}
