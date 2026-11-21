"use client";

import { useRef, useState, type ChangeEvent } from "react";

type Grant = { id: string; userId: string; planId: string; status: "ACTIVE" | "ON_HOLD" | "REVOKED"; grantedByAdminId: string; reason: string | null; createdAt: string; updatedAt: string };
type Event = { id: string; action: string; previousState: string | null; newState: string; actorAdminId: string; note: string | null; occurredAt: string };
type Data = { grants: Grant[]; events: Event[] };

export function ComplimentaryAccessAdmin() {
  const [userId, setUserId] = useState("");
  const [planId, setPlanId] = useState("creator");
  const [note, setNote] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const grantRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  async function load(target = userId) {
    if (!target.trim()) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/admin/complimentary-access?userId=${encodeURIComponent(target.trim())}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Could not load complimentary access.");
      setData(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load complimentary access."); setData(null); }
    finally { setBusy(false); }
  }
  async function mutate(url: string, method: "POST" | "PATCH", body: Record<string, unknown>, headers?: Record<string, string>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? "Could not update complimentary access.");
      if (method === "POST") grantRequestRef.current = null;
      setMessage(result.status === "existing" ? "This grant already exists; no duplicate event was created." : "Complimentary access updated.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not update complimentary access."); }
    finally { setBusy(false); }
  }
  function transition(grant: Grant, action: "HOLD" | "RESUME" | "REVOKE") {
    const verb = action === "HOLD" ? "put this access on hold" : action === "RESUME" ? "resume this access" : "permanently revoke this grant";
    if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
    void mutate("/api/admin/complimentary-access", "PATCH", { userId: grant.userId, grantId: grant.id, action, note: note.trim() || null });
  }
  function grantAccess() {
    const input = { userId: userId.trim(), planId, note: note.trim() || null };
    const fingerprint = JSON.stringify(input);
    if (grantRequestRef.current?.fingerprint !== fingerprint) grantRequestRef.current = { fingerprint, key: crypto.randomUUID() };
    void mutate("/api/admin/complimentary-access", "POST", input, { "Idempotency-Key": grantRequestRef.current.key });
  }
  return <section className="admin-user-section" aria-labelledby="complimentary-access-heading">
    <h2 id="complimentary-access-heading">Permanent complimentary access</h2>
    <p>Grant Creator, Pro, or Agency access without creating a payment or subscription. Hold is reversible; revoke permanently closes this grant.</p>
    <div className="admin-user-filters">
      <label>User ID<input value={userId} onChange={(event: ChangeEvent<HTMLInputElement>) => setUserId(event.currentTarget.value)} maxLength={64} /></label>
      <label>Plan<select value={planId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setPlanId(event.currentTarget.value)}><option value="creator">Creator</option><option value="pro">Pro</option><option value="agency">Agency</option></select></label>
      <label>Admin reason / note<input value={note} onChange={(event: ChangeEvent<HTMLInputElement>) => setNote(event.currentTarget.value)} maxLength={500} /></label>
      <button type="button" disabled={busy || !userId.trim()} onClick={grantAccess}>Grant permanent free access</button>
      <button type="button" disabled={busy || !userId.trim()} onClick={() => void load()}>Load access history</button>
    </div>
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">Working…</p>}
    {data && <>
      <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Access</th><th>State</th><th>Grant date</th><th>Granting admin</th><th>Reason</th><th>Actions</th></tr></thead><tbody>
        {data.grants.length === 0 ? <tr><td colSpan={6}>No complimentary access grants for this user.</td></tr> : data.grants.map((grant) => <tr key={grant.id}><td>Admin Granted — Permanent Free Access · {grant.planId}</td><td>{grant.status === "ON_HOLD" ? "ON HOLD" : grant.status}</td><td>{new Date(grant.createdAt).toLocaleString()}</td><td>{grant.grantedByAdminId}</td><td>{grant.reason ?? "—"}</td><td>{grant.status === "ACTIVE" && <><button type="button" disabled={busy} onClick={() => transition(grant, "HOLD")}>Put on hold</button><button type="button" disabled={busy} onClick={() => transition(grant, "REVOKE")}>Revoke</button></>}{grant.status === "ON_HOLD" && <><button type="button" disabled={busy} onClick={() => transition(grant, "RESUME")}>Resume</button><button type="button" disabled={busy} onClick={() => transition(grant, "REVOKE")}>Revoke</button></>}</td></tr>)}
      </tbody></table></div>
      <h3>Audit history</h3><ol>{data.events.map((event) => <li key={event.id}>{event.action}: {event.previousState ?? "—"} → {event.newState} · {new Date(event.occurredAt).toLocaleString()} · admin {event.actorAdminId}{event.note ? ` · ${event.note}` : ""}</li>)}</ol>
    </>}
  </section>;
}
