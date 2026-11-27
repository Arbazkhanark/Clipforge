"use client";

import { useState } from "react";

export function CycleDeleteAction({ cycleId, cycleName }: { cycleId: string; cycleName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    if (busy || !window.confirm(`Delete “${cycleName}”? Pending posts that have not started publishing will be cancelled. Published posts and publishing history will be kept. This will not delete media or Instagram posts.`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/cycles/delete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ cycleId, confirm: true }) });
      const payload = await response.json() as { deleted?: boolean; error?: { message?: string } };
      if (!response.ok || payload.deleted !== true) throw new Error(payload.error?.message || "This cycle could not be deleted. Refresh and try again.");
      window.location.assign("/cycles?notice=cycle_deleted");
    } catch {
      setError("This cycle could not be deleted because the server could not confirm the request. Refresh and try again.");
    } finally { setBusy(false); }
  }

  return <div className="cycle-delete-action">
    <button type="button" onClick={() => void remove()} disabled={busy}>{busy ? "Deleting…" : "Delete Cycle"}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
