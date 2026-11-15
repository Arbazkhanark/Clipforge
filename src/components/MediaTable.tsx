// // src/components/MediaTable.tsx
// import type { MediaLibraryData } from "../server/queries.ts";
// import { formatCount, formatDuration, formatStorage } from "./format.ts";
// import { MediaSelection } from "./MediaSelection.tsx";

// /** Small preview image. The browser asks our server for it; the server re-checks access on every request. */
// export function Thumbnail({ media }: { media: { id: string; hasThumbnail: boolean; kind?: "video" | "image" } }) {
//   const variant = media.hasThumbnail ? "thumbnail" : media.kind === "image" ? "preview" : null;
//   if (variant) return <img src={`/api/media/file?id=${encodeURIComponent(media.id)}&variant=${variant}`} alt="" width={80} loading="lazy" />;
//   return <span className="muted">No preview image. The original video is unchanged.</span>;
// }

// function mediaHref(library: MediaLibraryData, page: number): string {
//   const params = new URLSearchParams();
//   if (library.search) params.set("q", library.search);
//   if (library.sort && library.sort !== "newest") params.set("sort", library.sort);
//   if (library.kind && library.kind !== "all") params.set("kind", library.kind);
//   if (page > 1) params.set("page", String(page));
//   const text = params.toString();
//   return text ? `/media?${text}` : "/media";
// }

// export function MediaTable({ library }: { library: MediaLibraryData }) {
//   const search = library.search ?? "";
//   const sort = library.sort ?? "newest";
//   const kind = library.kind ?? "all";
//   const filtered = library.filtered ?? false;
//   const filters = (
//     <form method="get" action="/media" className="filter-bar" role="search">
//       <p><label>Search by filename<br /><input type="search" name="q" defaultValue={search} maxLength={100} /></label></p>
//       <p><label>Sort<br /><select name="sort" defaultValue={sort} aria-label="Sort media"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="name">Name</option><option value="size">Size</option></select></label></p>
//       <p><label>Show<br /><select name="kind" defaultValue={kind} aria-label="Filter by type"><option value="all">Videos and images</option><option value="video">Videos</option><option value="image">Images</option></select></label></p>
//       <p><button type="submit">Apply</button></p>
//     </form>
//   );
//   if (library.total === 0) {
//     return <>{filtered && filters}<p>{filtered ? "No files match this search or filter." : "Your library is empty. Use the upload form above to add a video or image."}</p></>;
//   }
//   const first = (library.page - 1) * library.pageSize + 1;
//   const last = Math.min(library.total, library.page * library.pageSize);
//   const videos = library.items.filter((item) => item.kind === "video");
//   return (
//     <>
//       {filters}
//       <p className="muted">Showing {formatCount(first)}-{formatCount(last)} of {formatCount(library.total)}.</p>
//       <form id="library-form" method="get" action="/editor/bulk">
//         {videos.length > 0 && <MediaSelection formId="library-form" />}
//         <div className="table-scroll">
//           <table className="data-table">
//             <caption>Your media</caption>
//             <thead><tr><th scope="col">Select</th><th scope="col">Preview</th><th scope="col">Title</th><th scope="col">Type</th><th scope="col" className="hide-narrow">Length</th><th scope="col" className="hide-narrow">Size</th><th scope="col" className="hide-narrow">Checked</th><th scope="col">Edit</th></tr></thead>
//             <tbody>
//               {library.items.map((m) => (
//                 <tr key={m.id}>
//                   <td>{m.kind === "video" ? <input type="checkbox" name="media" value={m.id} aria-label={`Select ${m.title}`} /> : <span className="muted">—</span>}</td>
//                   <td><Thumbnail media={m} /></td>
//                   <td><a href={`/media/${m.id}`}>{m.title}</a></td>
//                   <td>{m.kind === "video" ? "Video" : "Image"}</td>
//                   <td className="hide-narrow">{m.kind === "video" ? formatDuration(m.durationMs) : "-"}</td>
//                   <td className="hide-narrow">{formatStorage(m.sizeBytes)}</td>
//                   <td className="hide-narrow">{m.validation === "verified" ? "Yes" : m.validation === "incomplete" ? "Not fully checked" : "-"}</td>
//                   <td>{m.kind === "video" ? <a className="button-link" href={`/editor?media=${encodeURIComponent(m.id)}`}>Edit</a> : <span className="muted">No editor</span>}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       </form>
//       <nav aria-label="Pages" className="pager">
//         {library.page > 1 && <a href={mediaHref(library, library.page - 1)} rel="prev">Previous</a>}
//         <span>Page {library.page} of {library.pageCount}</span>
//         {library.page < library.pageCount && <a href={mediaHref(library, library.page + 1)} rel="next">Next</a>}
//       </nav>
//     </>
//   );
// }


















