import type { MediaLibraryData } from "../server/queries.ts";
import { formatCount, formatDuration, formatStorage } from "./format.ts";
import { MediaSelection } from "./MediaSelection.tsx";

/** Small preview image. The browser asks our server for it; the server re-checks access on every request. */
export function Thumbnail({ media }: { media: { id: string; hasThumbnail: boolean; kind?: "video" | "image" } }) {
  if (media.hasThumbnail) return <img src={`/api/media/file?id=${encodeURIComponent(media.id)}&variant=thumbnail`} alt="" width={80} loading="lazy" />;
  return <span className="muted">{media.kind === "video" ? "No preview image. The original video is unchanged." : "No preview image."}</span>;
}

function mediaHref(library: MediaLibraryData, page: number): string {
  const params = new URLSearchParams();
  if (library.search) params.set("q", library.search);
  if (library.sort && library.sort !== "newest") params.set("sort", library.sort);
  if (library.kind && library.kind !== "all") params.set("kind", library.kind);
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `/media?${text}` : "/media";
}

export function MediaTable({ library }: { library: MediaLibraryData }) {
  const search = library.search ?? "";
  const sort = library.sort ?? "newest";
  const kind = library.kind ?? "all";
  const filtered = library.filtered ?? false;
  const filters = (
    <form method="get" action="/media" className="filter-bar" role="search">
      <p><label>Search by filename<br /><input type="search" name="q" defaultValue={search} maxLength={100} /></label></p>
      <p><label>Sort<br /><select name="sort" defaultValue={sort} aria-label="Sort media"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="size">Size</option></select></label></p>
      <p><label>Show<br /><select name="kind" defaultValue={kind} aria-label="Filter by type"><option value="all">Videos and images</option><option value="video">Videos</option><option value="image">Images</option></select></label></p>
      <p><button type="submit">Apply</button></p>
    </form>
  );
  if (library.total === 0) {
    return <>{filtered && filters}<p>{filtered ? "No files match this search or filter." : "Your library is empty. Use the upload form above to add a video or image."}</p></>;
  }
  const first = (library.page - 1) * library.pageSize + 1;
  const last = Math.min(library.total, library.page * library.pageSize);
  const videos = library.items.filter((item) => item.kind === "video");
  return (
    <>
      {filters}
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
        {library.page > 1 && <a href={mediaHref(library, library.page - 1)} rel="prev">Previous</a>}
        <span>Page {library.page} of {library.pageCount}</span>
        {library.page < library.pageCount && <a href={mediaHref(library, library.page + 1)} rel="next">Next</a>}
      </nav>
    </>
  );
}
