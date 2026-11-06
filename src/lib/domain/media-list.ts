// Ordering and title search for one owner's media list.
// The title is the uploaded filename. Search is case-insensitive. Sort always ends with the id,
// so two files with the same name, size, or time stay in the same order on every page.
import type { MediaAsset } from "./types.ts";

export const MEDIA_SORTS = ["newest", "oldest", "name", "size"] as const;
export type MediaSort = (typeof MEDIA_SORTS)[number];

export function mediaMatchesSearch(media: { title?: string }, search: string): boolean {
  return (media.title ?? "").toLocaleLowerCase().includes(search.toLocaleLowerCase());
}

export function compareMedia(sort: MediaSort, a: MediaAsset, b: MediaAsset): number {
  const id = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (sort === "name") {
    const left = a.title ?? "";
    const right = b.title ?? "";
    if (left !== right) return left < right ? -1 : 1;
    return id;
  }
  if (sort === "size") return b.sizeBytes - a.sizeBytes || id;
  const time = (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
  return (sort === "oldest" ? time : -time) || id;
}
