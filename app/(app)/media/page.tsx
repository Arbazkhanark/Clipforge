import { ErrorState } from "../../../src/components/PageState.tsx";
import { MediaTable } from "../../../src/components/MediaTable.tsx";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getMediaLibrary } from "../../../src/server/queries.ts";

export const metadata = { title: "Media library" };
export const dynamic = "force-dynamic";

// `searchParams` is a plain object in older Next.js and a Promise in newer ones; `await` handles both.
export default async function MediaPage(props: { searchParams?: Promise<{ page?: string }> | { page?: string } }) {
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getMediaLibrary(ctx, searchParams?.page));
  return (
    <>
      <h1>Media library</h1>
      {result.ok ? <MediaTable library={result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
