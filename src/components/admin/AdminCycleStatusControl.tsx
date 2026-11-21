"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";

export function AdminCycleStatusControl({ cycleId, initialStatus }: { cycleId: string; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const supported = status === "running" || status === "paused";

  async function change(action: "pause" | "resume") {
    const description = action === "pause" ? "Pause this cycle? New publishing claims will stop; work already in progress may continue." : "Resume this cycle? Its existing schedule and queue will continue.";
    if (!window.confirm(description)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/admin/campaigns/${encodeURIComponent(cycleId)}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, reason: reason.trim() || null }) });
      const payload = await response.json() as { status?: string; inFlightItemCount?: number; error?: { message?: string } };
      if (!response.ok || !payload.status) throw new Error(payload.error?.message || "Cycle status could not be changed.");
      setStatus(payload.status);
      setReason("");
      setMessage(payload.status === "paused" && (payload.inFlightItemCount ?? 0) > 0 ? `Paused. ${payload.inFlightItemCount} item(s) already in progress may still finish.` : payload.status === "existing" ? "The cycle already had that status." : `Cycle ${payload.status}.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Cycle status could not be changed."); }
    finally { setBusy(false); }
  }

  return <section className="admin-user-section" aria-labelledby="admin-cycle-control-title">
    <h2 id="admin-cycle-control-title">Cycle controls</h2>
    <p>Current status: <strong>{status.replaceAll("_", " ")}</strong></p>
    {!supported && <p>This cycle state has no supported administrative transition.</p>}
    {supported && <>
      <label>Admin reason (optional)<textarea value={reason} maxLength={500} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.currentTarget.value)} rows={2} disabled={busy} /></label>
      <button type="button" onClick={() => void change(status === "running" ? "pause" : "resume")} disabled={busy}>
        {busy ? "Saving…" : status === "running" ? "Pause cycle" : "Resume cycle"}
      </button>
    </>}
    {message && <p role="status">{message}</p>}
    {error && <p className="admin-user-empty" role="alert">{error}</p>}
  </section>;
}
