// Validates the media library and collection list query strings.
// Unknown sort or kind values are rejected. Nothing here trusts an owner id from the browser.
import { validationFailed } from "./errors.ts";
import { MEDIA_SORTS, type MediaSort } from "../lib/domain/media-list.ts";

export const COLLECTION_SORTS = ["newest", "oldest", "name"] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

export interface MediaListQuery { page: number; search: string; sort: MediaSort; kind?: "video" | "image"; filtered: boolean; }
export interface CollectionListQuery { search: string; sort: CollectionSort; filtered: boolean; }

function one(value: unknown): unknown { return Array.isArray(value) ? value[0] : value; }

function field(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  return one((raw as Record<string, unknown>)[key]);
}

function readSearch(value: unknown, problems: string[]): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") { problems.push("q must be text."); return ""; }
  if (value.length > 100) problems.push("q must be at most 100 characters.");
  return value.trim();
}

function readPage(value: unknown, problems: string[]): number {
  if (value === undefined || value === null || value === "") return 1;
  const page = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && value.trim() !== String(page)) { problems.push("page must be a whole number from 1."); return 1; }
  if (!Number.isInteger(page) || page < 1 || page > 100_000) problems.push("page must be a whole number from 1.");
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function readMediaListQuery(raw: unknown): MediaListQuery {
  const problems: string[] = [];
  const page = readPage(typeof raw === "object" && raw !== null ? field(raw, "page") : raw, problems);
  const search = readSearch(typeof raw === "object" && raw !== null ? field(raw, "q") : undefined, problems);
  const sortRaw = typeof raw === "object" && raw !== null ? field(raw, "sort") : undefined;
  let sort: MediaSort = "newest";
  if (sortRaw !== undefined && sortRaw !== "") {
    if (typeof sortRaw !== "string" || !(MEDIA_SORTS as readonly string[]).includes(sortRaw)) problems.push("sort must be newest, oldest, name, or size.");
    else sort = sortRaw as MediaSort;
  }
  const kindRaw = typeof raw === "object" && raw !== null ? field(raw, "kind") : undefined;
  let kind: "video" | "image" | undefined;
  if (kindRaw !== undefined && kindRaw !== "" && kindRaw !== "all") {
    if (kindRaw !== "video" && kindRaw !== "image") problems.push("kind must be video, image, or all.");
    else kind = kindRaw;
  }
  if (problems.length > 0) throw validationFailed(problems);
  return { page, search, sort, ...(kind ? { kind } : {}), filtered: search.length > 0 || kind !== undefined };
}

export function readCollectionListQuery(raw: unknown): CollectionListQuery {
  const problems: string[] = [];
  const search = readSearch(field(raw, "q"), problems);
  const sortRaw = field(raw, "sort");
  let sort: CollectionSort = "newest";
  if (sortRaw !== undefined && sortRaw !== "") {
    if (typeof sortRaw !== "string" || !(COLLECTION_SORTS as readonly string[]).includes(sortRaw)) problems.push("sort must be newest, oldest, or name.");
    else sort = sortRaw as CollectionSort;
  }
  if (problems.length > 0) throw validationFailed(problems);
  return { search, sort, filtered: search.length > 0 };
}

export function readCollectionVideoQuery(raw: unknown): { search: string; sort: MediaSort; filtered: boolean } {
  const problems: string[] = [];
  const search = readSearch(field(raw, "q"), problems);
  const sortRaw = field(raw, "sort");
  let sort: MediaSort = "newest";
  if (sortRaw !== undefined && sortRaw !== "") {
    if (typeof sortRaw !== "string" || !(MEDIA_SORTS as readonly string[]).includes(sortRaw)) problems.push("sort must be newest, oldest, name, or size.");
    else sort = sortRaw as MediaSort;
  }
  if (problems.length > 0) throw validationFailed(problems);
  return { search, sort, filtered: search.length > 0 };
}
