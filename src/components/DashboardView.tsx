import type { DashboardData } from "../server/queries.ts";
import { UsageMeter } from "./UsageMeter.tsx";
import { countNoun, CYCLE_STATUS_LABELS, formatCount, formatDateTime, formatStorage } from "./format.ts";

const FILTERS = [["all", "All"], ["draft", "Draft"], ["running", "Running"], ["paused", "Paused"], ["stopped", "Stopped"], ["completed", "Completed"]] as const;

export function DashboardView({ data, actionsEnabled = false }: { data: DashboardData; actionsEnabled?: boolean }) {
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
      <section aria-labelledby="campaigns-heading">
        <h2 id="campaigns-heading">Campaigns</h2>
        <p className="muted">These are planned cycles in ClipForge. Starting a cycle does not publish a Reel to Instagram.</p>
        <nav aria-label="Filter campaigns by status" className="filter-bar">
          {FILTERS.map(([value, label]) => <a key={value} href={value === "all" ? "/dashboard" : `/dashboard?status=${value}`} aria-current={data.statusFilter === value ? "page" : undefined}>{label}</a>)}
        </nav>
        {data.campaigns.length === 0 ? <p>{data.counts.cycles === 0 ? "You have no campaigns yet. Create a publishing cycle to plan your first campaign." : "No campaigns match this status filter."}</p> : (
          <ul className="card-list">
            {data.campaigns.map((campaign) => (
              <li key={campaign.id} className="card" data-campaign-id={campaign.id}>
                <h3><a href={`/cycles/${campaign.id}`}>{campaign.name}</a></h3>
                <p>Status: <strong>{CYCLE_STATUS_LABELS[campaign.status]}</strong></p>
                {campaign.accountName && <p>Instagram account: {campaign.accountName}</p>}
                <p>{campaign.totalItems} {campaign.totalItems === 1 ? "video" : "videos"}; {campaign.scheduledItems} with planned times</p>
                {campaign.totalItems === 0 && <p>This campaign has no videos yet.</p>}
                {campaign.scheduledItems === 0 && <p>No Reels have planned times yet.</p>}
                {campaign.nextScheduledAt && <p>Next planned Reel: <time dateTime={campaign.nextScheduledAt.toISOString()}>{formatDateTime(campaign.nextScheduledAt, campaign.timeZone)} ({campaign.timeZone})</time></p>}
                {campaign.createdAt && <p className="muted">Created <time dateTime={campaign.createdAt.toISOString()}>{new Intl.DateTimeFormat("en-GB", { timeZone: campaign.timeZone, dateStyle: "medium" }).format(campaign.createdAt)}</time></p>}
                <p><a href={`/cycles/${campaign.id}`}>{campaign.status === "draft" ? "Open and edit" : "Open details"}</a></p>
                {actionsEnabled && campaign.status === "running" && <form action="/api/forms/cycle-status" method="post"><input type="hidden" name="cycleId" value={campaign.id} /><input type="hidden" name="action" value="pause" /><button type="submit">Pause cycle</button></form>}
                {actionsEnabled && campaign.status === "paused" && <form action="/api/forms/cycle-status" method="post"><input type="hidden" name="cycleId" value={campaign.id} /><input type="hidden" name="action" value="resume" /><button type="submit">Resume cycle</button></form>}
                {actionsEnabled && (campaign.status === "draft" || campaign.status === "running" || campaign.status === "paused") && <form action="/api/forms/cycle-status" method="post"><input type="hidden" name="cycleId" value={campaign.id} /><input type="hidden" name="action" value="stop" /><label><input type="checkbox" name="confirmStop" value="yes" required /> I understand stopping cancels items that have not started.</label><button type="submit">Stop cycle</button></form>}
              </li>
            ))}
          </ul>
        )}
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
