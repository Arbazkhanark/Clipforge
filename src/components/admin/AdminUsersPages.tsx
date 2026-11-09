import type { ReactNode } from "react";
import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { parseAdminListQuery } from "../../server/admin/data-service.ts";
import type { AdminUserDetails } from "../../server/admin/data-repository.ts";

type SearchParams = Record<string, string | string[] | undefined>;
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const displayDate = (value: Date | null | undefined): string => value ? `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "Unavailable";
const amount = (paise: number, currency: string): string => `${currency} ${(paise / 100).toFixed(2)}`;

function Section({ title, children, hasData = true, empty = "No records are available." }: { title: string; children: ReactNode; hasData?: boolean; empty?: string }) {
  return <section className="admin-user-section"><h2>{title}</h2>{hasData ? children : <p className="admin-user-empty">{empty}</p>}</section>;
}

export async function renderAdminUsersPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const queryParams = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "verified", "from", "to"]) { const value = text(params[key]); if (value !== undefined) queryParams.set(key, value); }
  let queryError = "";
  let query;
  try { query = parseAdminListQuery(new URL(`http://admin.local/?${queryParams.toString()}`), { verified: true }); }
  catch { queryError = "Some filters were invalid. Showing the first page without filters."; query = parseAdminListQuery(new URL("http://admin.local/"), { verified: true }); }
  const runtime = getRuntime();
  const page = runtime.adminData ? await (await runtime.adminData()).listUsers(query) : null;
  const search = query.search ?? "";
  const verified = text(params["verified"]) ?? "";
  const hrefFor = (pageNumber: number) => { const next = new URLSearchParams(); if (search) next.set("search", search); if (verified) next.set("verified", verified); next.set("page", String(pageNumber)); return `/admin/users?${next.toString()}`; };
  return <AdminShell activeSection="users" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Users</h1><p>Read-only account profiles and recorded account activity.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <form className="admin-user-filters" method="get" action="/admin/users">
      <label>Search by name, email or ID<input name="search" type="search" maxLength={100} defaultValue={search} placeholder="Search users" /></label>
      <label>Email verification<select name="verified" defaultValue={verified}><option value="">All users</option><option value="true">Verified</option><option value="false">Unverified</option></select></label>
      <button type="submit">Search</button>
    </form>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    {!page ? <div className="admin-user-unavailable">User records are unavailable in this runtime. No sample users are shown.</div> : <>
      <p className="admin-user-result-count">{page.total} user{page.total === 1 ? "" : "s"} · Page {page.page}</p>
      {page.items.length === 0 ? <div className="admin-user-unavailable">No users match these filters.</div> : <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>User</th><th>Email</th><th>Verification</th><th>Created</th><th></th></tr></thead><tbody>{page.items.map((user) => <tr key={user.id}><td><strong>{user.name || "Name unavailable"}</strong><small>{user.id}</small></td><td>{user.email}</td><td>{user.emailVerified ? "Verified" : "Unverified"}</td><td>{displayDate(user.createdAt)}</td><td><a href={`/admin/users/${encodeURIComponent(user.id)}`}>View profile</a></td></tr>)}</tbody></table></div>}
      <nav className="admin-user-pagination" aria-label="User pages"><span>Showing up to {page.pageSize} per page</span><div><a aria-disabled={page.page <= 1} href={page.page <= 1 ? undefined : hrefFor(page.page - 1)}>Previous</a><a aria-disabled={page.page * page.pageSize >= page.total} href={page.page * page.pageSize >= page.total ? undefined : hrefFor(page.page + 1)}>Next</a></div></nav>
    </>}
  </AdminShell>;
}

