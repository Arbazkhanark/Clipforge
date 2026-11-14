import { test } from "node:test";
import assert from "node:assert/strict";
import {
  zonedTimeToUtc, validateScheduleSettings, generateSlots, assignSlotsToItems, maxPostsPerAllowedDay, localDateOf, PLATFORM_LIMITS_NOTE, type ScheduleSettings,
} from "../src/lib/domain/schedule.ts";
import { orderItemIds, applyOrderToItems, orderCycleItems, type OrderableItem } from "../src/lib/domain/ordering.ts";
import { makeItem } from "./helpers.ts";

const IST = "Asia/Kolkata";
const base = (over: Partial<ScheduleSettings> = {}): ScheduleSettings => ({
  timeZone: IST, intervalMinutes: 60, postsPerInterval: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  windowStart: "09:00", windowEnd: "11:00", dailyMax: null, endDate: null, ...over,
});
const iso = (slots: Date[]) => slots.map((d) => d.toISOString());

test("time zone conversion: India has no DST, New York does", () => {
  assert.equal(zonedTimeToUtc(IST, 2026, 6, 1, 9, 0).toISOString(), "2026-06-01T03:30:00.000Z");
  assert.equal(zonedTimeToUtc("America/New_York", 2026, 3, 6, 9, 0).toISOString(), "2026-03-06T14:00:00.000Z"); // EST
  assert.equal(zonedTimeToUtc("America/New_York", 2026, 3, 9, 9, 0).toISOString(), "2026-03-09T13:00:00.000Z"); // EDT after 8 Mar
  assert.deepEqual(localDateOf(IST, new Date("2026-06-01T20:00:00Z")), { year: 2026, month: 6, day: 2 }); // already next day in India
});

test("validation catches bad settings and always carries the unverified-limits note", () => {
  assert.equal(validateScheduleSettings(base()).valid, true);
  assert.deepEqual(validateScheduleSettings(base()).warnings, [PLATFORM_LIMITS_NOTE]);
  const bad: Partial<ScheduleSettings>[] = [{ timeZone: "Mars/Base" }, { intervalMinutes: 0 }, { intervalMinutes: 1441 }, { intervalMinutes: 1.5 }, { postsPerInterval: 0 },
    { daysOfWeek: [] }, { daysOfWeek: [7] }, { windowStart: "9:00" }, { windowEnd: "08:00" }, { dailyMax: 0 }, { endDate: "tomorrow" }];
  for (const over of bad) assert.equal(validateScheduleSettings(base(over)).valid, false, JSON.stringify(over));
  assert.throws(() => generateSlots({ settings: base({ intervalMinutes: 0 }), startFrom: new Date(), count: 1 }));
});

test("hourly slots inside the window, then the next day", () => {
  const { slots, unfilled } = generateSlots({ settings: base(), startFrom: new Date("2026-06-01T00:00:00Z"), count: 5 });
  // 09:00, 10:00, 11:00 IST on 1 Jun, then 09:00, 10:00 on 2 Jun.
  assert.deepEqual(iso(slots), ["2026-06-01T03:30:00.000Z", "2026-06-01T04:30:00.000Z", "2026-06-01T05:30:00.000Z", "2026-06-02T03:30:00.000Z", "2026-06-02T04:30:00.000Z"]);
  assert.equal(unfilled, 0);
});

test("starting mid-window skips earlier moments", () => {
  const { slots } = generateSlots({ settings: base(), startFrom: new Date("2026-06-01T04:00:00Z"), count: 2 }); // 09:30 IST
  assert.deepEqual(iso(slots), ["2026-06-01T04:30:00.000Z", "2026-06-01T05:30:00.000Z"]);
});

test("21-minute interval example from the brief is computed (but not called 'safe')", () => {
  const settings = base({ intervalMinutes: 21, windowStart: "09:00", windowEnd: "12:00" });
  const { slots } = generateSlots({ settings, startFrom: new Date("2026-06-01T00:00:00Z"), count: 6 });
  assert.deepEqual(iso(slots).map((s) => s.slice(11, 16)), ["03:30", "03:51", "04:12", "04:33", "04:54", "05:15"]);
  assert.equal(maxPostsPerAllowedDay(settings), 9);
  assert.ok(validateScheduleSettings(settings).warnings.includes(PLATFORM_LIMITS_NOTE));
});

