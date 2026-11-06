import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { MediaTable } from "../../../src/components/MediaTable.tsx";
import { UploadForm } from "../../../src/components/UploadForm.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getMediaLibrary, getUploadInfo } from "../../../src/server/queries.ts";

export const metadata = { title: "Media library" };
export const dynamic = "force-dynamic";

type Search = { page?: string; q?: string; sort?: string; kind?: string; notice?: string; error?: string };

// `searchParams` is a plain object in older Next.js and a Promise in newer ones; `await` handles both.
export default async function MediaPage(props: { searchParams?: Promise<Search> | Search }) {
  const searchParams = await props.searchParams;
  const [library, upload] = await Promise.all([loadPageData((ctx) => getMediaLibrary(ctx, searchParams)), loadPageData(async (ctx) => getUploadInfo(ctx))]);
  return (
    <>
      <h1>Media library</h1>
      <FlashMessage flash={parseFlash(searchParams)} />
      {upload.ok && <UploadForm info={upload.data} />}
      {library.ok ? <MediaTable library={library.data} /> : <ErrorState error={library.error} />}
    </>
  );
}
