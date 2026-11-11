// app/(app)/editor/page.tsx
import { EditorView } from "../../../src/components/EditorViews.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getEditorPageData } from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Editor" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function EditorPage(props: { searchParams?: Promise<Search> }) {
  const search = await props.searchParams;
  const media = typeof search?.["media"] === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(search["media"]) ? search["media"] : undefined;
  await requireCustomerPage(media ? `/editor?media=${encodeURIComponent(media)}` : "/editor");
  const result = await loadPageData((ctx) => getEditorPageData(ctx, { mediaId: media, search }));
  return (
    <>
      <FlashMessage flash={result.ok && result.data.job && result.data.job.status !== "queued" && result.data.job.status !== "processing" && parseFlash(search)?.message.startsWith("Rendering has started. This page updates") ? null : parseFlash(search)} />
      {result.ok ? <EditorView data={result.data} /> : <ErrorState error={result.error} />}
    </>
  );
}
