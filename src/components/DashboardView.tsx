import type { DashboardData } from "../server/queries.ts";
import { UsageMeter } from "./UsageMeter.tsx";
import {
  countNoun,
  CYCLE_STATUS_LABELS,
  formatCount,
  formatDateTime,
  formatStorage,
} from "./format.ts";

const FILTERS = [
  ["all", "All"],
  ["draft", "Draft"],
  ["running", "Running"],
  ["paused", "Paused"],
  ["stopped", "Stopped"],
  ["completed", "Completed"],
] as const;

function statusClass(status: string) {
  return `dashboard-status dashboard-status-${status}`;
}

export function DashboardView({
  data,
  actionsEnabled = false,
}: {
  data: DashboardData;
  actionsEnabled?: boolean;
}) {
  const { usage, counts } = data;

  return (
    <main className="dashboard-page">
      {/* Page heading */}
      <header className="dashboard-header">
        <div>
          <span className="dashboard-eyebrow">YOUR WORKSPACE</span>
          <h1>Dashboard</h1>
          <p className="dashboard-subtitle">
            Your content, campaigns and usage at a glance.
          </p>
        </div>

        <div className="dashboard-plan">
          <span className="dashboard-plan-label">CURRENT PLAN</span>
          <strong>{data.planName}</strong>
          <a href="/pricing">View plans →</a>
        </div>
      </header>

      {/* Overview */}
      <section className="dashboard-section" aria-labelledby="overview-heading">
        <div className="dashboard-section-heading">
          <div>
            <span className="dashboard-eyebrow">AT A GLANCE</span>
            <h2 id="overview-heading">Overview</h2>
          </div>
        </div>

        <div className="dashboard-stats">
          <article className="dashboard-stat-card">
            <div className="dashboard-stat-top">
              <span className="dashboard-stat-icon">▣</span>
              <span className="dashboard-stat-label">MEDIA FILES</span>
            </div>
            <strong className="dashboard-stat-value">
              {formatCount(counts.media)}
            </strong>
            <span className="dashboard-stat-description">
              {countNoun(counts.media, "file", "files")} in your library
            </span>
            <a href="/media" className="dashboard-card-link">
              View media →
            </a>
          </article>

          <article className="dashboard-stat-card">
            <div className="dashboard-stat-top">
              <span className="dashboard-stat-icon">▤</span>
              <span className="dashboard-stat-label">COLLECTIONS</span>
            </div>
            <strong className="dashboard-stat-value">
              {formatCount(counts.collections)}
            </strong>
            <span className="dashboard-stat-description">
              {countNoun(counts.collections, "collection")}
            </span>
            <a href="/collections" className="dashboard-card-link">
              View collections →
            </a>
          </article>

          <article className="dashboard-stat-card dashboard-stat-featured">
            <div className="dashboard-stat-top">
              <span className="dashboard-stat-icon">◷</span>
              <span className="dashboard-stat-label">PUBLISHING CYCLES</span>
            </div>
            <strong className="dashboard-stat-value">
              {formatCount(counts.cycles)}
            </strong>
            <span className="dashboard-stat-description">
              {formatCount(counts.runningCycles)} currently running
            </span>
            <a href="/cycles" className="dashboard-card-link">
              View campaigns →
            </a>
          </article>
        </div>
      </section>

      {/* Campaigns */}
      <section
        className="dashboard-section"
        aria-labelledby="campaigns-heading"
      >
        <div className="dashboard-section-heading dashboard-campaign-heading">
          <div>
            <span className="dashboard-eyebrow">CONTENT PLANNING</span>
            <h2 id="campaigns-heading">Your campaigns</h2>
            <p className="dashboard-section-description">
              Manage your publishing cycles and check their progress.
            </p>
          </div>

          <a href="/cycles" className="dashboard-primary-button">
            View all campaigns →
          </a>
        </div>

        <div className="dashboard-filter-wrapper">
          <nav
            aria-label="Filter campaigns by status"
            className="dashboard-filters"
          >
            {FILTERS.map(([value, label]) => (
              <a
                key={value}
                href={
                  value === "all"
                    ? "/dashboard"
                    : `/dashboard?status=${value}`
                }
                className={
                  data.statusFilter === value
                    ? "dashboard-filter active"
                    : "dashboard-filter"
                }
                aria-current={
                  data.statusFilter === value ? "page" : undefined
                }
              >
                {label}
              </a>
            ))}
          </nav>
        </div>

        {data.campaigns.length === 0 ? (
          <div className="dashboard-empty">
            <div className="dashboard-empty-icon">▤</div>
            <h3>
              {data.counts.cycles === 0
                ? "No campaigns yet"
                : "No campaigns found"}
            </h3>
            <p>
              {data.counts.cycles === 0
                ? "Create your first publishing cycle to start organizing your content."
                : "There are no campaigns matching this status. Try another filter."}
            </p>
            {data.counts.cycles === 0 && (
              <a href="/cycles" className="dashboard-primary-button">
                Go to publishing cycles →
              </a>
            )}
          </div>
        ) : (
          <div className="dashboard-campaign-list">
            {data.campaigns.map((campaign) => (
              <article
                key={campaign.id}
                className="dashboard-campaign-card"
                data-campaign-id={campaign.id}
              >
                <div className="dashboard-campaign-main">
                  <div className="dashboard-campaign-title-row">
                    <h3>
                      <a href={`/cycles/${campaign.id}`}>
                        {campaign.name}
                      </a>
                    </h3>

                    <span className={statusClass(campaign.status)}>
                      {CYCLE_STATUS_LABELS[campaign.status]}
                    </span>
                  </div>

                  {campaign.accountName && (
                    <p className="dashboard-campaign-account">
                      Instagram account: <strong>{campaign.accountName}</strong>
                    </p>
                  )}

                  <div className="dashboard-campaign-meta">
                    <span>
                      <strong>{formatCount(campaign.totalItems)}</strong>{" "}
                      {campaign.totalItems === 1 ? "video" : "videos"}
                    </span>
                    <span>
                      <strong>{formatCount(campaign.scheduledItems)}</strong>{" "}
                      scheduled
                    </span>
                  </div>

                  {campaign.totalItems === 0 && (
                    <p className="dashboard-inline-note">
                      This campaign has no videos yet.
                    </p>
                  )}

                  {campaign.scheduledItems === 0 && (
                    <p className="dashboard-inline-note">
                      No videos have planned times yet.
                    </p>
                  )}

                  {campaign.nextScheduledAt && (
                    <p className="dashboard-next-schedule">
                      <span>Next planned Reel</span>
                      <strong>
                        <time
                          dateTime={campaign.nextScheduledAt.toISOString()}
                        >
                          {formatDateTime(
                            campaign.nextScheduledAt,
                            campaign.timeZone
                          )}
                        </time>
                      </strong>
                      <span>({campaign.timeZone})</span>
                    </p>
                  )}

                  {campaign.createdAt && (
                    <p className="dashboard-created">
                      Created{" "}
                      <time
                        dateTime={campaign.createdAt.toISOString()}
                      >
                        {new Intl.DateTimeFormat("en-GB", {
                          timeZone: campaign.timeZone,
                          dateStyle: "medium",
                        }).format(campaign.createdAt)}
                      </time>
                    </p>
                  )}
                </div>

                <div className="dashboard-campaign-actions">
                  <a
                    href={`/cycles/${campaign.id}`}
                    className="dashboard-secondary-button"
                  >
                    {campaign.status === "draft"
                      ? "Edit campaign"
                      : "View details"}
                  </a>

                  {actionsEnabled && campaign.status === "running" && (
                    <form
                      action="/api/forms/cycle-status"
                      method="post"
                    >
                      <input
                        type="hidden"
                        name="cycleId"
                        value={campaign.id}
                      />
                      <input
                        type="hidden"
                        name="action"
                        value="pause"
                      />
                      <button
                        type="submit"
                        className="dashboard-action-button"
                      >
                        Pause
                      </button>
                    </form>
                  )}

                  {actionsEnabled && campaign.status === "paused" && (
                    <form
                      action="/api/forms/cycle-status"
                      method="post"
                    >
                      <input
                        type="hidden"
                        name="cycleId"
                        value={campaign.id}
                      />
                      <input
                        type="hidden"
                        name="action"
                        value="resume"
                      />
                      <button
                        type="submit"
                        className="dashboard-action-button"
                      >
                        Resume
                      </button>
                    </form>
                  )}

                  {actionsEnabled &&
                    ["draft", "running", "paused"].includes(
                      campaign.status
                    ) && (
                      <form
                        action="/api/forms/cycle-status"
                        method="post"
                        className="dashboard-stop-form"
                      >
                        <input
                          type="hidden"
                          name="cycleId"
                          value={campaign.id}
                        />
                        <input
                          type="hidden"
                          name="action"
                          value="stop"
                        />
                        <label>
                          <input
                            type="checkbox"
                            name="confirmStop"
                            value="yes"
                            required
                          />
                          Confirm stop
                        </label>
                        <button
                          type="submit"
                          className="dashboard-stop-button"
                        >
                          Stop
                        </button>
                      </form>
                    )}
                </div>
              </article>
            ))}
          </div>
        )}

        <p className="dashboard-publishing-note">
          <span aria-hidden="true">ⓘ</span>
          A publishing cycle helps plan your workflow. Starting a cycle does
          not publish a Reel to Instagram.
        </p>
      </section>

      {/* Usage */}
      <section
        className="dashboard-section"
        aria-labelledby="usage-heading"
      >
        <div className="dashboard-section-heading">
          <div>
            <span className="dashboard-eyebrow">PLAN & LIMITS</span>
            <h2 id="usage-heading">Monthly usage</h2>
            <p className="dashboard-section-description">
              Keep track of the resources included in your plan.
            </p>
          </div>
          <a href="/pricing" className="dashboard-text-link">
            Upgrade plan →
          </a>
        </div>

        <p className="dashboard-reset-notice">{data.resetNotice}</p>

        <div className="dashboard-usage-grid">
          <UsageMeter
            label="Storage"
            used={usage.storage.used}
            limit={usage.storage.limit}
            formatValue={formatStorage}
          />

          <UsageMeter
            label="Processing minutes"
            used={usage.processingMinutes.used}
            limit={usage.processingMinutes.limit}
          />

          <UsageMeter
            label="Exports"
            used={usage.exports.used}
            limit={usage.exports.limit}
          />

          <UsageMeter
            label="Scheduled items"
            used={usage.scheduledItems.used}
            limit={usage.scheduledItems.limit}
          />
        </div>
      </section>
    </main>
  );
}