test("days of the week are in the user's time zone", () => {
  // 1 Jun 2026 is a Monday. Allow only Wednesday (3): first slot is Wed 3 Jun.
  const { slots } = generateSlots({ settings: base({ daysOfWeek: [3] }), startFrom: new Date("2026-06-01T00:00:00Z"), count: 1 });
  assert.equal(iso(slots)[0], "2026-06-03T03:30:00.000Z");
});

test("daily maximum, posts per interval, and existing slots count toward the day", () => {
  const settings = base({ postsPerInterval: 2, dailyMax: 3 });
  const { slots } = generateSlots({ settings, startFrom: new Date("2026-06-01T00:00:00Z"), count: 4 });
  assert.deepEqual(iso(slots).map((s) => s.slice(0, 16)), ["2026-06-01T03:30", "2026-06-01T03:30", "2026-06-01T04:30", "2026-06-02T03:30"]);
  const withExisting = generateSlots({ settings: base({ dailyMax: 2 }), startFrom: new Date("2026-06-01T00:00:00Z"), count: 2, existingSlots: [new Date("2026-06-01T03:30:00Z")] });
  assert.deepEqual(iso(withExisting.slots), ["2026-06-01T04:30:00.000Z", "2026-06-02T03:30:00.000Z"]); // only 1 left on day one
});

test("end date limits the schedule and reports unfilled slots", () => {
  const { slots, unfilled } = generateSlots({ settings: base({ endDate: "2026-06-01" }), startFrom: new Date("2026-06-01T00:00:00Z"), count: 10 });
  assert.equal(slots.length, 3); assert.equal(unfilled, 7);
});

