import type { MediaDetail } from "../server/queries.ts";
import { formatDateTime, formatDuration, formatStorage } from "./format.ts";

const fileUrl = (id: string, variant: "thumbnail" | "preview" | "download") => `/api/media/file?id=${encodeURIComponent(id)}&variant=${variant}`;

/** Your own file: metadata, an inline preview of the original, and the existing actions. */
export function MediaDetailView({ detail, timeZone }: { detail: MediaDetail; timeZone: string }) {
  const m = detail.media;
  const isVideo = m.kind === "video";

  return (
    <main className="media-page media-detail-page" aria-labelledby="media-detail-heading">
      <nav className="media-detail-breadcrumb" aria-label="Breadcrumb">
        <a href="/media">Media Library</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Media Details</span>
      </nav>

      <header className="media-detail-header">
        <div className="media-detail-heading-copy">
          <span className="dashboard-eyebrow">MEDIA DETAILS</span>
          <h1 id="media-detail-heading" title={m.title}>{m.title}</h1>
          <p>Review the original file, its checks and available actions.</p>
        </div>
        <div className="media-detail-header-meta">
          <span className={`media-detail-status media-detail-status-${m.status}`}>
            <span aria-hidden="true" />{m.status === "pending_deletion" ? "Scheduled for removal" : m.status === "deleted" ? "Deleted" : "Active"}
          </span>
          <a className="media-detail-back-link" href="/media">← Back to media library</a>
        </div>
      </header>

      <div className="media-detail-layout">
        <section className="media-detail-preview-section" aria-labelledby="preview-heading">
          <div className="media-detail-section-heading">
            <div>
              <span className="dashboard-eyebrow">ORIGINAL FILE</span>
              <h2 id="preview-heading">Preview</h2>
            </div>
            <span className="media-detail-kind">{isVideo ? "Video" : "Image"}</span>
          </div>
          <div
            className={`media-detail-preview-frame${isVideo ? " is-video" : " is-image"}${isVideo && m.width && m.height && m.height > m.width ? " is-portrait" : ""}`}
            style={m.width && m.height ? { aspectRatio: `${m.width} / ${m.height}` } : undefined}
          >
            {isVideo ? (
              <video
                className="media-detail-video"
                controls
                preload="metadata"
                width={960}
                poster={m.hasThumbnail ? fileUrl(m.id, "thumbnail") : undefined}
                src={fileUrl(m.id, "preview")}
              >
                Your browser cannot play this video. You can download it instead.
              </video>
            ) : (
              <img className="media-detail-image" src={fileUrl(m.id, "preview")} alt={`Preview of ${m.title}`} />
            )}
          </div>
          {isVideo && !m.hasThumbnail && <p className="media-detail-preview-note">No preview image was created for this video. The original file is unchanged.</p>}
          {detail.importedCopy && <p className="media-detail-context-note">This is an independently imported copy in your library.</p>}
        </section>

        <aside className="media-detail-side-panel" aria-label="Media information and actions">
          <section className="media-detail-info-panel" aria-labelledby="meta-heading">
            <div className="media-detail-section-heading compact">
              <div>
                <span className="dashboard-eyebrow">FILE INFORMATION</span>
                <h2 id="meta-heading">Details</h2>
              </div>
            </div>
            <dl className="media-detail-metadata">
              <div><dt>File type</dt><dd>{detail.mimeType ?? "Unknown"}</dd></div>
              <div><dt>File size</dt><dd>{formatStorage(m.sizeBytes)}</dd></div>
              {isVideo && <div><dt>Duration</dt><dd>{formatDuration(m.durationMs)}</dd></div>}
              <div><dt>Resolution</dt><dd>{m.width && m.height ? `${m.width} × ${m.height}` : "Unknown"}</dd></div>
              <div><dt>File check</dt><dd>{m.validation === "verified" ? "Verified — decoded and measured" : m.validation === "incomplete" ? "Incomplete — signature accepted; ffprobe unavailable" : "Unknown"}</dd></div>
              <div><dt>Added</dt><dd>{detail.addedAt ? formatDateTime(detail.addedAt, timeZone) : "Unknown"}</dd></div>
            </dl>
          </section>

          <section className="media-detail-actions-panel" aria-labelledby="media-actions-heading">
            <div className="media-detail-section-heading compact">
              <div>
                <span className="dashboard-eyebrow">AVAILABLE ACTIONS</span>
                <h2 id="media-actions-heading">Use this file</h2>
              </div>
            </div>
            <div className="media-detail-action-links">
              {isVideo && <a className="media-detail-primary-action" href={`/editor?media=${encodeURIComponent(m.id)}`}><span aria-hidden="true">✎</span>Edit video</a>}
              <a className={isVideo ? "media-detail-secondary-action" : "media-detail-primary-action"} href={fileUrl(m.id, "download")} download><span aria-hidden="true">↓</span>Download the original</a>
            </div>
            {isVideo && <p className="media-detail-action-note">Editing settings are saved separately and never change this original.</p>}
          </section>

          {!detail.importedCopy && detail.status === "pending_deletion" && (
            <section className="media-detail-lifecycle-note" aria-label="Removal status">
              <span className="media-detail-note-icon" aria-hidden="true">◷</span>
              <div><strong>Removal is scheduled</strong><p>This original is scheduled for removal after {detail.deleteAfter?.toISOString() ?? "an unavailable date"}. Physical deletion is not available yet.</p></div>
            </section>
          )}
        </aside>

        {!detail.importedCopy && detail.status === "active" && (
          <section aria-labelledby="remove-media-heading" className="media-detail-remove-panel">
            <div className="media-detail-remove-copy">
              <span className="media-detail-note-icon" aria-hidden="true">!</span>
              <div><h2 id="remove-media-heading">Schedule original removal</h2><p>The request starts a seven-day grace period. A recipient import in progress blocks scheduling. ClipForge will not physically remove the file in this release.</p></div>
            </div>
            <form method="post" action="/api/forms/media-delete" className="media-detail-remove-form">
              <input type="hidden" name="mediaId" value={m.id} />
              <label><input type="checkbox" name="confirm" value="yes" required /> Schedule this original for removal after the grace period</label>
              <button type="submit">Schedule removal</button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
