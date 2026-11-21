import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { ADMIN_FILTERS, parseAdminListQuery } from "../../server/admin/data-service.ts";
import type { AdminCycleDetails } from "../../server/admin/data-repository.ts";
import { AdminCycleStatusControl } from "./AdminCycleStatusControl.tsx";

type SearchParams = Record<string, string | string[] | undefined>;
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const date = (value: Date | null | undefined): string => value ? `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "Not recorded";
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const human = (value: string): string => value.replaceAll("_", " ");

export async function renderAdminCampaignsPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const queryParams = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "status", "from", "to"]) { const value = text(params[key]); if (value !== undefined) queryParams.set(key, value); }
  let queryError = "";
  let query;
  try { query = parseAdminListQuery(new URL(`http://admin.local/?${queryParams.toString()}`), { status: ADMIN_FILTERS.cycleStatuses }); }
  catch { queryError = "Some filters were invalid. Showing the first page without filters."; query = parseAdminListQuery(new URL("http://admin.local/"), { status: ADMIN_FILTERS.cycleStatuses }); }
  const runtime = getRuntime();
  const page = runtime.adminData ? await (await runtime.adminData()).listCycles(query) : null;
  const search = query.search ?? ""; const status = query.status ?? "";
  const pageHref = (nextPage: number) => { const params = new URLSearchParams(); if (search) params.set("search", search); if (status) params.set("status", status); params.set("page", String(nextPage)); return `/admin/campaigns?${params.toString()}`; };
  return <AdminShell activeSection="campaigns" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Campaigns</h1><p>Read-only publishing cycles and stored progress across accounts.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <form className="admin-user-filters" method="get" action="/admin/campaigns">
      <label>Search campaign or owner ID<input type="search" name="search" maxLength={100} defaultValue={search} placeholder="Campaign name, cycle ID or owner ID" /></label>
      <label>Status<select name="status" defaultValue={status}><option value="">All cycle statuses</option>{[...ADMIN_FILTERS.cycleStatuses].map((item) => <option value={item} key={item}>{human(item)}</option>)}</select></label>
      <button type="submit">Apply filters</button>
    </form>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    {!page ? <div className="admin-user-unavailable">Campaign records are unavailable in this runtime. No sample campaigns are shown.</div>
      : page.items.length === 0 ? <div className="admin-user-unavailable">No campaigns match these filters.</div>
      : <>
        <p className="admin-user-result-count">{page.total} campaign{page.total === 1 ? "" : "s"} · Page {page.page}</p>
        <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Campaign</th><th>Owner</th><th>Status</th><th>Reels</th><th>Updated</th><th></th></tr></thead><tbody>{page.items.map((cycle) => <tr key={cycle.id}><td><strong>{cycle.name}</strong><small>{cycle.id}</small></td><td>{cycle.ownerName || "Name unavailable"}<small>{cycle.ownerEmail}</small></td><td><span className="admin-state-label">{human(cycle.status)}</span></td><td>{cycle.itemCount} total · {cycle.scheduledItemCount} scheduled</td><td>{date(cycle.updatedAt)}</td><td><a href={`/admin/campaigns/${encodeURIComponent(cycle.id)}`}>View details</a></td></tr>)}</tbody></table></div>
        <nav className="admin-user-pagination" aria-label="Campaign pages"><span>Showing up to {page.pageSize} per page</span><div><a aria-disabled={page.page <= 1} href={page.page <= 1 ? undefined : pageHref(page.page - 1)}>Previous</a><a aria-disabled={page.page * page.pageSize >= page.total} href={page.page * page.pageSize >= page.total ? undefined : pageHref(page.page + 1)}>Next</a></div></nav>
      </>}
  </AdminShell>;
}

