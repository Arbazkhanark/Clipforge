// Hand-written input validation for request bodies. Every handler validates BEFORE touching the database.
// Rules: ids are short safe strings, lists and maps have size limits, nothing is trusted from the browser.
import { validationFailed } from "./errors.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

export type RawObject = Record<string, unknown>;

/** Collects every problem so the user sees all of them at once. */
export class Problems {
  private messages: string[] = [];
  add(message: string): void { this.messages.push(message); }
  throwIfAny(): void { if (this.messages.length > 0) throw validationFailed(this.messages); }
}

export function readObject(raw: unknown, problems: Problems, name = "The request body"): RawObject {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { problems.add(`${name} must be an object.`); return {}; }
  return raw as RawObject;
}

export function readId(source: RawObject, key: string, problems: Problems): string {
  const value = source[key];
  if (typeof value !== "string" || !ID_PATTERN.test(value)) { problems.add(`${key} must be a valid id.`); return ""; }
  return value;
}

export function readText(source: RawObject, key: string, problems: Problems, limits: { min?: number; max: number }): string {
  const value = source[key];
  if (typeof value !== "string") { problems.add(`${key} must be text.`); return ""; }
  if (value.length > limits.max) problems.add(`${key} must be at most ${limits.max} characters.`);
  if (value.length < (limits.min ?? 0)) problems.add(`${key} must be at least ${limits.min} characters.`);
  return value;
}

export function readBoolean(source: RawObject, key: string, problems: Problems, defaultValue: boolean): boolean {
  const value = source[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") { problems.add(`${key} must be true or false.`); return defaultValue; }
  return value;
}

/** Optional ISO date-time. Missing or null gives null. */
export function readOptionalDate(source: RawObject, key: string, problems: Problems): Date | null {
  const value = source[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) { problems.add(`${key} must be an ISO date-time like 2026-07-01T10:00:00Z.`); return null; }
  return new Date(value);
}

export function readIdList(source: RawObject, key: string, problems: Problems, limits: { min?: number; max: number }): string[] {
  const value = source[key];
  if (value === undefined && (limits.min ?? 0) === 0) return [];
  if (!Array.isArray(value)) { problems.add(`${key} must be a list.`); return []; }
  if (value.length > limits.max) { problems.add(`${key} can hold at most ${limits.max} entries.`); return []; }
  if (value.length < (limits.min ?? 0)) problems.add(`${key} needs at least ${limits.min} entr${limits.min === 1 ? "y" : "ies"}.`);
  const ids: string[] = [];
  for (const entry of value) { if (typeof entry !== "string" || !ID_PATTERN.test(entry)) { problems.add(`${key} contains an invalid id.`); return []; } ids.push(entry); }
  return ids;
}

export function readEnumList<T extends string>(source: RawObject, key: string, problems: Problems, allowed: readonly T[], limits: { min?: number; max: number }): T[] {
  const value = source[key];
  if (!Array.isArray(value)) { problems.add(`${key} must be a list.`); return []; }
  if (value.length > limits.max || value.length < (limits.min ?? 0)) { problems.add(`${key} must have ${limits.min ?? 0} to ${limits.max} entries.`); return []; }
  const result: T[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(allowed as readonly string[]).includes(entry)) { problems.add(`${key} contains an unknown value.`); return []; }
    result.push(entry as T);
  }
  return result;
}

/**
 * Map of item id -> version number the user last saw. Built on an object WITHOUT a prototype,
 * so a key like "__proto__" is just data and can never change how other objects behave.
 */
export function readVersionMap(source: RawObject, key: string, problems: Problems, maxEntries: number): Record<string, number> {
  const map: Record<string, number> = Object.create(null);
  const value = source[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) { problems.add(`${key} must be an object of item versions.`); return map; }
  const entries = Object.entries(value as RawObject);
  if (entries.length > maxEntries) { problems.add(`${key} can hold at most ${maxEntries} entries.`); return map; }
  for (const [itemId, version] of entries) {
    if (!ID_PATTERN.test(itemId) || typeof version !== "number" || !Number.isInteger(version) || version < 1) { problems.add(`${key} must map valid item ids to whole version numbers.`); return Object.create(null); }
    map[itemId] = version;
  }
  return map;
}

export type ParsedTarget = { kind: "all_upcoming" } | { kind: "selected"; itemIds: string[] };

export function readTarget(source: RawObject, problems: Problems): ParsedTarget {
  const targetObject = readObject(source["target"], problems, "target");
  const kind = targetObject["kind"];
  if (kind === "all_upcoming") return { kind };
  if (kind === "selected") return { kind, itemIds: readIdList(targetObject, "itemIds", problems, { min: 1, max: 500 }) };
  problems.add("target.kind must be \"all_upcoming\" or \"selected\".");
  return { kind: "all_upcoming" };
}