test("slots keep working across a daylight-saving change", () => {
  const settings = base({ timeZone: "America/New_York", windowStart: "09:00", windowEnd: "09:00" });
  const { slots } = generateSlots({ settings, startFrom: new Date("2026-03-07T00:00:00Z"), count: 3 }); // 7, 8 (DST starts), 9 March
  assert.deepEqual(iso(slots), ["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
});

test("assigning slots: queue order, only editable items, published history untouched", () => {
  const items = [
    makeItem({ id: "pub", status: "published", position: 1 }),
    makeItem({ id: "b", position: 3 }), makeItem({ id: "a", position: 2 }),
    makeItem({ id: "busy", status: "publishing", position: 4 }), makeItem({ id: "c", position: 5 }),
  ];
  const slots = generateSlots({ settings: base(), startFrom: new Date("2026-06-01T00:00:00Z"), count: 2 }).slots;
  const result = assignSlotsToItems(items, slots);
  const get = (id: string) => result.items.find((i) => i.id === id)!;
  assert.equal(get("a").scheduledFor?.toISOString(), "2026-06-01T03:30:00.000Z"); assert.equal(get("a").status, "scheduled");
  assert.equal(get("b").scheduledFor?.toISOString(), "2026-06-01T04:30:00.000Z");
  assert.equal(get("c").status, "upcoming"); assert.deepEqual(result.unscheduledItemIds, ["c"]);
  assert.equal(get("pub").version, 1); assert.equal(get("busy").status, "publishing");
  // Re-assigning identical slots changes nothing (no needless version bumps).
  const again = assignSlotsToItems(result.items, slots);
  assert.equal(again.items.find((i) => i.id === "a")!.version, get("a").version);
});

test("rescheduling clears old times from editable items that no longer fit", () => {
  const oldSlot = new Date("2026-06-01T03:30:00Z");
  const item = makeItem({ id: "scheduled", status: "scheduled", scheduledFor: oldSlot, version: 4 });
  const assigned = assignSlotsToItems([item], []);
  assert.deepEqual(assigned.unscheduledItemIds, ["scheduled"]);
  assert.deepEqual([assigned.items[0]!.status, assigned.items[0]!.scheduledFor, assigned.items[0]!.version], ["upcoming", null, 5]);
});

// ---------- Ordering ----------
const orderable = (id: string, over: Partial<OrderableItem> = {}): OrderableItem =>
  ({ id, manualPosition: 0, selectionIndex: 0, mediaCreatedAt: new Date("2026-01-01"), sizeBytes: 1, ...over });
const sample = [
  orderable("a", { manualPosition: 3, selectionIndex: 2, mediaCreatedAt: new Date("2026-03-01"), sizeBytes: 300 }),
  orderable("b", { manualPosition: 1, selectionIndex: 3, mediaCreatedAt: new Date("2026-01-01"), sizeBytes: 100 }),
  orderable("c", { manualPosition: 2, selectionIndex: 1, mediaCreatedAt: new Date("2026-02-01"), sizeBytes: 200 }),
];

test("every order mode", () => {
  assert.deepEqual(orderItemIds(sample, "manual"), ["b", "c", "a"]);
  assert.deepEqual(orderItemIds(sample, "upload_order"), ["c", "a", "b"]);
  assert.deepEqual(orderItemIds([orderable("b", { title: "Clip 10.mp4" }), orderable("a", { title: "clip 2.mp4" }), orderable("c", { title: "Alpha.mp4" })], "name_asc"), ["c", "a", "b"]);
  assert.deepEqual(orderItemIds([orderable("b", { title: "Clip 10.mp4" }), orderable("a", { title: "clip 2.mp4" }), orderable("c", { title: "Alpha.mp4" })], "name_desc"), ["b", "a", "c"]);
  assert.deepEqual(orderItemIds(sample, "oldest_first"), ["b", "c", "a"]);
  assert.deepEqual(orderItemIds(sample, "newest_first"), ["a", "c", "b"]);
  assert.deepEqual(orderItemIds(sample, "smallest_first"), ["b", "c", "a"]);
  assert.deepEqual(orderItemIds(sample, "largest_first"), ["a", "c", "b"]);
});

test("cycle ordering uses server media metadata and only changes editable positions", () => {
  const items = [
    makeItem({ id: "published", status: "published", position: 0, version: 5 }),
    makeItem({ id: "z-item", mediaAssetId: "z-media", position: 1 }),
    makeItem({ id: "a-item", mediaAssetId: "a-media", position: 2 }),
    makeItem({ id: "processing", status: "processing", position: 3, version: 8 }),
  ];
  const ordered = orderCycleItems(items, new Map([
    ["z-media", { title: "Zulu.mp4", sizeBytes: 900, createdAt: new Date("2026-01-02T00:00:00Z") }],
    ["a-media", { title: "Alpha.mp4", sizeBytes: 100, createdAt: new Date("2026-01-01T00:00:00Z") }],
  ]), "name_asc");
  assert.deepEqual(Object.fromEntries(ordered.map((item) => [item.id, [item.position, item.version]])), {
    published: [0, 5], "z-item": [2, 2], "a-item": [1, 2], processing: [3, 8],
  });
});

test("shuffle is persisted by its seed: same seed = same order regardless of input order; different seed can differ", () => {
  const many = Array.from({ length: 20 }, (_, i) => orderable(`id${String(i).padStart(2, "0")}`));
  const first = orderItemIds(many, "shuffle", "seed-1");
  assert.deepEqual(orderItemIds([...many].reverse(), "shuffle", "seed-1"), first);
  assert.notDeepEqual(orderItemIds(many, "shuffle", "seed-2"), first);
  assert.deepEqual([...first].sort(), many.map((m) => m.id).sort()); // nothing lost or duplicated
  assert.notDeepEqual(first, many.map((m) => m.id)); // actually shuffled
});

test("applying an order only moves editable items and keeps history positions", () => {
  const items = [makeItem({ id: "p", status: "published", position: 1 }), makeItem({ id: "a", position: 2 }), makeItem({ id: "b", position: 3 }), makeItem({ id: "w", status: "publishing", position: 4 })];
  const result = applyOrderToItems(items, ["b", "a", "p", "w"]);
  assert.deepEqual(Object.fromEntries(result.map((i) => [i.id, i.position])), { p: 1, a: 3, b: 2, w: 4 });
  assert.equal(result.find((i) => i.id === "p")!.version, 1);
});
