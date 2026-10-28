import { formatDateTime } from "./format.ts";
import { PLATFORM_LIMITS_NOTE } from "../lib/domain/schedule.ts";

/** Shows the computed publish times in the user's own time zone, and how many could not be placed. */
export function SchedulePreview({ slots, unfilled, timeZone }: { slots: Date[]; unfilled: number; timeZone: string }) {
  return (
    <section aria-labelledby="schedule-heading">
      <h2 id="schedule-heading">Publishing times ({timeZone})</h2>
      {slots.length === 0 ? <p>No publishing times fit these settings.</p> : (
        <ol>{slots.map((slot) => <li key={slot.toISOString()}><time dateTime={slot.toISOString()}>{formatDateTime(slot, timeZone)}</time></li>)}</ol>
      )}
      {unfilled > 0 && <p role="alert">{unfilled} video{unfilled === 1 ? "" : "s"} did not get a time because the schedule runs out (end date or search limit). Extend the schedule to include them.</p>}
      <p className="muted">{PLATFORM_LIMITS_NOTE}</p>
    </section>
  );
}
