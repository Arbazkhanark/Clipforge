//src/components/CycleViews.tsx
import type { CycleCard, CycleDetail } from "../server/queries.ts";
import { CYCLE_STATUS_LABELS } from "./format.ts";
import { CycleEditor, RepeatModeForm, StartCycleForm } from "./CycleForms.tsx";
import { PreflightPanel } from "./PreflightPanel.tsx";
import { CycleScheduleForm } from "./CycleScheduleForm.tsx";
import { isEditableItem } from "../lib/domain/cycle-state.ts";

const ACCOUNT_STATUS = { connected: "Connected", token_expired: "Token expired", revoked: "Permissions revoked", disconnected: "Disconnected" } as const;

export function CyclesOverviewView({ cycles }: { cycles: CycleCard[] }) {
  return (
    <>
      <h1>Publishing cycles</h1>
      {cycles.length === 0 ? <p>You have no publishing cycles yet.</p> : (
        <ul className="card-list">
          {cycles.map((c) => (
            <li key={c.id} className="card" data-cycle-id={c.id}>
              <h2><a href={`/cycles/${c.id}`}>{c.name}</a></h2>
              <p>{CYCLE_STATUS_LABELS[c.status]}</p>
              <p className="muted">{c.totalItems} videos - {c.upcoming} upcoming - {c.published} published{c.needsAttention > 0 ? ` - ${c.needsAttention} need attention` : ""}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function CycleDetailView({ detail, timeZone, instagramLoginConfigured }: { detail: CycleDetail; timeZone: string; instagramLoginConfigured: boolean }) {
  const publishing = detail.publishing;
  const ended = detail.cycle.status === "completed" || detail.cycle.status === "stopped";
  return (
    <>
      <p><a href="/cycles">All cycles</a></p>
      <h1>{detail.cycle.name}</h1>
      <p>Status: <strong>{CYCLE_STATUS_LABELS[detail.cycle.status]}</strong></p>
      <section aria-labelledby="publishing-status-heading" className="card">
        <h2 id="publishing-status-heading">Publishing status</h2>
        <p role="status">Live publishing is not configured. ClipForge has no publishing worker, so this cycle will not send a Reel.</p>
        {!instagramLoginConfigured && <p>Instagram Login is not configured on this server. The Connect button explains that instead of opening Meta.</p>}
        <p>Account status: {publishing.accountStatus ? ACCOUNT_STATUS[publishing.accountStatus] : "No account is stored for this cycle."}</p>
        <p>Token expiry: {publishing.tokenExpiresAt ? publishing.tokenExpiresAt : "Not stored"}{publishing.tokenExpired ? ". The stored expiry is in the past. Reconnect the account." : ""}</p>
        <p>Missing permissions: {publishing.accountStatus === null ? "Not checked, because no account is stored." : publishing.missingPermissions.length > 0 ? publishing.missingPermissions.join(", ") : "None of the required Instagram Login publishing permissions are missing."}</p>
        <p>Definite publishing failures in a row: {publishing.definiteFailureStreak}. ClipForge pauses new claims after 3. That count comes from stored PublishingJob records.</p>
        <p>Automatic pause: {publishing.pauseReason ?? "Not paused."}</p>
        <p>{publishing.eligibleUnpublishedCount} item{publishing.eligibleUnpublishedCount === 1 ? "" : "s"} could be copied into a later round. Published, publishing, and processing items are not included.</p>
      </section>
      <RepeatModeForm cycleId={detail.cycle.id} repeatBehavior={publishing.repeatBehavior} ended={ended} />
      <p className="muted">Starting a cycle does not send a Reel. Connect Instagram from the Instagram page when you are ready to store a token.</p>
      {detail.cycle.status === "draft" && <PreflightPanel report={detail.report} />}
      {detail.cycle.status === "draft" && <CycleScheduleForm cycleId={detail.cycle.id} initialSchedule={detail.cycle.scheduleSettings ?? null} initialStartDate={detail.scheduleStartDate} timeZone={detail.cycle.timezone ?? timeZone} editable items={detail.items.filter(isEditableItem).map((item) => ({ id: item.id, position: item.position, title: detail.mediaTitles[item.mediaAssetId] ?? "Unavailable video" }))} />}
      <CycleEditor detail={detail} timeZone={timeZone} />
      {detail.cycle.status === "draft" && <StartCycleForm cycleId={detail.cycle.id} readyToConfirm={detail.readyToConfirm} />}
    </>
  );
}
