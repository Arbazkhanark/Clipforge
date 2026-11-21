"use client";

import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";

type Suspension = { isSuspended: boolean; suspendedAt: string | null; suspendedByAdminId: string | null; reason: string | null };

export function AdminUserSuspensionControl({ userId, email }: { userId: string; email: string }) {
  const [value, setValue] = useState<Suspension | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/admin/users/${encodeURIComponent(userId)}/suspension`;

  async function refresh() {
    setError("");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json() as { data?: Suspension; error?: { message?: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message || "Suspension status is unavailable.");
      setValue(payload.data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Suspension status is unavailable."); }
  }

  useEffect(() => { void refresh(); }, []);

  async function changeSuspension(suspended: boolean) {
    const action = suspended ? "suspend" : "reactivate";
    if (!window.confirm(`Are you sure you want to ${action} ${email}? Their data will be preserved.`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suspended, reason: reason.trim() || null }) });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || `Could not ${action} this account.`);
      setReason("");
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : `Could not ${action} this account.`); }
    finally { setBusy(false); }
  }

  return <section className="admin-user-section" aria-labelledby="admin-user-access-title">
    <h2 id="admin-user-access-title">Account access</h2>
    {!value && !error && <p role="status">Loading account access status…</p>}
    {value && <>
      <p><strong>Status: {value.isSuspended ? "SUSPENDED" : "ACTIVE"}</strong></p>
      {value.isSuspended && <p>This account cannot sign in. User data, media, collections, billing records and settings are preserved.</p>}
      {value.isSuspended && value.reason && <p>Admin reason: {value.reason}</p>}
      <label>Admin reason (optional)<textarea value={reason} maxLength={500} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.currentTarget.value)} rows={3} disabled={busy} /></label>
      <div className="admin-user-actions">
        {value.isSuspended
          ? <button type="button" onClick={() => void changeSuspension(false)} disabled={busy}>{busy ? "Saving…" : "Reactivate account"}</button>
          : <button type="button" onClick={() => void changeSuspension(true)} disabled={busy}>{busy ? "Saving…" : "Suspend account"}</button>}
      </div>
    </>}
    {error && <p className="admin-user-empty" role="alert">{error}</p>}
    {error && <button type="button" onClick={() => void refresh()} disabled={busy}>Retry status</button>}
  </section>;
}
