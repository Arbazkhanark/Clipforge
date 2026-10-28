// Publishing schedule: turn user settings (interval, days, time window, timezone, daily max, end date)
// into concrete UTC publish times, and attach those times to upcoming cycle items.
// Pure functions. Uses the JavaScript Intl API for time zones (including daylight saving).
//
// IMPORTANT: this only answers "which times fit the settings". It does NOT know Instagram's real
// publishing limits (they are unverified - see PLATFORM_LIMITS_NOTE). A schedule that this module
// accepts is NOT thereby "safe" for the platform.
import { isEditableItem } from "./cycle-state.ts";
import type { CycleItem } from "./types.ts";

export const PLATFORM_LIMITS_NOTE =
  "Instagram's publishing limits have not been verified yet, so ClipForge cannot say whether this schedule is within them.";

export interface ScheduleSettings {
  /** IANA name, e.g. "Asia/Kolkata". */
  timeZone: string;
  /** Minutes between posting moments, 1 to 1440. */
  intervalMinutes: number;
  /** How many posts go out at each posting moment (usually 1). */
  postsPerInterval: number;
  /** Allowed weekdays in the user's time zone: 0 = Sunday ... 6 = Saturday. */
  daysOfWeek: number[];
  /** Local "HH:MM". Posting moments start at windowStart and continue while <= windowEnd. */
  windowStart: string;
  windowEnd: string;
  /** Max posts per local day, or null for no daily maximum. */
  dailyMax: number | null;
  /** Last local date (inclusive) as "YYYY-MM-DD", or null for no end date. */
  endDate: string | null;
}

// ---------- Time zone helpers ----------
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }

function getLocalParts(timeZone: string, utcMs: number): LocalParts {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(utcMs));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