import type { MediaLibraryData } from "../server/queries.ts";
import {
  formatCount,
  formatDuration,
  formatStorage,
} from "./format.ts";
import { MediaSelection } from "./MediaSelection.tsx";
import { MediaThumbnail } from "./MediaThumbnail.tsx";
import { UploadedAt } from "./UploadedAt.tsx";

/**
 * Small preview image.
 * The server re-checks access on every thumbnail request.
 */
export function Thumbnail({
  media,
}: {
  media: {
    id: string;
    hasThumbnail: boolean;
    kind?: "video" | "image";
  };
}) {
  return <MediaThumbnail key={media.id} media={media} />;
}

function mediaHref(library: MediaLibraryData, page: number): string {
  const params = new URLSearchParams();

  if (library.search) params.set("q", library.search);
  if (library.sort && library.sort !== "newest") {
    params.set("sort", library.sort);
  }
  if (library.kind && library.kind !== "all") {
    params.set("kind", library.kind);
  }
  if (page > 1) params.set("page", String(page));

  const text = params.toString();

  return text ? `/media?${text}` : "/media";
}

function FileTypeIcon({ kind }: { kind: "video" | "image" }) {
  return (
    <span
      className={`media-type-icon media-type-icon-${kind}`}
      aria-hidden="true"
    >
      {kind === "video" ? "▶" : "▧"}
    </span>
  );
}

