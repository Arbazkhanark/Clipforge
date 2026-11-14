//src/components/CycleViews.tsx
import type { CycleCard, CycleDetail } from "../server/queries.ts";
import { CYCLE_STATUS_LABELS } from "./format.ts";
import { CycleEditor, RepeatModeForm, StartCycleForm } from "./CycleForms.tsx";
import { PreflightPanel } from "./PreflightPanel.tsx";
import { CycleScheduleForm } from "./CycleScheduleForm.tsx";
import { isEditableItem } from "../lib/domain/cycle-state.ts";
import { formatDateTime } from "./format.ts";

const ACCOUNT_STATUS = { connected: "Connected", token_expired: "Token expired", revoked: "Permissions revoked", disconnected: "Disconnected" } as const;

function scheduleFrequency(intervalMinutes: number, postsPerInterval: number): string {
  const cadence = intervalMinutes % 1440 === 0
    ? intervalMinutes === 1440 ? "daily" : `every ${intervalMinutes / 1440} days`
    : intervalMinutes % 60 === 0
      ? intervalMinutes === 60 ? "hourly" : `every ${intervalMinutes / 60} hours`
      : `every ${intervalMinutes} minutes`;
  return `${postsPerInterval} ${postsPerInterval === 1 ? "Reel" : "Reels"} ${cadence}`;
}

