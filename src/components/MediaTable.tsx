import type { MediaLibraryData } from "../server/queries.ts";
import { formatCount, formatDuration, formatStorage } from "./format.ts";
import { MediaSelection } from "./MediaSelection.tsx";

/** Small preview image. The browser asks our server for it; the server re-checks access on every request. */
export function Thumbnail({ media }: { media: { id: string; hasThumbnail: boolean } }) {
  return media.hasThumbnail
    ? <img src={`/api/media/file?id=${encodeURIComponent(media.id)}&variant=thumbnail`} alt="" width={80} loading="lazy" />
    : <span className="muted">No preview</span>;
}

export function MediaTable({ library }: { library: MediaLibraryData }) {
  if (library.total === 0) {
    return <p>Your library is empty. Use the upload form above to add a video or image.</p>;
  }
  const first = (library.page - 1) * library.pageSize + 1;
  const last = Math.min(library.total, library.page * library.pageSize);
  const videos = library.items.filter((item) => item.kind === "video");
  return (
    <>
      <p className="muted">Showing {formatCount(first)}-{formatCount(last)} of {formatCount(library.total)}.</p>
      <form id="library-form" method="get" action="/editor/bulk">
        {videos.length > 0 && <MediaSelection formId="library-form" />}
        <div className="table-scroll">
          <table className="data-table">
            <caption>Your media</caption>
            <thead><tr><th scope="col">Select</th><th scope="col">Preview</th><th scope="col">Title</th><th scope="col">Type</th><th scope="col" className="hide-narrow">Length</th><th scope="col" className="hide-narrow">Size</th><th scope="col" className="hide-narrow">Checked</th><th scope="col">Edit</th></tr></thead>
            <tbody>
              {library.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.kind === "video" ? <input type="checkbox" name="media" value={m.id} aria-label={`Select ${m.title}`} /> : <span className="muted">—</span>}</td>
                  <td><Thumbnail media={m} /></td>
                  <td><a href={`/media/${m.id}`}>{m.title}</a></td>
                  <td>{m.kind === "video" ? "Video" : "Image"}</td>
                  <td className="hide-narrow">{m.kind === "video" ? formatDuration(m.durationMs) : "-"}</td>
                  <td className="hide-narrow">{formatStorage(m.sizeBytes)}</td>
                  <td className="hide-narrow">{m.validation === "verified" ? "Yes" : m.validation === "incomplete" ? "Not fully checked" : "-"}</td>
                  <td>{m.kind === "video" ? <a className="button-link" href={`/editor?media=${encodeURIComponent(m.id)}`}>Edit</a> : <span className="muted">No editor</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>
      <nav aria-label="Pages" className="pager">
        {library.page > 1 && <a href={`/media?page=${library.page - 1}`} rel="prev">Previous</a>}
        <span>Page {library.page} of {library.pageCount}</span>
        {library.page < library.pageCount && <a href={`/media?page=${library.page + 1}`} rel="next">Next</a>}
      </nav>
    </>
  );
}
