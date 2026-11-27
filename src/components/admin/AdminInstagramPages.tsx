import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { ADMIN_FILTERS, parseAdminListQuery } from "../../server/admin/data-service.ts";
import type { AdminInstagramDetails } from "../../server/admin/data-repository.ts";

type SearchParams = Record<string, string | string[] | undefined>;
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const date = (value: Date | null | undefined): string => value ? `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "Unavailable";
const human = (value: string): string => value.replaceAll("_", " ");

export async function renderAdminInstagramAccountsPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const input = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "status"]) { const value = text(params[key]); if (value !== undefined) input.set(key, value); }
  let queryError = "";
  let query;
  try { query = parseAdminListQuery(new URL(`http://admin.local/?${input.toString()}`), { status: ADMIN_FILTERS.accountStatuses }); }
  catch { queryError = "Some filters were invalid. Showing the first page without filters."; query = parseAdminListQuery(new URL("http://admin.local/"), { status: ADMIN_FILTERS.accountStatuses }); }
  const runtime = getRuntime();
  const page = runtime.adminData ? await (await runtime.adminData()).listSocialAccounts(query) : null;
  const search = query.search ?? ""; const status = query.status ?? "";
  const pageHref = (nextPage: number) => { const next = new URLSearchParams(); if (search) next.set("search", search); if (status) next.set("status", status); next.set("page", String(nextPage)); return `/admin/instagram?${next.toString()}`; };
  return <AdminShell activeSection="instagram" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Instagram accounts</h1><p>Stored account connection and publishing records. Meta is not contacted.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <form className="admin-user-filters" method="get" action="/admin/instagram">
      <label>Search username, account ID or owner ID<input type="search" name="search" maxLength={100} defaultValue={search} placeholder="Search Instagram accounts" /></label>
      <label>Stored connection status<select name="status" defaultValue={status}><option value="">All stored statuses</option>{[...ADMIN_FILTERS.accountStatuses].map((value) => <option value={value} key={value}>{human(value)}</option>)}</select></label>
      <button type="submit">Apply filters</button>
    </form>
    <p className="admin-user-footnote">Permission and expiry labels are calculated from stored fields only. Account restrictions and current Meta status are unavailable without a provider check.</p>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    {!page ? <div className="admin-user-unavailable">Instagram account records are unavailable in this runtime. No sample accounts are shown.</div>
      : page.items.length === 0 ? <div className="admin-user-unavailable">No Instagram accounts match these filters.</div>
      : <>
        <p className="admin-user-result-count">{page.total} account{page.total === 1 ? "" : "s"} · Page {page.page}</p>
        <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Account / owner</th><th>Account type</th><th>Stored status</th><th>Permissions</th><th>Token expiry</th><th></th></tr></thead><tbody>{page.items.map((account) => <tr key={account.id}><td><strong>@{account.username || "username unavailable"}</strong><small>{account.ownerName || "Owner name unavailable"} · {account.ownerEmail}</small></td><td>{account.accountType || "Unknown / unavailable"}</td><td><span className="admin-state-label">{human(account.storedConnectionState)}</span><small>Stored: {human(account.status)}</small></td><td><span className="admin-state-label">{human(account.permissionStatus)}</span>{account.missingRequiredScopes.length > 0 && <small>Missing: {account.missingRequiredScopes.join(", ")}</small>}</td><td>{date(account.tokenExpiresAt)}<small>Stored token: {account.tokenStored ? "present" : "not present"}</small></td><td><a href={`/admin/instagram/${encodeURIComponent(account.id)}`}>View account</a></td></tr>)}</tbody></table></div>
        <nav className="admin-user-pagination" aria-label="Instagram account pages"><span>Showing up to {page.pageSize} per page</span><div><a aria-disabled={page.page <= 1} href={page.page <= 1 ? undefined : pageHref(page.page - 1)}>Previous</a><a aria-disabled={page.page * page.pageSize >= page.total} href={page.page * page.pageSize >= page.total ? undefined : pageHref(page.page + 1)}>Next</a></div></nav>
      </>}
  </AdminShell>;
}