export async function renderAdminUserDetailsPage(userId: string) {
  await requireAdminPage();
  const runtime = getRuntime();
  const detail = runtime.adminData ? await (await runtime.adminData()).getUserDetails(userId) : null;
  return <AdminShell activeSection="users" dataStatus={detail ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / USERS</p><h1>{detail?.profile.name || "User details"}</h1><p>Read-only profile, billing, connected accounts and activity history.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <a className="admin-user-back" href="/admin/users">← Back to users</a>
    {!runtime.adminData ? <div className="admin-user-unavailable">User detail data is unavailable in this runtime. No sample data is shown.</div>
      : !detail ? <div className="admin-user-unavailable">This user record is unavailable or does not exist.</div>
      : <UserDetail detail={detail} />}
  </AdminShell>;
}

function UserDetail({ detail }: { detail: AdminUserDetails }) {
  const profile = detail.profile;
  return <div className="admin-user-detail">
    <section className="admin-user-profile"><div><p className="admin-eyebrow">ACCOUNT PROFILE</p><h2>{profile.name || "Name unavailable"}</h2><p>{profile.email}</p></div><dl><div><dt>User ID</dt><dd>{profile.id}</dd></div><div><dt>Role</dt><dd>{profile.role}</dd></div><div><dt>Email status</dt><dd>{profile.emailVerified ? "Verified" : "Unverified"}</dd></div><div><dt>Account created</dt><dd>{displayDate(profile.createdAt)}</dd></div></dl></section>
    <div className="admin-user-detail-grid">
      <Section title="Current subscription" hasData={Boolean(detail.subscription)} empty="No subscription record is stored.">{detail.subscription && <dl className="admin-user-facts"><div><dt>Plan / interval</dt><dd>{detail.subscription.planId} · {detail.subscription.interval}</dd></div><div><dt>Status</dt><dd>{detail.subscription.status}</dd></div><div><dt>Current period ends</dt><dd>{displayDate(detail.subscription.currentPeriodEnd)}</dd></div><div><dt>Cancellation requested</dt><dd>{detail.subscription.cancelAtPeriodEnd || detail.subscription.cancellationRequestedAt ? "Yes" : "No recorded request"}</dd></div></dl>}</Section>
      <Section title="Subscription checkout history" hasData={detail.subscriptionIntents.length > 0} empty="No recurring subscription intents are stored."><ul className="admin-user-list">{detail.subscriptionIntents.map((item) => <li key={item.id}><strong>{item.planId} · {item.interval}</strong><span>{item.status} · {amount(item.amountPaise, item.currency)} · {displayDate(item.createdAt)}</span></li>)}</ul></Section>
      <Section title="Manual payment access" hasData={detail.manualPaymentIntents.length + detail.manualAccessPeriods.length > 0} empty="No manual payment intents or access periods are stored."><ul className="admin-user-list">{detail.manualPaymentIntents.map((item) => <li key={item.id}><strong>{item.planId} · {item.interval}</strong><span>{item.status} · {amount(item.amountPaise, item.currency)} · access {displayDate(item.accessStartsAt)} – {displayDate(item.accessEndsAt)}</span></li>)}{detail.manualAccessPeriods.map((item) => <li key={item.id}><strong>{item.planId} verified access period</strong><span>{displayDate(item.startsAt)} – {displayDate(item.expiresAt)}</span></li>)}</ul></Section>
      <Section title="Payment history" hasData={detail.payments.length > 0} empty="No payment records are stored."><ul className="admin-user-list">{detail.payments.map((item) => <li key={item.id}><strong>{amount(item.amountPaise, item.currency)} · {item.status}</strong><span>Provider payment ID: {item.providerPaymentId} · {displayDate(item.createdAt)}</span></li>)}</ul></Section>
      <Section title="Connected accounts" hasData={detail.socialAccounts.length > 0} empty="No connected social accounts are stored."><ul className="admin-user-list">{detail.socialAccounts.map((item) => <li key={item.id}><strong>{item.platform} · {item.username || "Username unavailable"}</strong><span>{item.accountType || "Account type unknown"} · stored status: {item.status} · token expiry: {displayDate(item.tokenExpiresAt)}</span><small>Granted scopes: {item.grantedScopes || "Unavailable"}</small></li>)}</ul></Section>
      <Section title="Publishing cycles" hasData={detail.cycles.length > 0} empty="No cycles are stored."><ul className="admin-user-list">{detail.cycles.map((item) => <li key={item.id}><strong>{item.name} · {item.status}</strong><span>{item.itemCount} reels · {item.scheduledItemCount} with scheduled times · {item.timezone}</span></li>)}</ul></Section>
      <Section title="Reels and publishing attempts" hasData={detail.reels.length + detail.publishingAttempts.length > 0} empty="No reel or publishing attempt history is stored."><ul className="admin-user-list">{detail.reels.map((item) => <li key={`reel-${item.id}`}><strong>Reel {item.position} · {item.status}</strong><span>Planned: {displayDate(item.scheduledFor)} · stored publication time: {displayDate(item.publishedAt)}</span></li>)}{detail.publishingAttempts.map((item) => <li key={`attempt-${item.id}`}><strong>Attempt {item.attemptNumber} · {item.stage} · {item.outcome}</strong><span>{item.errorCategory ? `Safe error category: ${item.errorCategory} · ` : ""}{displayDate(item.createdAt)}</span></li>)}</ul></Section>
      <Section title="User activity and audit history" hasData={detail.usageActivity.length + detail.auditHistory.length > 0} empty="No usage or related audit records are stored."><ul className="admin-user-list">{detail.usageActivity.map((item) => <li key={`usage-${item.id}`}><strong>{item.kind} · {item.amount}</strong><span>Period start: {displayDate(item.periodStart)} · recorded: {displayDate(item.createdAt)}</span></li>)}{detail.auditHistory.map((item) => <li key={`audit-${item.id}`}><strong>{item.action}</strong><span>{item.entityType} · {item.entityId} · {displayDate(item.createdAt)}</span></li>)}</ul></Section>
    </div>
    {Object.entries(detail.historyTruncated).some(([, truncated]) => truncated) && <p className="admin-user-truncation">Some history sections are limited to the latest 50 records: {Object.entries(detail.historyTruncated).filter(([, truncated]) => truncated).map(([section]) => section).join(", ")}.</p>}
    <p className="admin-user-footnote">Stored records only. A recorded publishing state does not independently verify Instagram’s live state. Session secrets, tokens and raw provider details are never shown.</p>
  </div>;
}
