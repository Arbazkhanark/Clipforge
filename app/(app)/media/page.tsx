// // app/(app)/media/page.tsx
// import { ErrorState } from "../../../src/components/PageState.tsx";
// import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
// import { MediaTable } from "../../../src/components/MediaTable.tsx";
// import { UploadForm } from "../../../src/components/UploadForm.tsx";
// import { parseFlash } from "../../../src/server/flash.ts";
// import { loadPageData } from "../../../src/server/page-data.ts";
// import { getMediaLibrary, getUploadInfo } from "../../../src/server/queries.ts";
// import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

// export const metadata = { title: "Media library" };
// export const dynamic = "force-dynamic";

// type Search = {
//   page?: string;
//   q?: string;
//   sort?: string;
//   kind?: string;
//   notice?: string;
//   error?: string;
// };

// export default async function MediaPage(props: {
//   searchParams?: Promise<Search>;
// }) {
//   await requireCustomerPage("/media");
//   const searchParams = await props.searchParams;
//   const [library, upload] = await Promise.all([
//     loadPageData((ctx) => getMediaLibrary(ctx, searchParams)),
//     loadPageData(async (ctx) => getUploadInfo(ctx)),
//   ]);
//   return (
//     <>
//       <h1>Media library</h1>
//       <FlashMessage flash={parseFlash(searchParams)} />
//       {upload.ok && <UploadForm info={upload.data} />}
//       {library.ok ? (
//         <MediaTable library={library.data} />
//       ) : (
//         <ErrorState error={library.error} />
//       )}
//     </>
//   );
// }













import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { MediaTable } from "../../../src/components/MediaTable.tsx";
import { UploadForm } from "../../../src/components/UploadForm.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import {
  getMediaLibrary,
  getUploadInfo,
} from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Media library" };
export const dynamic = "force-dynamic";

type Search = {
  page?: string;
  q?: string;
  sort?: string;
  kind?: string;
  notice?: string;
  error?: string;
};

export default async function MediaPage(props: {
  searchParams?: Promise<Search>;
}) {
  await requireCustomerPage("/media");

  const searchParams = await props.searchParams;

  const [library, upload] = await Promise.all([
    loadPageData((ctx) => getMediaLibrary(ctx, searchParams)),
    loadPageData(async (ctx) => getUploadInfo(ctx)),
  ]);

  return (
    <main className="media-page">
      <header className="media-page-header">
        <div>
          <span className="dashboard-eyebrow">CONTENT MANAGEMENT</span>
          <h1>Media library</h1>
          <p>
            Upload, organize and manage all your videos and images in one place.
          </p>
        </div>

        <a href="/editor" className="media-header-link">
          Open video editor →
        </a>
      </header>

      <FlashMessage flash={parseFlash(searchParams)} />

      {upload.ok && (
        <section
          className="media-upload-section"
          aria-labelledby="media-upload-heading"
        >
          <div className="media-section-heading">
            <div>
              <span className="dashboard-eyebrow">ADD CONTENT</span>
              <h2 id="media-upload-heading">Upload media</h2>
              <p>
                Add videos and images to your library to use in your campaigns.
              </p>
            </div>
            <span className="media-section-icon" aria-hidden="true">
              ↑
            </span>
          </div>

          <div className="media-upload-container">
            <UploadForm info={upload.data} />
          </div>
        </section>
      )}

      <section
        className="media-library-section"
        aria-labelledby="media-library-heading"
      >
        <div className="media-section-heading">
          <div>
            <span className="dashboard-eyebrow">YOUR CONTENT</span>
            <h2 id="media-library-heading">Your files</h2>
            <p>
              Browse your uploads, find files and prepare videos for editing.
            </p>
          </div>
        </div>

        {library.ok ? (
          <MediaTable library={library.data} />
        ) : (
          <ErrorState error={library.error} />
        )}
      </section>
    </main>
  );
}