export async function renderAdminInstagramAccountPage(accountId: string) {
  await requireAdminPage();
  const runtime = getRuntime();
  const detail = runtime.adminData ? await (await runtime.adminData()).getInstagramAccountDetails(accountId) : null;
  return <AdminShell activeSection="instagram" dataStatus={detail ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / INSTAGRAM</p><h1>@{detail?.account.username || "Account details"}</h1><p>Stored account, permission and publishing history.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <a className="admin-user-back" href="/admin/instagram">← Back to Instagram accounts</a>
    {!runtime.adminData ? <div className="admin-user-unavailable">Instagram account data is unavailable in this runtime. No sample data is shown.</div>
      : !detail ? <div className="admin-user-unavailable">This Instagram account is unavailable or does not exist.</div>
      : <InstagramAccountDetail detail={detail} />}
  </AdminShell>;
}

function InstagramAccountDetail({ detail }: { detail: AdminInstagramDetails }) {
  const { account, owner } = detail;
  return <div className="admin-instagram-detail">
    <div className="admin-instagram-notice"><strong>Stored data only</strong><span>No Meta API request was made. Current account restrictions and live permission validity are not verified.</span></div>
    <section className="admin-user-profile"><div><p className="admin-eyebrow">ACCOUNT PROFILE</p><h2>@{account.username || "Username unavailable"}</h2><p>{account.accountType || "Account type unavailable"}</p></div><dl><div><dt>Owner</dt><dd>{owner ? `${owner.name || "Name unavailable"} · ${owner.email}` : "Owner record unavailable"}</dd></div><div><dt>Stored connection status</dt><dd>{human(detail.storedConnectionState)} · raw status: {human(account.storedStatus)}</dd></div><div><dt>Token expiry</dt><dd>{date(account.tokenExpiresAt)}</dd></div><div><dt>Encrypted token availability</dt><dd>{detail.tokenStored ? "Ciphertext is stored" : "No token ciphertext recorded"}</dd></div><div><dt>Last account update</dt><dd>Unavailable — no account updated timestamp is stored.</dd></div><div><dt>Restrictions</dt><dd>Unavailable — restriction state is not stored.</dd></div></dl></section>
    <div className="admin-instagram-summary-grid">
      <section className="admin-user-section"><h2>Stored permissions</h2><p><span className="admin-state-label">{human(detail.permissions.status)}</span></p><p>Required scopes: {detail.permissions.grantedRequiredScopes.length ? detail.permissions.grantedRequiredScopes.join(", ") : "None verified in stored data"}</p>{detail.permissions.missingRequiredScopes.length > 0 && <p>Missing required scopes: {detail.permissions.missingRequiredScopes.join(", ")}</p>}<small>Unexpected and malformed scope values are not echoed.</small></section>
      <section className="admin-user-section"><h2>Stored eligibility assessment</h2><p>{detail.storedEligibility.eligibleFromStoredFields ? "Stored fields meet the current local eligibility checks." : `Not eligible from stored fields: ${detail.storedEligibility.reason ? human(detail.storedEligibility.reason) : "unknown"}.`}</p><p>Current Meta status: not verified.</p></section>
    </div>
    <section className="admin-user-section"><h2>Related campaigns</h2>{detail.campaigns.length === 0 ? <p className="admin-user-empty">No campaigns are stored for this account.</p> : <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Campaign</th><th>Stored status</th><th>Timezone</th><th>Updated</th></tr></thead><tbody>{detail.campaigns.map((campaign) => <tr key={campaign.id}><td><a href={`/admin/campaigns/${encodeURIComponent(campaign.id)}`}>{campaign.name}</a><small>{campaign.id}</small></td><td>{campaign.deletedAt ? "Deleted" : human(campaign.status)}{campaign.deletedAt && <small>Deleted {date(campaign.deletedAt)}</small>}</td><td>{campaign.timezone}</td><td>{date(campaign.updatedAt)}</td></tr>)}</tbody></table></div>}</section>
    <section className="admin-user-section"><h2>Publishing activity</h2>{detail.publishingActivity.length === 0 ? <p className="admin-user-empty">No publishing attempts are stored for this account.</p> : <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Campaign / Reel</th><th>Attempt</th><th>Stage</th><th>Outcome</th><th>Item status</th><th>Safe error category</th><th>Started / finished</th></tr></thead><tbody>{detail.publishingActivity.map((job) => <tr key={job.id}><td>{job.campaignName || "Campaign unavailable"}{job.campaignDeletedAt && <small>Deleted {date(job.campaignDeletedAt)}</small>}<small>{job.cycleItemId}</small></td><td>#{job.attemptNumber}</td><td>{human(job.stage)}</td><td>{human(job.outcome)}</td><td>{job.itemStatus ? human(job.itemStatus) : "Unavailable"}</td><td>{job.errorCategory || "None recorded"}</td><td>{date(job.startedAt)}<small>{date(job.finishedAt)}</small></td></tr>)}</tbody></table></div>}</section>
    {(detail.historyTruncated.campaigns || detail.historyTruncated.publishingActivity) && <p className="admin-user-truncation">History is limited to 50 campaigns and 100 publishing attempts. Older records may be omitted.</p>}
    <p className="admin-user-footnote">Access tokens and raw provider responses are never displayed. Publishing activity shows stored ClipForge records, not a live Meta status check.</p>
  </div>;
}