export function CyclesOverviewView({ cycles }: { cycles: CycleCard[] }) {
  const summary = [
    { label: "All cycles", value: cycles.length, tone: "total" },
    { label: "Running", value: cycles.filter((cycle) => cycle.status === "running").length, tone: "running" },
    { label: "Paused", value: cycles.filter((cycle) => cycle.status === "paused").length, tone: "paused" },
    { label: "Completed / stopped", value: cycles.filter((cycle) => cycle.status === "completed" || cycle.status === "stopped").length, tone: "completed" },
    { label: "Cycles needing attention", value: cycles.filter((cycle) => cycle.needsAttention > 0).length, tone: "attention" },
  ];
  return (
    <section className="cycles-page" aria-labelledby="cycles-heading">
      <header className="cycles-page-header">
        <div>
          <p className="cycles-eyebrow">PLAN · REVIEW · TRACK</p>
          <h1 id="cycles-heading">Publishing cycles</h1>
          <p className="cycles-page-intro">A cycle groups your videos and their planned publishing schedule. Review progress and status here; starting a cycle does not publish a Reel.</p>
        </div>
        <a className="cycles-primary-link" href="#new-cycle-heading"><span aria-hidden="true">＋</span> Create cycle</a>
      </header>

      <section className="cycles-summary" aria-label="Cycle summary">
        {summary.map((item) => (
          <article className={`cycles-summary-card cycles-summary-${item.tone}`} key={item.label}>
            <span>{item.label}</span><strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <section className="cycles-list-section" aria-labelledby="cycles-list-heading">
        <div className="cycles-section-heading">
          <div><p className="cycles-eyebrow">YOUR WORKSPACE</p><h2 id="cycles-list-heading">Your cycles</h2></div>
          <span className="cycles-count">{cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}</span>
        </div>
        {cycles.length === 0 ? (
          <div className="cycles-empty-state">
            <span className="cycles-empty-icon" aria-hidden="true">↗</span>
            <h3>Your publishing workspace starts here</h3>
            <p>Create a cycle to group videos, review the publishing preflight and plan dates. ClipForge will show the status here; publishing availability depends on the configured account and worker.</p>
            <a className="cycles-primary-link" href="#new-cycle-heading">Create your first cycle</a>
          </div>
        ) : (
          <div className="cycles-table-scroll" role="region" aria-label="Publishing cycles" tabIndex={0}>
            <table className="cycles-table">
              <caption className="visually-hidden">Publishing cycles and their current progress</caption>
              <thead><tr><th scope="col">Cycle</th><th scope="col">Status</th><th scope="col">Published</th><th scope="col">Upcoming</th><th scope="col">Attention</th><th scope="col"><span className="visually-hidden">Details</span></th></tr></thead>
              <tbody>{cycles.map((cycle) => {
                const percent = cycle.totalItems > 0 ? Math.round((cycle.published / cycle.totalItems) * 100) : 0;
                return (
                  <tr key={cycle.id} data-cycle-id={cycle.id}>
                    <th scope="row"><a className="cycles-name-link" href={`/cycles/${cycle.id}`}>{cycle.name}</a><span className="cycles-row-caption">{cycle.totalItems} {cycle.totalItems === 1 ? "video" : "videos"} in this cycle</span></th>
                    <td><span className={`cycles-status cycles-status-${cycle.status}`}><span aria-hidden="true" />{CYCLE_STATUS_LABELS[cycle.status]}</span></td>
                    <td><div className="cycles-progress-copy"><strong>{cycle.published}</strong><span> / {cycle.totalItems}</span></div><div className="cycles-progress-track" role="progressbar" aria-label={`${cycle.name} published progress`} aria-valuemin={0} aria-valuemax={cycle.totalItems || 1} aria-valuenow={cycle.published}><span style={{ width: `${percent}%` }} /></div></td>
                    <td aria-label={`${cycle.upcoming} upcoming ${cycle.upcoming === 1 ? "video" : "videos"}`}><strong>{cycle.upcoming}</strong><span className="cycles-cell-caption">{cycle.upcoming === 1 ? "video" : "videos"}</span></td>
                    <td>{cycle.needsAttention > 0 ? <span className="cycles-attention-count">{cycle.needsAttention} need review</span> : <span className="cycles-cell-caption">None</span>}</td>
                    <td><a className="cycles-detail-link" href={`/cycles/${cycle.id}`} aria-label={`View ${cycle.name} details`}>View details <span aria-hidden="true">→</span></a></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      <p className="cycles-integrity-note"><span aria-hidden="true">ⓘ</span> Status and counts reflect the cycle data currently available in ClipForge. Publishing itself depends on a connected eligible Instagram account, valid authorization and worker availability.</p>
    </section>
  );
}

export function CycleDetailView({ detail, timeZone, instagramLoginConfigured }: { detail: CycleDetail; timeZone: string; instagramLoginConfigured: boolean }) {
  const publishing = detail.publishing;
  const ended = detail.cycle.status === "completed" || detail.cycle.status === "stopped";
  const totalItems = detail.items.length;
  const publishedItems = detail.items.filter((item) => item.status === "published").length;
  const upcomingItems = detail.items.filter((item) => item.status === "upcoming" || item.status === "scheduled").length;
  const nextScheduled = detail.items.filter((item) => item.status === "scheduled" && item.scheduledFor).sort((a, b) => a.scheduledFor!.getTime() - b.scheduledFor!.getTime())[0];
  const progress = totalItems > 0 ? Math.round((publishedItems / totalItems) * 100) : 0;
  const statusTone = detail.cycle.status;
  const schedule = detail.cycle.scheduleSettings;
  return (
    <section className="cycle-detail-page" aria-labelledby="cycle-detail-heading">
      <a className="cycles-back-link" href="/cycles"><span aria-hidden="true">←</span> All cycles</a>
      <header className="cycles-detail-header">
        <div><p className="cycles-eyebrow">PUBLISHING CYCLE</p><h1 id="cycle-detail-heading">{detail.cycle.name}</h1><p>Review this cycle’s status, schedule and video-level publishing progress.</p></div>
        <span className={`cycles-status cycles-status-${statusTone}`}><span aria-hidden="true" />{CYCLE_STATUS_LABELS[detail.cycle.status]}</span>
      </header>
      <section className="cycles-detail-summary" aria-label="Cycle progress summary">
        <article className="cycles-detail-metric"><span>Published</span><strong>{publishedItems}<small> / {totalItems}</small></strong><div className="cycles-progress-track" role="progressbar" aria-label="Published video progress" aria-valuemin={0} aria-valuemax={totalItems || 1} aria-valuenow={publishedItems}><span style={{ width: `${progress}%` }} /></div><small>{progress}% of cycle items</small></article>
        <article className="cycles-detail-metric"><span>Upcoming</span><strong>{upcomingItems}</strong><small>Videos not yet published</small></article>
        <article className="cycles-detail-metric"><span>Eligible for a later round</span><strong>{publishing.eligibleUnpublishedCount}</strong><small>Based on current cycle eligibility</small></article>
        <article className="cycles-detail-metric"><span>Next scheduled Reel</span><strong className="cycles-next-date">{nextScheduled?.scheduledFor ? formatDateTime(nextScheduled.scheduledFor, timeZone) : "Not scheduled"}</strong><small>{nextScheduled ? timeZone : "No scheduled item is available"}</small></article>
        <article className="cycles-detail-metric"><span>Publishing frequency</span><strong className="cycles-next-date">{schedule ? scheduleFrequency(schedule.intervalMinutes, schedule.postsPerInterval) : "Not set"}</strong><small>{schedule ? `Planned interval · ${schedule.timeZone}` : "No saved schedule settings"}</small></article>
      </section>
      <section aria-labelledby="publishing-status-heading" className="cycles-status-panel">
        <h2 id="publishing-status-heading">Publishing status</h2>
        <p role="status">Starting a cycle changes its status in ClipForge; it does not publish a Reel. Scheduled Reels are handled separately by the publishing worker when it is running and each item passes its publishing checks.</p>
        {!instagramLoginConfigured && <p>Instagram Login is not configured on this server. The Connect button explains that instead of opening Meta.</p>}
        <p>Account status: {publishing.accountStatus ? ACCOUNT_STATUS[publishing.accountStatus] : "No account is stored for this cycle."}</p>
        <p>Token expiry: {publishing.tokenExpiresAt ? publishing.tokenExpiresAt : "Not stored"}{publishing.tokenExpired ? ". The stored expiry is in the past. Reconnect the account." : ""}</p>
        <p>Missing permissions: {publishing.accountStatus === null ? "Not checked, because no account is stored." : publishing.missingPermissions.length > 0 ? publishing.missingPermissions.join(", ") : "None of the required Instagram Login publishing permissions are missing."}</p>
        <p>Definite publishing failures in a row: {publishing.definiteFailureStreak}. ClipForge pauses new claims after 3. That count comes from stored PublishingJob records.</p>
        <p>Automatic pause: {publishing.pauseReason ?? "Not paused."}</p>
        <p>{publishing.eligibleUnpublishedCount} item{publishing.eligibleUnpublishedCount === 1 ? "" : "s"} could be copied into a later round. Published, publishing, and processing items are not included.</p>
      </section>
      <div className="cycles-form-grid"><RepeatModeForm cycleId={detail.cycle.id} repeatBehavior={publishing.repeatBehavior} ended={ended} />
      {detail.cycle.status === "draft" && <CycleScheduleForm cycleId={detail.cycle.id} initialSchedule={detail.cycle.scheduleSettings ?? null} initialStartDate={detail.scheduleStartDate} timeZone={detail.cycle.timezone ?? timeZone} initialOrderMode={detail.cycle.orderMode ?? "manual"} editable items={detail.items.filter(isEditableItem).map((item) => ({ id: item.id, position: item.position, title: detail.mediaOrderData[item.mediaAssetId]?.title ?? detail.mediaTitles[item.mediaAssetId] ?? "Unavailable video", sizeBytes: detail.mediaOrderData[item.mediaAssetId]?.sizeBytes ?? 0, createdAt: detail.mediaOrderData[item.mediaAssetId]?.createdAt ?? new Date(0).toISOString() }))} />}</div>
      <p className="muted">Starting a cycle does not send a Reel. Connect Instagram from the Instagram page when you are ready to store a token.</p>
      {detail.cycle.status === "draft" && <div className="cycles-preflight-wrap"><PreflightPanel report={detail.report} /></div>}
      <section className="cycles-items-section" aria-labelledby="cycle-videos-heading"><div className="cycles-section-heading"><div><p className="cycles-eyebrow">CONTENT IN THIS CYCLE</p><h2 id="cycle-videos-heading">Videos & publishing details</h2></div><span className="cycles-count">{totalItems} {totalItems === 1 ? "video" : "videos"}</span></div><CycleEditor detail={detail} timeZone={timeZone} /></section>
      {detail.cycle.status === "draft" && <StartCycleForm cycleId={detail.cycle.id} readyToConfirm={detail.readyToConfirm} />}
    </section>
  );
}
