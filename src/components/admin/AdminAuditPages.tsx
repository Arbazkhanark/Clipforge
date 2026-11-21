import type { AdminAuditDetails, AdminAuditRow, AdminPage } from "../../server/admin/data-repository.ts";
import { parseAdminAuditQuery } from "../../server/admin/data-service.ts";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { AdminShell } from "./AdminShell.tsx";

type SearchParams = Record<string, string | string[] | undefined>;
const param = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] ?? "" : value ?? "";
const displayDate = (value: Date): string => `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
const actorLabel = (kind: AdminAuditRow["actorKind"]): string => kind === "admin_action_namespace" ? "Admin action namespace · historical role unavailable" : kind === "system_or_actor_unavailable" ? "System or actor unavailable" : "Actor recorded · category unavailable";

export async function renderAdminAuditPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const rawQuery = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "actorId", "action", "targetType", "targetId", "from", "to"] as const) {
    const value = param(params[key]); if (value) rawQuery.set(key, value);
  }
  let query = parseAdminAuditQuery(new URL("http://admin.local/"));
  let queryError = "";
  try { query = parseAdminAuditQuery(new URL(`http://admin.local/?${rawQuery.toString()}`)); }
  catch { queryError = "Some filters were invalid. Showing the unfiltered first page."; query = parseAdminAuditQuery(new URL("http://admin.local/")); }
  const runtime = getRuntime();
  const page: AdminPage<AdminAuditRow> | null = runtime.adminData ? await (await runtime.adminData()).listAudit(query) : null;
  return <AdminShell activeSection="audit" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / AUDIT</p><h1>Audit Logs</h1><p>Read-only event records using the fields the current schema stores.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <form className="admin-user-filters admin-audit-filters" method="get" action="/admin/audit">
      <label>Search all stored fields<input name="search" defaultValue={param(params.search)} maxLength={100} placeholder="Action, actor ID or target" /></label>
      <label>Actor ID<input name="actorId" defaultValue={param(params.actorId)} maxLength={128} /></label>
      <label>Action<input name="action" defaultValue={param(params.action)} maxLength={128} /></label>
      <label>Target type<input name="targetType" defaultValue={param(params.targetType)} maxLength={128} /></label>
      <label>Target ID<input name="targetId" defaultValue={param(params.targetId)} maxLength={128} /></label>
      <label>From<input type="date" name="from" defaultValue={param(params.from)} /></label>
      <label>To<input type="date" name="to" defaultValue={param(params.to)} /></label>
      <button type="submit">Apply filters</button><a className="admin-audit-clear" href="/admin/audit">Clear</a>
    </form>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    <div className="admin-audit-disclosure"><strong>Stored fields only.</strong> Raw metadata is withheld. A small allowlist of account and cycle state-change events shows only previous/new state and admin reason. Historical actor roles and outcomes for older records are unavailable.</div>
    {!page ? <div className="admin-user-unavailable">Audit data is unavailable in this runtime. No sample events are shown.</div> : <AuditTable page={page} query={rawQuery} />}
  </AdminShell>;
}

function AuditTable({ page, query }: { page: AdminPage<AdminAuditRow>; query: URLSearchParams }) {
  const pageHref = (nextPage: number) => { const next = new URLSearchParams(query); next.set("page", String(nextPage)); return `/admin/audit?${next.toString()}`; };
  return <>
    {page.items.length === 0 ? <div className="admin-user-empty">No audit events match these filters.</div> : <div className="admin-user-table-wrap admin-audit-table-wrap"><table className="admin-user-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th><th /></tr></thead><tbody>{page.items.map((event) => <tr key={event.id}><td>{displayDate(event.createdAt)}</td><td><span>{actorLabel(event.actorKind)}</span><small>{event.actorId ?? "No actor ID stored"}</small></td><td>{event.action}{event.safeChange && <small>{event.safeChange.previousState} → {event.safeChange.newState}{event.safeChange.reason ? ` · Reason: ${event.safeChange.reason}` : ""}</small>}</td><td><span>{event.entityType}</span><small>{event.entityId}</small></td><td>{event.outcome === "success" ? "Success" : "Not stored"}</td><td><a href={`/admin/audit/${encodeURIComponent(event.id)}`}>View details</a></td></tr>)}</tbody></table></div>}
    <nav className="admin-user-pagination" aria-label="Audit log pages"><span>{page.total} stored events · showing up to {page.pageSize} per page</span><div><a aria-disabled={page.page <= 1} href={page.page <= 1 ? undefined : pageHref(page.page - 1)}>Previous</a><a aria-disabled={page.page * page.pageSize >= page.total} href={page.page * page.pageSize >= page.total ? undefined : pageHref(page.page + 1)}>Next</a></div></nav>
  </>;
}

export async function renderAdminAuditDetailsPage(auditId: string) {
  await requireAdminPage();
  const runtime = getRuntime();
  const detail: AdminAuditDetails | null = runtime.adminData ? await (await runtime.adminData()).getAuditDetails(auditId) : null;
  return <AdminShell activeSection="audit" dataStatus={detail ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / AUDIT</p><h1>Audit event</h1><p>Safe stored event fields. Only allowlisted state-change details are displayed.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <a className="admin-user-back" href="/admin/audit">← Back to audit logs</a>
    {!runtime.adminData ? <div className="admin-user-unavailable">Audit data is unavailable in this runtime.</div> : !detail ? <div className="admin-user-unavailable">This audit record is unavailable or does not exist.</div> : <AuditDetails detail={detail} />}
  </AdminShell>;
}

function AuditDetails({ detail }: { detail: AdminAuditDetails }) {
  const event = detail.event;
  return <div className="admin-audit-detail">
    <section className="admin-user-profile"><div><p className="admin-eyebrow">RECORDED EVENT</p><h2>{event.action}</h2><p>{event.id}</p></div><dl><div><dt>Time</dt><dd>{displayDate(event.createdAt)}</dd></div><div><dt>Actor classification</dt><dd>{actorLabel(event.actorKind)}</dd></div><div><dt>Actor ID</dt><dd>{event.actorId ?? "Not stored"}</dd></div><div><dt>Target</dt><dd>{event.entityType} · {event.entityId}</dd></div><div><dt>Outcome / status</dt><dd>{detail.outcomeStatus === "success" ? "Success (transactionally recorded)" : "Not stored in this event"}</dd></div></dl></section>
    {detail.safeChange && <section className="admin-user-section"><h2>State change</h2><dl className="admin-user-facts"><div><dt>Previous state</dt><dd>{detail.safeChange.previousState}</dd></div><div><dt>New state</dt><dd>{detail.safeChange.newState}</dd></div><div><dt>Admin reason</dt><dd>{detail.safeChange.reason || "No reason provided"}</dd></div></dl></section>}
    <section className="admin-audit-disclosure"><strong>Metadata withheld except for allowlisted state changes.</strong> Historical actor roles and outcomes for older records are unavailable.</section>
  </div>;
}
