import type { DashboardData } from "../server/queries.ts";
import { UsageMeter } from "./UsageMeter.tsx";
import { countNoun, formatCount, formatStorage } from "./format.ts";

export function DashboardView({ data }: { data: DashboardData }) {
  const { usage, counts } = data;
  return (
    <>
      <h1>Dashboard</h1>
      <p>Your plan: <strong>{data.planName}</strong>. <a href="/pricing">See plans</a></p>
      <section aria-labelledby="counts-heading">
        <h2 id="counts-heading">Overview</h2>
        <ul className="stat-grid">
          <li><strong>{formatCount(counts.media)}</strong> {countNoun(counts.media, "media file", "media files")}</li>
          <li><strong>{formatCount(counts.collections)}</strong> {countNoun(counts.collections, "collection")}</li>
          <li><strong>{formatCount(counts.cycles)}</strong> {countNoun(counts.cycles, "publishing cycle", "publishing cycles")} ({formatCount(counts.runningCycles)} running)</li>
        </ul>
      </section>
      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">Usage this month</h2>
        <p className="muted">{data.resetNotice}</p>
        <UsageMeter label="Storage" used={usage.storage.used} limit={usage.storage.limit} formatValue={formatStorage} />
        <UsageMeter label="Processing minutes" used={usage.processingMinutes.used} limit={usage.processingMinutes.limit} />
        <UsageMeter label="Exports" used={usage.exports.used} limit={usage.exports.limit} />
        <UsageMeter label="Scheduled items" used={usage.scheduledItems.used} limit={usage.scheduledItems.limit} />
      </section>
    </>
  );
}
