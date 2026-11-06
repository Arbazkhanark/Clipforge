import type { MediaDetail } from "../server/queries.ts";
import { formatDateTime, formatDuration, formatStorage } from "./format.ts";

const fileUrl = (id: string, variant: "thumbnail" | "preview" | "download") => `/api/media/file?id=${encodeURIComponent(id)}&variant=${variant}`;

/** Your own file: metadata, an inline preview of the original, and a download link. Nothing here shows where the file is stored. */
export function MediaDetailView({ detail, timeZone }: { detail: MediaDetail; timeZone: string }) {
  const m = detail.media;
  return (
    <>
      <p><a href="/media">Media library</a></p>
      <h1>{m.title}</h1>
      <section aria-labelledby="preview-heading">
        <h2 id="preview-heading">Preview</h2>
        {m.kind === "video"
          ? <>
              <video controls preload="metadata" width={480} poster={m.hasThumbnail ? fileUrl(m.id, "thumbnail") : undefined} src={fileUrl(m.id, "preview")}>Your browser cannot play this video. You can download it instead.</video>
              {!m.hasThumbnail && <p className="muted">No preview image was created for this video. The original file is unchanged.</p>}
            </>
          : <img src={fileUrl(m.id, "preview")} alt={`Preview of ${m.title}`} width={480} />}
      </section>
      <section aria-labelledby="meta-heading">
        <h2 id="meta-heading">Details</h2>
        <dl className="details">
          <dt>Type</dt><dd>{detail.mimeType ?? "Unknown"}</dd>
          <dt>Size</dt><dd>{formatStorage(m.sizeBytes)}</dd>
          {m.kind === "video" && <><dt>Length</dt><dd>{formatDuration(m.durationMs)}</dd></>}
          <dt>Resolution</dt><dd>{m.width && m.height ? `${m.width} × ${m.height}` : "Unknown"}</dd>
          <dt>Checked</dt><dd>{m.validation === "verified" ? "Yes - the file was decoded and its length and size were read." : m.validation === "incomplete" ? "Not fully checked - it was accepted by its file signature only." : "Unknown"}</dd>
          <dt>Added</dt><dd>{detail.addedAt ? formatDateTime(detail.addedAt, timeZone) : "Unknown"}</dd>
        </dl>
      </section>
      <p><a href={fileUrl(m.id, "download")} download>Download the original</a></p>
      {m.kind === "video" && <p><a href={`/editor?media=${encodeURIComponent(m.id)}`}>Edit</a> <span className="muted">(editing settings are saved separately and never change this original)</span></p>}
    </>
  );
}
