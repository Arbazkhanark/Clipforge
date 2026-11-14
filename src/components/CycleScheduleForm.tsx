// src/components/CycleScheduleForm.tsx
"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { generateSlots, localDateKey, localDateOf, validateScheduleSettings, zonedTimeToUtc, type ScheduleSettings } from "../lib/domain/schedule.ts";
import { ORDER_MODES, orderItemIds, type OrderMode } from "../lib/domain/ordering.ts";
import type { PersistedCycleSchedule } from "../server/repository.ts";
import { formatDateTime } from "./format.ts";

const WEEKDAYS = [{ value: 0, label: "Sunday" }, { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" }, { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }];
const TIME_ZONES = ["Asia/Kolkata", "UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Dubai", "Asia/Singapore", "Australia/Sydney"];

const DEFAULT_SETTINGS: ScheduleSettings = { timeZone: "Asia/Kolkata", intervalMinutes: 1440, postsPerInterval: 1, daysOfWeek: [1, 2, 3, 4, 5], windowStart: "09:00", windowEnd: "09:00", dailyMax: 1, endDate: null };
type PreviewItem = { id: string; position: number; title: string; sizeBytes?: number; createdAt?: string };

function newShuffleSeed(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function CycleScheduleForm({ cycleId, items, initialSchedule, initialStartDate, timeZone, initialOrderMode = "manual", editable }: {
  cycleId: string; items: PreviewItem[]; initialSchedule: PersistedCycleSchedule | null; initialStartDate: string; timeZone: string; initialOrderMode?: OrderMode; editable: boolean;
}) {
  const [settings, setSettings] = useState<ScheduleSettings>(() => initialSchedule ? {
    timeZone: initialSchedule.timeZone, intervalMinutes: initialSchedule.intervalMinutes, postsPerInterval: initialSchedule.postsPerInterval,
    daysOfWeek: [...initialSchedule.daysOfWeek], windowStart: initialSchedule.windowStart, windowEnd: initialSchedule.windowEnd,
    dailyMax: initialSchedule.dailyMax, endDate: initialSchedule.endDate,
  } : { ...DEFAULT_SETTINGS, timeZone });
  const [startDate, setStartDate] = useState(initialSchedule?.startDate ?? initialStartDate);
  const [orderMode, setOrderMode] = useState<OrderMode>(initialOrderMode);
  const [shuffleSeed, setShuffleSeed] = useState(initialSchedule?.shuffleSeed ?? cycleId);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [hasSaved, setHasSaved] = useState(true);

  const preview = useMemo(() => {
    const validation = validateScheduleSettings(settings);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return { problems: [...validation.problems, "Start date must use YYYY-MM-DD format."], assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    const parsed = new Date(`${startDate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== startDate) return { problems: [...validation.problems, "Start date must be a real calendar date."], assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    if (settings.endDate !== null && settings.endDate < startDate) return { problems: [...validation.problems, "End date cannot be before the start date."], assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    if (!validation.valid) return { problems: validation.problems, assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    if (startDate < localDateKey(localDateOf(settings.timeZone, new Date()))) return { problems: [...validation.problems, "Start date cannot be before today in the selected time zone."], assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    try {
      const [year, month, day] = startDate.split("-").map(Number);
      const startingTime = zonedTimeToUtc(settings.timeZone, year!, month!, day!, Number(settings.windowStart.slice(0, 2)), Number(settings.windowStart.slice(3, 5)));
      const slots = generateSlots({ settings, startFrom: new Date(Math.max(startingTime.getTime(), Date.now())), count: items.length }).slots;
      const ids = orderItemIds(items.map((item) => ({
        id: item.id,
        manualPosition: item.position,
        selectionIndex: item.position,
        title: item.title,
        mediaCreatedAt: new Date(item.createdAt ?? "1970-01-01T00:00:00.000Z"),
        sizeBytes: item.sizeBytes ?? 0,
      })), orderMode, shuffleSeed);
      const byId = new Map(items.map((item) => [item.id, item]));
      const ordered = ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
      return { problems: [], assignments: ordered.map((item, index) => ({ item, slot: slots[index] ?? null })) };
    } catch {
      return { problems: ["These settings could not produce a schedule. Check the time zone, date and publishing window."], assignments: [] as { item: PreviewItem; slot: Date | null }[] };
    }
  }, [settings, startDate, items, orderMode, shuffleSeed, cycleId]);

  const change = <K extends keyof ScheduleSettings>(key: K, value: ScheduleSettings[K]) => { setSettings((current) => ({ ...current, [key]: value })); setHasSaved(false); };
  const setDay = (day: number, checked: boolean) => change("daysOfWeek", checked ? [...settings.daysOfWeek, day].sort() : settings.daysOfWeek.filter((value) => value !== day));
  const formatted = (slot: Date) => formatDateTime(slot, settings.timeZone);
  return (
    <section aria-labelledby="schedule-heading" className="cycles-form-card cycles-schedule-card">
      <h2 id="schedule-heading">Publishing schedule</h2>
      <p>Plan when these videos are scheduled in ClipForge. This is a planned schedule; it does not publish Reels to Instagram.</p>
      {!editable ? <p>This cycle is no longer a draft, so its schedule cannot be edited.</p> : (
        <>
          <form method="post" action="/api/forms/cycle-schedule" className="cycle-schedule-form" onChange={() => setHasSaved(false)}>
            <input type="hidden" name="cycleId" value={cycleId} />
            <fieldset className="cycle-order-controls">
              <legend>Order videos by</legend>
              <label htmlFor="cycle-order-mode">Publishing order</label>
              <select id="cycle-order-mode" name="orderMode" value={orderMode} onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                const next = event.currentTarget.value as OrderMode;
                if (!(ORDER_MODES as readonly string[]).includes(next)) return;
                if (next === "shuffle" && orderMode !== "shuffle") setShuffleSeed(newShuffleSeed());
                setOrderMode(next);
                setHasSaved(false);
              }}>
                <optgroup label="Name"><option value="name_asc">Name A–Z</option><option value="name_desc">Name Z–A</option></optgroup>
                <optgroup label="File size"><option value="smallest_first">Smallest first</option><option value="largest_first">Largest first</option></optgroup>
                <optgroup label="Upload date"><option value="oldest_first">Oldest first</option><option value="newest_first">Newest first</option></optgroup>
                <optgroup label="Other"><option value="manual">Keep current order</option><option value="upload_order">Original queue order</option><option value="shuffle">Randomized order (stable)</option></optgroup>
              </select>
              {orderMode === "shuffle" && <button type="button" onClick={() => { setShuffleSeed(newShuffleSeed()); setHasSaved(false); }}>Reshuffle</button>}
              <p>Only upcoming and scheduled videos are reordered. Published or in-progress videos keep their history.</p>
            </fieldset>
            <input type="hidden" name="shuffleSeed" value={orderMode === "shuffle" ? shuffleSeed : ""} />
            <div className="cycle-schedule-fields">
              <label>Start date<input type="date" name="startDate" required value={startDate} onChange={(event: ChangeEvent<HTMLInputElement>) => { setStartDate(event.currentTarget.value); setHasSaved(false); }} /></label>
              <label>Time zone<input type="text" name="timeZone" list="cycle-time-zones" required value={settings.timeZone} onChange={(event: ChangeEvent<HTMLInputElement>) => change("timeZone", event.currentTarget.value)} /><datalist id="cycle-time-zones">{TIME_ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist></label>
              <label>Preferred publishing time<input type="time" name="windowStart" required value={settings.windowStart} onChange={(event: ChangeEvent<HTMLInputElement>) => change("windowStart", event.currentTarget.value)} /></label>
              <label>Window ends<input type="time" name="windowEnd" required value={settings.windowEnd} onChange={(event: ChangeEvent<HTMLInputElement>) => change("windowEnd", event.currentTarget.value)} /></label>
              <label>Interval (minutes)<input type="number" name="intervalMinutes" min={1} max={1440} required value={settings.intervalMinutes} onChange={(event: ChangeEvent<HTMLInputElement>) => change("intervalMinutes", Number(event.currentTarget.value))} /></label>
              <label>Reels per publishing time<input type="number" name="postsPerInterval" min={1} required value={settings.postsPerInterval} onChange={(event: ChangeEvent<HTMLInputElement>) => change("postsPerInterval", Number(event.currentTarget.value))} /></label>
            </div>
            <fieldset className="cycle-publishing-days">
              <legend>Publishing days</legend>
              {WEEKDAYS.map((day) => <label key={day.value}><input type="checkbox" name="daysOfWeek" value={day.value} checked={settings.daysOfWeek.includes(day.value)} onChange={(event: ChangeEvent<HTMLInputElement>) => setDay(day.value, event.currentTarget.checked)} /> {day.label} </label>)}
            </fieldset>
            <details className="cycle-schedule-advanced">
              <summary>Advanced limits <span>Optional</span></summary>
              <div className="cycle-schedule-fields">
                <label>Maximum per day<input type="number" name="dailyMax" min={1} value={settings.dailyMax ?? ""} onChange={(event: ChangeEvent<HTMLInputElement>) => change("dailyMax", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))} /></label>
                <label>Stop scheduling after<input type="date" name="endDate" value={settings.endDate ?? ""} onChange={(event: ChangeEvent<HTMLInputElement>) => change("endDate", event.currentTarget.value || null)} /></label>
              </div>
            </details>
            <div className="cycle-schedule-actions"><button type="button" onClick={() => setPreviewRequested(true)}>Preview schedule</button><button type="submit" disabled={preview.problems.length > 0}>Save Schedule</button></div>
            {hasSaved && initialSchedule ? <p role="status">Schedule saved. No Reel has been published.</p> : !hasSaved ? <p role="status">Schedule has unsaved changes.</p> : null}
          </form>
          {previewRequested && preview.problems.length > 0 && <div role="alert"><p>Check the schedule settings:</p><ul>{preview.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}
        </>
      )}
      <h3 className="cycle-upcoming-heading">Upcoming Reels preview</h3>
      {items.length === 0 ? <p>This cycle has no editable videos to schedule yet.</p> : (
        <ol>
          {preview.assignments.map(({ item, slot }, index) => <li key={item.id}><strong>{index + 1}. {item.title}</strong> — {slot ? <time dateTime={slot.toISOString()}>{formatted(slot)} ({settings.timeZone})</time> : <span>Not scheduled — no available time</span>}</li>)}
        </ol>
      )}
      <p className="muted">Times are shown in {settings.timeZone}. This preview represents planned dates in ClipForge only.</p>
    </section>
  );
}
