export type EditedRetentionStatus = "available" | "queued" | "processing" | "deleted" | "failed" | "unavailable";

export interface RetentionStatusItem {
  mediaId: string;
  outputId: string;
  status: EditedRetentionStatus;
  message: string;
}

const STATUSES = new Set<EditedRetentionStatus>(["available", "queued", "processing", "deleted", "failed", "unavailable"]);

/** Read status only; reconciliation must never submit another destructive request. */
export async function reconcileEditedRetentionStatus(
  items: Pick<RetentionStatusItem, "mediaId" | "outputId">[],
  fetcher: typeof fetch = fetch,
): Promise<RetentionStatusItem[]> {
  return Promise.all(items.map(async ({ mediaId, outputId }) => {
    const response = await fetcher(`/api/media/edited-retention?mediaId=${encodeURIComponent(mediaId)}&outputId=${encodeURIComponent(outputId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Retention status is temporarily unavailable.");
    const result = await response.json() as { mediaId?: unknown; outputId?: unknown; status?: unknown; message?: unknown };
    if (result.mediaId !== mediaId || result.outputId !== outputId || typeof result.status !== "string" || !STATUSES.has(result.status as EditedRetentionStatus) || typeof result.message !== "string") {
      throw new Error("Retention status is temporarily unavailable.");
    }
    return { mediaId, outputId, status: result.status as EditedRetentionStatus, message: result.message };
  }));
}