export async function renderAdminCampaignDetailsPage(cycleId: string) {
  await requireAdminPage();
  const runtime = getRuntime();
  const detail = runtime.adminData ? await (await runtime.adminData()).getCycleDetails(cycleId) : null;
  return <AdminShell activeSection="campaigns" dataStatus={detail ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / CAMPAIGNS</p><h1>{detail?.cycle.name || "Campaign details"}</h1><p>Stored cycle configuration, reel states and publishing attempt history.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <a className="admin-user-back" href="/admin/campaigns">← Back to campaigns</a>
    {!runtime.adminData ? <div className="admin-user-unavailable">Campaign detail data is unavailable in this runtime. No sample data is shown.</div>
      : !detail ? <div className="admin-user-unavailable">This campaign record is unavailable or does not exist.</div>
      : <><AdminCycleStatusControl cycleId={detail.cycle.id} initialStatus={detail.cycle.status} /><CampaignDetail detail={detail} /></>}
  </AdminShell>;
}

function CampaignDetail({ detail }: { detail: AdminCycleDetails }) {
  const { cycle, owner, instagramAccount } = detail;
  return <div className="admin-campaign-detail">
    <section className="admin-user-profile"><div><p className="admin-eyebrow">CYCLE</p><h2>{cycle.name}</h2><p>{cycle.id}</p></div><dl><div><dt>Owner</dt><dd>{owner ? `${owner.name || "Name unavailable"} · ${owner.email}` : "Owner record unavailable"}</dd></div><div><dt>Status</dt><dd>{human(cycle.status)}</dd></div><div><dt>Created / updated</dt><dd>{date(cycle.createdAt)}<br />{date(cycle.updatedAt)}</dd></div><div><dt>Review confirmed</dt><dd>{cycle.finalReviewConfirmed ? "Yes" : "No"}</dd></div></dl></section>
    <div className="admin-campaign-meta-grid">
      <section className="admin-user-section"><h2>Stored schedule and configuration</h2><dl className="admin-user-facts"><div><dt>Timezone</dt><dd>{cycle.timezone || "Unavailable"}</dd></div><div><dt>Order / repeat</dt><dd>{human(cycle.orderMode)} / {human(cycle.repeatBehavior)}</dd></div><div><dt>Configuration</dt><dd>{cycle.scheduleAvailable ? "Validated stored schedule" : "Unavailable or invalid stored schedule"}</dd></div></dl>
        {cycle.schedule && <dl className="admin-user-facts admin-schedule-facts"><div><dt>Start date</dt><dd>{cycle.schedule.startDate}</dd></div><div><dt>Posting window</dt><dd>{cycle.schedule.windowStart}–{cycle.schedule.windowEnd} ({cycle.schedule.timeZone})</dd></div><div><dt>Interval</dt><dd>Every {cycle.schedule.intervalMinutes} minutes · {cycle.schedule.postsPerInterval} per interval</dd></div><div><dt>Weekdays</dt><dd>{cycle.schedule.daysOfWeek.map((day) => dayNames[day] ?? "?").join(", ") || "Unavailable"}</dd></div><div><dt>Daily maximum</dt><dd>{cycle.schedule.dailyMax ?? "No limit stored"}</dd></div><div><dt>End date</dt><dd>{cycle.schedule.endDate ?? "No end date"}</dd></div></dl>}
      </section>
      <section className="admin-user-section"><h2>Instagram account association</h2><p><strong>Association:</strong> {human(detail.accountAssociation)}</p>{instagramAccount ? <dl className="admin-user-facts"><div><dt>Username</dt><dd>{instagramAccount.username || "Unavailable"}</dd></div><div><dt>Account type</dt><dd>{instagramAccount.accountType || "Unknown"}</dd></div><div><dt>Stored account status</dt><dd>{human(instagramAccount.storedStatus)}</dd></div><div><dt>Token expiry</dt><dd>{date(instagramAccount.tokenExpiresAt)}</dd></div><div><dt>Stored granted scopes</dt><dd>{instagramAccount.scopes || "Unavailable"}</dd></div></dl> : <p className="admin-user-empty">No verified Instagram account summary is available. No live Meta status was checked.</p>}</section>
    </div>
    <section className="admin-user-section admin-campaign-reels"><h2>Reels / cycle items</h2>{detail.items.length === 0 ? <p className="admin-user-empty">No cycle items are stored.</p> : <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Sequence / source</th><th>Original media</th><th>Schedule</th><th>Stored publishing state</th><th>Selected render</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>#{item.position}</strong><small>{human(item.sourceKind)} · {item.id}</small></td><td>{item.originalMedia ? <>{item.originalMedia.filename}<small>{item.originalMedia.kind} · {human(item.originalMedia.status)}{!item.originalMedia.metadataValidated ? " · metadata not validated" : ""}</small></> : <span>Original media unavailable</span>}</td><td>{item.scheduleState === "scheduled" ? `Scheduled · ${date(item.scheduledFor)}` : "Not scheduled"}</td><td><span className="admin-state-label">{item.publishingState === "published_recorded" ? "Published (recorded)" : human(item.publishingState)}</span>{item.latestAttemptNumber !== null && <small>Latest attempt #{item.latestAttemptNumber}</small>}</td><td>{item.selectedRenderStatus === "available" ? `Selected output · ${item.selectedRenderOutputId}` : item.selectedRenderStatus === "not_selected" ? "No output selected" : "Selected output missing or mismatched"}</td></tr>)}</tbody></table></div>}</section>
    <section className="admin-user-section admin-campaign-attempts"><h2>Publishing attempts</h2>{detail.publishingAttempts.length === 0 ? <p className="admin-user-empty">No publishing attempts are stored. A scheduled time alone is not a queued or attempted publish.</p> : <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Reel</th><th>Attempt</th><th>Stage</th><th>Outcome</th><th>Safe error category</th><th>Started / finished</th></tr></thead><tbody>{detail.publishingAttempts.map((attempt) => <tr key={attempt.id}><td>{attempt.cycleItemId}</td><td>#{attempt.attemptNumber}</td><td>{human(attempt.stage)}</td><td>{human(attempt.outcome)}</td><td>{attempt.errorCategory || "None recorded"}</td><td>{date(attempt.startedAt)}<small>{date(attempt.finishedAt)}</small></td></tr>)}</tbody></table></div>}</section>
    {(detail.historyTruncated.items || detail.historyTruncated.publishingAttempts) && <p className="admin-user-truncation">History is limited to 100 records. Truncated: {[detail.historyTruncated.items ? "reels" : "", detail.historyTruncated.publishingAttempts ? "publishing attempts" : ""].filter(Boolean).join(", ")}.</p>}
    <p className="admin-user-footnote">States reflect stored ClipForge records only. “Published (recorded)” is not an independent live Instagram check. No worker locks, tokens, captions, provider payloads or idempotency keys are shown.</p>
  </div>;
}
