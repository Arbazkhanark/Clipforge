import type { CycleCard, CycleDetail } from "../server/queries.ts";
import { CYCLE_STATUS_LABELS } from "./format.ts";
import { CycleEditor, StartCycleForm } from "./CycleForms.tsx";
import { PreflightPanel } from "./PreflightPanel.tsx";

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

export function CycleDetailView({ detail, timeZone }: { detail: CycleDetail; timeZone: string }) {
  return (
    <>
      <p><a href="/cycles">All cycles</a></p>
      <h1>{detail.cycle.name}</h1>
      <p>Status: <strong>{CYCLE_STATUS_LABELS[detail.cycle.status]}</strong></p>
      <p className="muted">Pausing, resuming and stopping are not available in the screens yet. Publishing to Instagram is not connected.</p>
      {detail.cycle.status === "draft" && <PreflightPanel report={detail.report} />}
      <CycleEditor detail={detail} timeZone={timeZone} />
      {detail.cycle.status === "draft" && <StartCycleForm cycleId={detail.cycle.id} readyToConfirm={detail.readyToConfirm} />}
    </>
  );
}
