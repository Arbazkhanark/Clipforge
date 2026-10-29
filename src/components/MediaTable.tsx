import type { MediaLibraryData } from "../server/queries.ts";
import { formatCount, formatDuration, formatStorage } from "./format.ts";

export function MediaTable({ library }: { library: MediaLibraryData }) {
  if (library.total === 0) {
    return <p>Your library is empty. Uploading is not available yet in this build.</p>;
  }
  const first = (library.page - 1) * library.pageSize + 1;
  const last = Math.min(library.total, library.page * library.pageSize);
  return (
    <>
      <p className="muted">Showing {formatCount(first)}-{formatCount(last)} of {formatCount(library.total)}.</p>
      <div className="table-scroll">
        <table className="data-table">
          <caption>Your media</caption>
          <thead><tr><th scope="col">Title</th><th scope="col">Type</th><th scope="col">Length</th><th scope="col">Size</th></tr></thead>
          <tbody>
            {library.items.map((m) => (
              <tr key={m.id}><td>{m.title}</td><td>{m.kind === "video" ? "Video" : "Image"}</td><td>{m.kind === "video" ? formatDuration(m.durationMs) : "-"}</td><td>{formatStorage(m.sizeBytes)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav aria-label="Pages" className="pager">
        {library.page > 1 && <a href={`/media?page=${library.page - 1}`} rel="prev">Previous</a>}
        <span>Page {library.page} of {library.pageCount}</span>
        {library.page < library.pageCount && <a href={`/media?page=${library.page + 1}`} rel="next">Next</a>}
      </nav>
    </>
  );
}
