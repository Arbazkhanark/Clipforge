import { BulkConfirmation, BulkForm } from "../../../../src/components/BulkViews.tsx";
import { ErrorState } from "../../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../../src/components/FlashMessage.tsx";
import { getBulkDraft } from "../../../../src/server/bulk/bulk-service.ts";
import { parseFlash } from "../../../../src/server/flash.ts";
import { loadPageData } from "../../../../src/server/page-data.ts";
import { getEditorPageData } from "../../../../src/server/queries.ts";
import { notFound } from "../../../../src/server/errors.ts";
import { getPlan } from "../../../../src/lib/billing/catalog.ts";

export const metadata = { title: "Bulk edit" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const idList = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : value ? [value] : []).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));

export default async function BulkPage(props: { searchParams?: Promise<Search> | Search } = {}) {
  const search = await props.searchParams;
  const draftId = typeof search?.["draft"] === "string" ? search["draft"] : undefined;
  const result = await loadPageData(async (ctx) => {
    const editor = await getEditorPageData(ctx, { mediaId: undefined, search: {} });
    const userId = ctx.userId ?? "";
    const plan = getPlan(await ctx.repo.getPlanIdForUser(userId));
    if (draftId) {
      const draft = getBulkDraft(draftId);
      if (!draft || draft.ownerId !== userId) throw notFound("Bulk edit");
      return { kind: "draft" as const, draft };
    }
    const videos = [];
    for (const id of idList(search?.["media"])) {
      const media = await ctx.repo.getMedia(id);
      if (media && media.ownerId === userId && media.status === "active" && (media.kind ?? "video") === "video") videos.push({ id: media.id, title: media.title ?? "Untitled", kind: "video" as const, sizeBytes: media.sizeBytes, durationMs: media.durationMs ?? null, status: media.status, validation: media.validation ?? "unknown" as const, hasThumbnail: media.hasThumbnail === true, width: media.width ?? null, height: media.height ?? null });
    }
    return { kind: "form" as const, videos, images: editor.logoChoices, batchSize: plan.limits.batchSize };
  });
  if (!result.ok) return <ErrorState error={result.error} />;
  return (
    <>
      <FlashMessage flash={parseFlash(search)} />
      {result.data.kind === "draft" ? <BulkConfirmation draft={result.data.draft} /> : result.data.videos.length === 0 ? <p>Choose videos in the <a href="/media">media library</a> first. Images are not edited here.</p> : <BulkForm videos={result.data.videos} images={result.data.images} batchSize={result.data.batchSize} />}
    </>
  );
}
