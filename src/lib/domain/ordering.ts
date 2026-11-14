// Queue ordering for a publishing cycle. The chosen order is SAVED as item positions, so a restart
// never reshuffles the queue. "Shuffle" uses a stored seed, so the same seed always gives the same order.
import type { CycleItem, MediaAsset } from "./types.ts";

export const ORDER_MODES = ["manual", "upload_order", "name_asc", "name_desc", "oldest_first", "newest_first", "smallest_first", "largest_first", "shuffle"] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

export interface OrderableItem {
  id: string;
  /** Position the user gave by hand (used by "manual"). */
  manualPosition: number;
  /** The order the user selected/uploaded the videos in (used by "upload_order"). */
  selectionIndex: number;
  /** Original media filename. */
  title?: string;
  /** When the media was created (used by oldest/newest). */
  mediaCreatedAt: Date;
  sizeBytes: number;
}

// Small deterministic random generator (mulberry32) seeded from a string (xmur3 hash).
function seedFromString(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) { h = Math.imul(h ^ text.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function makeRandom(seedText: string): () => number {
  let state = seedFromString(seedText);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns item ids in publishing order. Ties are always broken by id so results are stable. */
export function orderItemIds(items: OrderableItem[], mode: OrderMode, shuffleSeed = ""): string[] {
  const byId = (a: OrderableItem, b: OrderableItem) => a.id.localeCompare(b.id);
  const sorted = [...items];
  switch (mode) {
    case "manual": sorted.sort((a, b) => a.manualPosition - b.manualPosition || byId(a, b)); break;
    case "upload_order": sorted.sort((a, b) => a.selectionIndex - b.selectionIndex || byId(a, b)); break;
    case "name_asc": sorted.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "en", { numeric: true, sensitivity: "base" }) || byId(a, b)); break;
    case "name_desc": sorted.sort((a, b) => (b.title ?? "").localeCompare(a.title ?? "", "en", { numeric: true, sensitivity: "base" }) || byId(a, b)); break;
    case "oldest_first": sorted.sort((a, b) => a.mediaCreatedAt.getTime() - b.mediaCreatedAt.getTime() || byId(a, b)); break;
    case "newest_first": sorted.sort((a, b) => b.mediaCreatedAt.getTime() - a.mediaCreatedAt.getTime() || byId(a, b)); break;
    case "smallest_first": sorted.sort((a, b) => a.sizeBytes - b.sizeBytes || byId(a, b)); break;
    case "largest_first": sorted.sort((a, b) => b.sizeBytes - a.sizeBytes || byId(a, b)); break;
    case "shuffle": {
      sorted.sort(byId); // start from a stable base so the input order does not matter
      const random = makeRandom(shuffleSeed);
      for (let i = sorted.length - 1; i > 0; i--) { // Fisher-Yates
        const j = Math.floor(random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j] as OrderableItem, sorted[i] as OrderableItem];
      }
      break;
    }
  }
  return sorted.map((i) => i.id);
}

/**
 * Save a new order on EDITABLE items only. They reuse the positions the editable items already
 * occupy, so published / in-flight items keep their place in history.
 */
export function applyOrderToItems(items: CycleItem[], orderedIds: string[]): CycleItem[] {
  const editable = items.filter((i) => i.status === "upcoming" || i.status === "scheduled");
  const orderedEditableIds = orderedIds.filter((id) => editable.some((i) => i.id === id));
  const slots = editable.map((i) => i.position).sort((a, b) => a - b);
  const newPosition = new Map(orderedEditableIds.map((id, index) => [id, slots[index] as number]));
  return items.map((item) => {
    const position = newPosition.get(item.id);
    return position === undefined || position === item.position ? item : { ...item, position, version: item.version + 1 };
  });
}

/** Applies an ordering mode to editable queue positions using server loaded media metadata. */
export function orderCycleItems(
  items: CycleItem[],
  mediaById: ReadonlyMap<string, Pick<MediaAsset, "title" | "createdAt" | "sizeBytes">>,
  mode: OrderMode,
  shuffleSeed = "",
): CycleItem[] {
  const editable = items.filter((item) => item.status === "upcoming" || item.status === "scheduled");
  const orderables = editable.map((item) => {
    const media = mediaById.get(item.mediaAssetId);
    return {
      id: item.id,
      manualPosition: item.position,
      selectionIndex: item.position,
      title: media?.title ?? "",
      mediaCreatedAt: media?.createdAt ?? new Date(0),
      sizeBytes: media?.sizeBytes ?? 0,
    };
  });
  return applyOrderToItems(items, orderItemIds(orderables, mode, shuffleSeed));
}