export function MediaTable({
  library,
}: {
  library: MediaLibraryData;
}) {
  const search = library.search ?? "";
  const sort = library.sort ?? "newest";
  const kind = library.kind ?? "all";
  const filtered = library.filtered ?? false;

  const videos = library.items.filter(
    (item) => item.kind === "video"
  );

  const images = library.items.filter(
    (item) => item.kind === "image"
  );

  const first =
    library.total > 0
      ? (library.page - 1) * library.pageSize + 1
      : 0;

  const last = Math.min(
    library.total,
    library.page * library.pageSize
  );

  return (
    <div className="media-library-content">
      {/* Library overview */}
      <div className="media-library-stats">
        <article className="media-stat-card">
          <div className="media-stat-icon">▣</div>
          <div>
            <span>ALL FILES</span>
            <strong>{formatCount(library.total)}</strong>
          </div>
        </article>

        <article className="media-stat-card">
          <div className="media-stat-icon video">▶</div>
          <div>
            <span>VIDEOS ON THIS PAGE</span>
            <strong>{formatCount(videos.length)}</strong>
          </div>
        </article>

        <article className="media-stat-card">
          <div className="media-stat-icon image">▧</div>
          <div>
            <span>IMAGES ON THIS PAGE</span>
            <strong>{formatCount(images.length)}</strong>
          </div>
        </article>
      </div>

      {/* Search and filters */}
      <form
        method="get"
        action="/media"
        className="media-toolbar"
        role="search"
      >
        <div className="media-search-field">
          <label htmlFor="media-search">Search files</label>
          <div className="media-input-wrapper">
            <span aria-hidden="true">⌕</span>
            <input
              id="media-search"
              type="search"
              name="q"
              placeholder="Search by filename..."
              defaultValue={search}
              maxLength={100}
            />
          </div>
        </div>

        <div className="media-filter-field">
          <label htmlFor="media-kind">File type</label>
          <select
            id="media-kind"
            name="kind"
            defaultValue={kind}
          >
            <option value="all">All files</option>
            <option value="video">Videos</option>
            <option value="image">Images</option>
          </select>
        </div>

        <div className="media-filter-field">
          <label htmlFor="media-sort">Sort by</label>
          <select
            id="media-sort"
            name="sort"
            defaultValue={sort}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name</option>
            <option value="size">File size</option>
          </select>
        </div>

        <button type="submit" className="media-apply-button">
          Apply filters
        </button>

        {filtered && (
          <a href="/media" className="media-clear-button">
            Clear
          </a>
        )}
      </form>

      {/* Results */}
      <div className="media-results-heading">
        <div>
          <h3>Files</h3>
          <p>
            {library.total === 0
              ? "No files to display"
              : `Showing ${formatCount(first)}–${formatCount(last)} of ${formatCount(library.total)} files`}
          </p>
        </div>

        {videos.length > 0 && (
          <span className="media-selection-hint">
            Select videos to edit them together
          </span>
        )}
      </div>

      {library.total === 0 ? (
        <div className="media-empty-state">
          <div className="media-empty-icon">▧</div>

          <h3>
            {filtered ? "No matching files" : "Your library is empty"}
          </h3>

          <p>
            {filtered
              ? "Try changing your search term or filters to find your files."
              : "Upload your first video or image. Your files will appear here once added."}
          </p>

          {filtered && (
            <a href="/media" className="media-empty-action">
              Clear filters
            </a>
          )}
          {!filtered && (
            <a href="#upload-heading" className="media-empty-upload-action">
              Upload media
            </a>
          )}
        </div>
      ) : (
        <>
          {/* Bulk selection and file table */}
          <form
            id="library-form"
            method="get"
            action="/editor/bulk"
            className="media-files-form"
          >
            {videos.length > 0 && (
              <div className="media-bulk-toolbar">
                <div>
                  <strong>Bulk editing</strong>
                  <span>
                    Choose one or more videos to open them in the editor.
                  </span>
                </div>
                <MediaSelection formId="library-form" />
              </div>
            )}

            <div className="table-scroll media-table-scroll">
              <table className="data-table media-data-table">
                <caption className="media-visually-hidden">
                  Your uploaded media files
                </caption>

                <thead>
                  <tr>
                    <th scope="col" className="media-select-column">
                      Select
                    </th>
                    <th scope="col">Preview</th>
                    <th scope="col">File name</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="hide-narrow">
                      Duration
                    </th>
                    <th scope="col" className="hide-narrow">
                      Size
                    </th>
                    <th scope="col" className="hide-narrow" aria-sort={sort === "oldest" ? "ascending" : sort === "newest" ? "descending" : "none"}>
                      Uploaded
                    </th>
                    <th scope="col" className="hide-narrow">
                      Validation
                    </th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {library.items.map((m) => (
                    <tr key={m.id}>
                      <td className="media-select-column">
                        {m.kind === "video" ? (
                          <input
                            type="checkbox"
                            name="media"
                            value={m.id}
                            aria-label={`Select ${m.title}`}
                          />
                        ) : (
                          <span className="media-table-dash">—</span>
                        )}
                      </td>

                      <td>
                        <div className="media-table-preview">
                          <Thumbnail media={m} />
                        </div>
                      </td>

                      <td>
                        <a
                          href={`/media/${m.id}`}
                          className="media-file-name"
                        >
                          {m.title}
                        </a>
                      </td>

                      <td>
                        <span className="media-type-label">
                          <FileTypeIcon kind={m.kind} />
                          {m.kind === "video" ? "Video" : "Image"}
                        </span>
                      </td>

                      <td className="hide-narrow">
                        {m.kind === "video"
                          ? formatDuration(m.durationMs)
                          : "—"}
                      </td>

                      <td className="hide-narrow">
                        {formatStorage(m.sizeBytes)}
                      </td>

                      <td className="hide-narrow media-uploaded-at">
                        <UploadedAt createdAt={m.createdAt} />
                      </td>

                      <td className="hide-narrow">
                        {m.validation === "verified" ? (
                          <div className="media-validation-cell">
                            <span className="media-validation verified">Verified</span>
                            <small>Server media probe passed</small>
                          </div>
                        ) : m.validation === "incomplete" ? (
                          <div className="media-validation-cell">
                            <span className="media-validation incomplete">Incomplete</span>
                            <small>Full probe did not complete; no retry is queued</small>
                          </div>
                        ) : (
                          <div className="media-validation-cell">
                            <span className="media-table-dash">Unknown</span>
                            <small>No validation result is stored</small>
                          </div>
                        )}
                      </td>

                      <td>
                        {m.kind === "video" ? (
                          <a
                            className="media-edit-link"
                            href={`/editor?media=${encodeURIComponent(m.id)}`}
                          >
                            Edit video →
                          </a>
                        ) : (
                          <a
                            className="media-edit-link"
                            href={`/media/${m.id}`}
                          >
                            View →
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </form>

          {/* Pagination */}
          {library.pageCount > 1 && (
            <nav
              aria-label="Media library pages"
              className="media-pagination"
            >
              <div className="media-pagination-info">
                Page <strong>{library.page}</strong> of{" "}
                <strong>{library.pageCount}</strong>
              </div>

              <div className="media-pagination-actions">
                {library.page > 1 ? (
                  <a
                    href={mediaHref(library, library.page - 1)}
                    rel="prev"
                    className="media-page-button"
                  >
                    ← Previous
                  </a>
                ) : (
                  <span className="media-page-button disabled">
                    ← Previous
                  </span>
                )}

                {library.page < library.pageCount ? (
                  <a
                    href={mediaHref(library, library.page + 1)}
                    rel="next"
                    className="media-page-button"
                  >
                    Next →
                  </a>
                ) : (
                  <span className="media-page-button disabled">
                    Next →
                  </span>
                )}
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
