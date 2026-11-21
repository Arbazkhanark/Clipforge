"use client";

import { useRef, useState, type ChangeEvent } from "react";

type Grant = { id: string; userId: string; planId: string; status: "ACTIVE" | "ON_HOLD" | "REVOKED"; grantedByAdminId: string; reason: string | null; createdAt: string; updatedAt: string };
type Event = { id: string; action: string; previousState: string | null; newState: string; actorAdminId: string; note: string | null; occurredAt: string };
type Data = { grants: Grant[]; events: Event[]; currentPlan: string | null };
type UserChoice = { id: string; name: string | null; email: string; emailVerified: string | null };
const SETUP_CODE = "complimentary_access_setup_required";

export function ComplimentaryAccessAdmin() {
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<UserChoice[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserChoice | null>(null);
  const [planId, setPlanId] = useState("creator");
  const [note, setNote] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const grantRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);

  function setRequestError(body: { error?: { code?: string; message?: string } }, fallback: string) {
    if (body.error?.code === SETUP_CODE) {
      setSetupRequired(true);
      setData(null);
      setMessage("");
      return;
    }
    setMessage(body.error?.message ?? fallback);
  }

  async function searchUsers() {
    setBusy(true); setMessage(""); setUserResults([]);
    try {
      const query = new URLSearchParams({ search: userSearch.trim(), pageSize: "10" });
      const response = await fetch(`/api/admin/users?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) { setRequestError(body, "Could not search users."); return; }
      setUserResults(body.data.items);
      if (body.data.items.length === 0) setMessage("No users match this search.");
    } catch { setMessage("Could not search users. Check your connection and try again."); }
    finally { setBusy(false); }
  }

  async function load(target = selectedUser?.id) {
    if (!target) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/admin/complimentary-access?userId=${encodeURIComponent(target)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) { setRequestError(body, "Could not load complimentary access."); return; }
      setSetupRequired(false);
      setData(body);
    } catch { setMessage("Could not load complimentary access. Check your connection and try again."); setData(null); }
    finally { setBusy(false); }
  }

  async function mutate(method: "POST" | "PATCH", body: Record<string, unknown>, headers?: Record<string, string>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/complimentary-access", { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setRequestError(result, "Could not update complimentary access."); return; }
      if (method === "POST") grantRequestRef.current = null;
      setMessage(result.status === "existing" ? "This access state already exists; no duplicate audit event was recorded." : "Complimentary access updated.");
      await load();
    } catch { setMessage("The update result could not be confirmed. Refresh access and history before retrying."); }
    finally { setBusy(false); }
  }

  function transition(grant: Grant, action: "HOLD" | "RESUME" | "REVOKE") {
    const verb = action === "HOLD" ? "put this access on hold" : action === "RESUME" ? "resume this access" : "permanently revoke this grant";
    if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
    void mutate("PATCH", { userId: grant.userId, grantId: grant.id, action, note: note.trim() || null });
  }

  function grantAccess() {
    if (!selectedUser) return;
    if (!window.confirm(`Grant permanent ${planId} complimentary access to ${selectedUser.email}?`)) return;
    const input = { userId: selectedUser.id, planId, note: note.trim() || null };
    const fingerprint = JSON.stringify(input);
    if (grantRequestRef.current?.fingerprint !== fingerprint) grantRequestRef.current = { fingerprint, key: crypto.randomUUID() };
    void mutate("POST", input, { "Idempotency-Key": grantRequestRef.current.key });
  }

  function submitSearch(event: { preventDefault(): void }) {
    event.preventDefault();
    void searchUsers();
  }

  return <section className="admin-user-section" aria-labelledby="complimentary-access-heading">
    <h2 id="complimentary-access-heading">Admin Granted — Permanent Free Access</h2>
    <p>Choose a user to inspect their current plan, active grant and full audit history. Complimentary grants remain separate from paid subscriptions and payments.</p>
    {setupRequired ? <div className="admin-user-unavailable" role="alert"><strong>Complimentary access setup is incomplete.</strong><p>This app's database does not expose the required schema. First confirm that DATABASE_URL points to the same local database whose migration status you checked. If it does, review schema permissions and migration history before applying any changes. No grant action was completed.</p></div> : <>
      <form className="admin-user-filters" onSubmit={submitSearch}>
        <label>Search by name, email or user ID<input value={userSearch} onChange={(event: ChangeEvent<HTMLInputElement>) => setUserSearch(event.currentTarget.value)} maxLength={100} /></label>
        <button type="submit" disabled={busy || !userSearch.trim()}>Search users</button>
      </form>
      {userResults.length > 0 && <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>User</th><th>Email</th><th>Verification</th><th>Select</th></tr></thead><tbody>{userResults.map((user) => <tr key={user.id}><td>{user.name || "Name unavailable"}<small>{user.id}</small></td><td>{user.email}</td><td>{user.emailVerified ? "Verified" : "Unverified"}</td><td><button type="button" disabled={busy} onClick={() => { setSelectedUser(user); setUserResults([]); void load(user.id); }}>Select user</button></td></tr>)}</tbody></table></div>}
      {selectedUser && <>
        <div className="admin-user-profile"><div><p className="admin-eyebrow">SELECTED USER</p><h3>{selectedUser.name || selectedUser.email}</h3><p>{selectedUser.email} · {selectedUser.id}</p></div><button type="button" disabled={busy} onClick={() => { setSelectedUser(null); setData(null); }}>Choose another user</button></div>
        <p className="admin-user-result-count">Current effective plan: <strong>{data ? data.currentPlan ?? "Unavailable" : busy ? "Loading…" : "Not loaded"}</strong></p>
        <div className="admin-user-filters">
          <label>Complimentary plan<select value={planId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setPlanId(event.currentTarget.value)}><option value="creator">Creator</option><option value="pro">Pro</option><option value="agency">Agency</option></select></label>
          <label>Admin reason / note<input value={note} onChange={(event: ChangeEvent<HTMLInputElement>) => setNote(event.currentTarget.value)} maxLength={500} /></label>
          <button type="button" disabled={busy} onClick={grantAccess}>Grant Free Access</button>
          <button type="button" disabled={busy} onClick={() => void load()}>Refresh access and history</button>
        </div>
        {data && <>
          <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Access</th><th>State</th><th>Grant date</th><th>Granting admin</th><th>Reason</th><th>Actions</th></tr></thead><tbody>
            {data.grants.length === 0 ? <tr><td colSpan={6}>No complimentary access grants for this user.</td></tr> : data.grants.map((grant) => <tr key={grant.id}><td>Admin Granted — Permanent Free Access · {grant.planId}</td><td><span className={`admin-state-label admin-access-${grant.status.toLowerCase()}`}>{grant.status === "ON_HOLD" ? "ON HOLD" : grant.status}</span></td><td>{new Date(grant.createdAt).toLocaleString()}</td><td>{grant.grantedByAdminId}</td><td>{grant.reason ?? "—"}</td><td>{grant.status === "ACTIVE" && <><button type="button" disabled={busy} onClick={() => transition(grant, "HOLD")}>Hold Free Access</button><button type="button" disabled={busy} onClick={() => transition(grant, "REVOKE")}>Revoke Free Access</button></>}{grant.status === "ON_HOLD" && <><button type="button" disabled={busy} onClick={() => transition(grant, "RESUME")}>Resume Free Access</button><button type="button" disabled={busy} onClick={() => transition(grant, "REVOKE")}>Revoke Free Access</button></>}</td></tr>)}
          </tbody></table></div>
          <h3>Access audit history</h3>{data.events.length === 0 ? <p>No audit events are recorded.</p> : <ol>{data.events.map((event) => <li key={event.id}><strong>{event.action}</strong>: {event.previousState ?? "—"} → {event.newState} · {new Date(event.occurredAt).toLocaleString()} · admin {event.actorAdminId}{event.note ? ` · ${event.note}` : ""}</li>)}</ol>}
        </>}
      </>}
    </>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">Working…</p>}
  </section>;
}
