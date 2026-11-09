import type { BillingInterval } from "./catalog.ts";

/** Add a billing calendar month, clamping to its last valid day (e.g. Jan 31 -> Feb 28/29). */
export function accessPeriodEnd(start: Date, interval: BillingInterval): Date {
  const end = new Date(start);
  if (interval === "weekly") { end.setUTCDate(end.getUTCDate() + 7); return end; }
  const originalDay = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(originalDay, lastDay));
  return end;
}