/** How far the time zone is ahead of UTC at that instant (milliseconds). */
function getOffsetMs(timeZone: string, utcMs: number): number {
  const p = getLocalParts(timeZone, utcMs);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` into the matching UTC instant. */
export function zonedTimeToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstOffset = getOffsetMs(timeZone, wallClockAsUtc);
  let utcMs = wallClockAsUtc - firstOffset;
  const secondOffset = getOffsetMs(timeZone, utcMs); // differs only around daylight-saving changes
  if (secondOffset !== firstOffset) utcMs = wallClockAsUtc - secondOffset;
  return new Date(utcMs);
}

export interface LocalDate { year: number; month: number; day: number; }
export const localDateKey = (d: LocalDate): string => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
export function localDateOf(timeZone: string, instant: Date): LocalDate {
  const p = getLocalParts(timeZone, instant.getTime());
  return { year: p.year, month: p.month, day: p.day };
}
const weekdayOf = (d: LocalDate): number => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
function addDays(d: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

// ---------- Validation ----------
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const minutesOf = (hhmm: string): number => { const m = TIME_PATTERN.exec(hhmm) as RegExpExecArray; return Number(m[1]) * 60 + Number(m[2]); };

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

export interface ScheduleValidation { valid: boolean; problems: string[]; warnings: string[]; }

export function validateScheduleSettings(s: ScheduleSettings): ScheduleValidation {
  const problems: string[] = [];
  if (!isValidTimeZone(s.timeZone)) problems.push("Unknown time zone.");
  if (!Number.isInteger(s.intervalMinutes) || s.intervalMinutes < 1 || s.intervalMinutes > 1440) problems.push("Interval must be a whole number of minutes from 1 to 1440.");
  if (!Number.isInteger(s.postsPerInterval) || s.postsPerInterval < 1) problems.push("Posts per interval must be at least 1.");
  if (s.daysOfWeek.length === 0 || !s.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) problems.push("Choose at least one valid day of the week.");
  const startOk = TIME_PATTERN.test(s.windowStart), endOk = TIME_PATTERN.test(s.windowEnd);
  if (!startOk || !endOk) problems.push("Window times must look like 09:30.");
  else if (minutesOf(s.windowEnd) < minutesOf(s.windowStart)) problems.push("The window must end after it starts (windows crossing midnight are not supported).");
  if (s.dailyMax !== null && (!Number.isInteger(s.dailyMax) || s.dailyMax < 1)) problems.push("Daily maximum must be at least 1, or empty.");
  if (s.endDate !== null && (!DATE_PATTERN.test(s.endDate) || Number.isNaN(Date.parse(s.endDate)))) problems.push("End date must look like 2026-12-31.");
  return { valid: problems.length === 0, problems, warnings: [PLATFORM_LIMITS_NOTE] };
}

/** Largest number of posts the settings allow on one allowed day. Used for plain-language previews. */
export function maxPostsPerAllowedDay(s: ScheduleSettings): number {
  const ticks = Math.floor((minutesOf(s.windowEnd) - minutesOf(s.windowStart)) / s.intervalMinutes) + 1;
  const total = ticks * s.postsPerInterval;
  return s.dailyMax === null ? total : Math.min(total, s.dailyMax);
}

// ---------- Slot generation ----------
export interface SlotResult {
  slots: Date[];
  /** How many of the requested slots could not be placed (ran out of days before the end date / search limit). */
  unfilled: number;
}

/**
 * Next `count` publish times at or after `startFrom`.
 * `existingSlots` = times already used (e.g. earlier items); they count toward the daily maximum
 * and are never produced again.
 */
export function generateSlots(args: {
  settings: ScheduleSettings; startFrom: Date; count: number; existingSlots?: Date[]; maxDaysToSearch?: number;
}): SlotResult {
  const { settings, startFrom, count, existingSlots = [], maxDaysToSearch = 400 } = args;
  const validation = validateScheduleSettings(settings);
  if (!validation.valid) throw new Error(`Invalid schedule: ${validation.problems.join(" ")}`);

  const usedTimes = new Set(existingSlots.map((d) => d.getTime()));
  const usedPerDay = new Map<string, number>();
  for (const used of existingSlots) {
    const key = localDateKey(localDateOf(settings.timeZone, used));
    usedPerDay.set(key, (usedPerDay.get(key) ?? 0) + 1);
  }

  const allowedDays = new Set(settings.daysOfWeek);
  const startMinutes = minutesOf(settings.windowStart);
  const endMinutes = minutesOf(settings.windowEnd);
  const slots: Date[] = [];
  let day = localDateOf(settings.timeZone, startFrom);

  for (let searched = 0; searched < maxDaysToSearch && slots.length < count; searched++, day = addDays(day, 1)) {
    const dayKey = localDateKey(day);
    if (settings.endDate !== null && dayKey > settings.endDate) break;
    if (!allowedDays.has(weekdayOf(day))) continue;

    let postsToday = usedPerDay.get(dayKey) ?? 0;
    for (let minute = startMinutes; minute <= endMinutes && slots.length < count; minute += settings.intervalMinutes) {
      const moment = zonedTimeToUtc(settings.timeZone, day.year, day.month, day.day, Math.floor(minute / 60), minute % 60);
      if (moment < startFrom) continue;
      for (let k = 0; k < settings.postsPerInterval && slots.length < count; k++) {
        if (settings.dailyMax !== null && postsToday >= settings.dailyMax) break;
        if (usedTimes.has(moment.getTime())) continue;
        slots.push(moment);
        postsToday++;
      }
    }
  }
  return { slots, unfilled: count - slots.length };
}

// ---------- Attaching slots to items ----------
export interface ScheduleAssignment {
  items: CycleItem[];
  /** Upcoming items that did not get a time (not enough slots). They stay "upcoming". */
  unscheduledItemIds: string[];
}

/**
 * Give editable items (upcoming/scheduled), in queue order, the next slots.
 * Published, in-flight, failed and needs-review items are never touched.
 */
export function assignSlotsToItems(items: CycleItem[], slots: Date[]): ScheduleAssignment {
  const queue = items.filter(isEditableItem).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const newTimeById = new Map<string, Date>();
  const unscheduledItemIds: string[] = [];
  queue.forEach((item, index) => {
    const slot = slots[index];
    if (slot) newTimeById.set(item.id, slot); else unscheduledItemIds.push(item.id);
  });
  return {
    unscheduledItemIds,
    items: items.map((item) => {
      const slot = newTimeById.get(item.id);
      if (!slot) return item;
      if (item.status === "scheduled" && item.scheduledFor?.getTime() === slot.getTime()) return item; // unchanged
      return { ...item, status: "scheduled", scheduledFor: slot, version: item.version + 1 };
    }),
  };
}
