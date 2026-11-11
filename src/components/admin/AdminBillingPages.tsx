import { AdminShell } from "./AdminShell.tsx";
import { getRuntime } from "../../server/runtime.ts";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { ADMIN_FILTERS, parseAdminListQuery } from "../../server/admin/data-service.ts";
import type { AdminPaymentDetails, AdminPaymentRow, AdminSubscriptionRow, AdminManualAccessRow, AdminBillingIntentRow, AdminPage } from "../../server/admin/data-repository.ts";

type SearchParams = Record<string, string | string[] | undefined>;
type View = "payments" | "subscriptions" | "manual-access" | "recurring-intents" | "manual-payment-intents";
const text = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value;
const human = (value: string): string => value.replaceAll("_", " ");
const date = (value: Date | null | undefined): string => value ? `${value.toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "Not recorded";
const amount = (paise: number, currency: string): string => `${currency} ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function renderAdminBillingPage(searchParams: Promise<SearchParams>) {
  await requireAdminPage();
  const params = await searchParams;
  const rawView = text(params.view);
  const view: View = rawView === "subscriptions" || rawView === "manual-access" || rawView === "recurring-intents" || rawView === "manual-payment-intents" ? rawView : "payments";
  const input = new URLSearchParams();
  for (const key of ["page", "pageSize", "search", "status", "from", "to"]) { const value = text(params[key]); if (value !== undefined) input.set(key, value); }
  let queryError = "";
  let query;
  try {
    const filterOptions = view === "payments" ? { status: ADMIN_FILTERS.paymentStatuses }
      : view === "subscriptions" ? { status: ADMIN_FILTERS.subscriptionStatuses }
      : view === "recurring-intents" ? { status: ADMIN_FILTERS.recurringIntentStatuses }
      : view === "manual-payment-intents" ? { status: ADMIN_FILTERS.manualIntentStatuses }
      : {};
    query = parseAdminListQuery(new URL(`http://admin.local/?${input.toString()}`), filterOptions);
  } catch {
    queryError = "Some filters were invalid. Showing the first page without filters.";
    query = parseAdminListQuery(new URL("http://admin.local/"));
  }
  const runtime = getRuntime();
  const service = runtime.adminData ? await runtime.adminData() : null;
  const page: AdminPage<AdminPaymentRow | AdminSubscriptionRow | AdminManualAccessRow | AdminBillingIntentRow> | null = service
    ? view === "payments" ? await service.listPayments(query)
      : view === "subscriptions" ? await service.listSubscriptions(query)
      : view === "manual-access" ? await service.listManualAccess(query)
      : view === "recurring-intents" ? await service.listRecurringIntents(query)
      : await service.listManualPaymentIntents(query)
    : null;
  const search = query.search ?? ""; const status = query.status ?? "";
  const href = (nextView: View) => `/admin/billing?view=${nextView}`;
  const pageHref = (nextPage: number) => {
    const next = new URLSearchParams({ view });
    if (search) next.set("search", search);
    if (status) next.set("status", status);
    if (query.from) next.set("from", query.from.toISOString());
    if (query.to) next.set("to", query.to.toISOString());
    next.set("page", String(nextPage));
    return `/admin/billing?${next.toString()}`;
  };
  return <AdminShell activeSection="billing" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Billing &amp; payments</h1><p>Stored payment records, current subscription rows, and separately recorded manual access periods.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <div className="admin-billing-notice"><strong>Stored records only</strong><span>These records do not by themselves establish current entitlement. No provider is contacted. Fees, taxes, refunds and payment method are unavailable unless explicitly stored.</span></div>
    <nav className="admin-billing-tabs" aria-label="Billing records">
      <a aria-current={view === "payments" ? "page" : undefined} href={href("payments")}>Payments</a>
      <a aria-current={view === "subscriptions" ? "page" : undefined} href={href("subscriptions")}>Subscription records</a>
      <a aria-current={view === "recurring-intents" ? "page" : undefined} href={href("recurring-intents")}>Recurring checkout intents</a>
      <a aria-current={view === "manual-payment-intents" ? "page" : undefined} href={href("manual-payment-intents")}>Manual payment intents</a>
      <a aria-current={view === "manual-access" ? "page" : undefined} href={href("manual-access")}>Manual access periods</a>
    </nav>
    {view === "manual-access" && <p className="admin-user-footnote">Manual access grants are one-time paid periods and do not auto-renew. They are listed separately from recurring Subscription records.</p>}
    {(view === "recurring-intents" || view === "manual-payment-intents") && <p className="admin-user-footnote">Checkout intents are stored attempts, not captured payments or proof of entitlement. Status is shown as stored and is not verified live with Razorpay.</p>}
    <form className="admin-user-filters" method="get" action="/admin/billing">
      <input type="hidden" name="view" value={view} />
      <label>Search {view === "payments" ? "payment, owner or provider reference" : "record, owner or plan"}<input type="search" name="search" maxLength={100} defaultValue={search} placeholder="Search stored records" /></label>
      {view !== "manual-access" && <label>Status<select name="status" defaultValue={status}><option value="">All stored statuses</option>{(view === "payments" ? [...ADMIN_FILTERS.paymentStatuses] : view === "subscriptions" ? [...ADMIN_FILTERS.subscriptionStatuses] : view === "recurring-intents" ? [...ADMIN_FILTERS.recurringIntentStatuses] : view === "manual-payment-intents" ? [...ADMIN_FILTERS.manualIntentStatuses] : []).map((item) => <option value={item} key={item}>{human(item)}</option>)}</select></label>}
      <label>Created from<input type="date" name="from" defaultValue={query.from?.toISOString().slice(0, 10) ?? ""} /></label>
      <label>Created to<input type="date" name="to" defaultValue={query.to?.toISOString().slice(0, 10) ?? ""} /></label>
      <button type="submit">Apply filters</button>
    </form>
    {queryError && <p className="admin-user-empty" role="status">{queryError}</p>}
    {!page ? <div className="admin-user-unavailable">Billing records are unavailable in this runtime. No sample financial records are shown.</div>
      : page.items.length === 0 ? <div className="admin-user-unavailable">No {view === "payments" ? "payment records" : view === "subscriptions" ? "subscription records" : view === "manual-access" ? "manual access periods" : "checkout intents"} match these filters.</div>
      : <>
        <p className="admin-user-result-count">{page.total} stored record{page.total === 1 ? "" : "s"} · Page {page.page}</p>
        {view === "payments" && <PaymentTable rows={page.items as AdminPaymentRow[]} />}
        {view === "subscriptions" && <SubscriptionTable rows={page.items as AdminSubscriptionRow[]} />}
        {view === "manual-access" && <ManualAccessTable rows={page.items as AdminManualAccessRow[]} />}
        {(view === "recurring-intents" || view === "manual-payment-intents") && <IntentTable rows={page.items as AdminBillingIntentRow[]} />}
        <nav className="admin-user-pagination" aria-label="Billing record pages"><span>Showing up to {page.pageSize} per page</span><div><a aria-disabled={page.page <= 1} href={page.page <= 1 ? undefined : pageHref(page.page - 1)}>Previous</a><a aria-disabled={page.page * page.pageSize >= page.total} href={page.page * page.pageSize >= page.total ? undefined : pageHref(page.page + 1)}>Next</a></div></nav>
      </>}
    <p className="admin-user-footnote">Refund records, provider-reported fees, tax breakdowns, payment methods, and payment-linked webhook history are not stored in the current schema; they are not estimated here.</p>
  </AdminShell>;
}

function PaymentTable({ rows }: { rows: AdminPaymentRow[] }) {
  return <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Payment / owner</th><th>Stored amount</th><th>Status</th><th>Billing source</th><th>Timestamp</th><th></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.providerPaymentId}</strong><small>{row.ownerName || "Name unavailable"} · {row.ownerEmail}</small></td><td>{amount(row.amountPaise, row.currency)}</td><td><span className="admin-state-label">{human(row.status)}</span></td><td>{row.billingMode === "conflicting" ? "Relationship unavailable / inconsistent" : row.billingMode === "unlinked" ? "No linked billing intent" : `${row.billingMode === "manual" ? "Manual one-time" : "Recurring intent"} · ${row.planId || "Plan unavailable"} · ${row.interval || "period unavailable"}`}</td><td>{date(row.createdAt)}</td><td><a href={`/admin/billing/payments/${encodeURIComponent(row.id)}`}>View details</a></td></tr>)}</tbody></table></div>;
}

function SubscriptionTable({ rows }: { rows: AdminSubscriptionRow[] }) {
  return <><p className="admin-user-footnote">These are current Subscription rows, not a complete historical ledger and not proof that a particular payment succeeded.</p><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Owner</th><th>Plan / interval</th><th>Stored state</th><th>Period end</th><th>Cancellation</th><th>Updated</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.ownerName || "Name unavailable"}</strong><small>{row.ownerEmail} · {row.userId}</small></td><td>{row.planId} · {row.interval}</td><td><span className="admin-state-label">{human(row.status)}</span></td><td>{date(row.currentPeriodEnd)}</td><td>{row.cancellationRequestedAt ? `Requested ${date(row.cancellationRequestedAt)}` : row.cancelAtPeriodEnd ? "At period end" : "No cancellation recorded"}</td><td>{date(row.updatedAt)}</td></tr>)}</tbody></table></div></>;
}

function ManualAccessTable({ rows }: { rows: AdminManualAccessRow[] }) {
  return <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Owner</th><th>Plan</th><th>Access period</th><th>Payment reference</th><th>Grant recorded</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.ownerName || "Name unavailable"}</strong><small>{row.ownerEmail} · {row.userId}</small></td><td>{row.planId}</td><td>{date(row.startsAt)}<small>Expires {date(row.expiresAt)}</small></td><td>{row.paymentReferenceAvailable ? "Stored reference available" : "Unavailable"}</td><td>{date(row.createdAt)}</td></tr>)}</tbody></table></div>;
}

function IntentTable({ rows }: { rows: AdminBillingIntentRow[] }) {
  return <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Intent / owner</th><th>Plan / interval</th><th>Stored requested amount</th><th>Intent status</th><th>Created / updated</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.billingMode}:${row.id}`}><td><strong>{row.id}</strong><small>{row.ownerName || "Name unavailable"} · {row.ownerEmail}</small></td><td>{row.planId} · {row.interval}</td><td>{row.amountPaise === null ? "Unknown — manual review" : amount(row.amountPaise, row.currency)}</td><td><span className="admin-state-label">{human(row.status)}</span></td><td>{date(row.createdAt)}<small>{date(row.updatedAt)}</small></td></tr>)}</tbody></table></div>;
}

export async function renderAdminPaymentDetailsPage(paymentId: string) {
  await requireAdminPage();
  const runtime = getRuntime();
  const details = runtime.adminData ? await (await runtime.adminData()).getPaymentDetails(paymentId) : null;
  return <AdminShell activeSection="billing" dataStatus={details ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN / BILLING</p><h1>Payment details</h1><p>Read-only information from the stored payment and linked billing records.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <a className="admin-user-back" href="/admin/billing">← Back to billing</a>
    {!runtime.adminData ? <div className="admin-user-unavailable">Payment detail data is unavailable in this runtime.</div> : !details ? <div className="admin-user-unavailable">This payment record is unavailable or does not exist.</div> : <PaymentDetail details={details} />}
  </AdminShell>;
}

function PaymentDetail({ details }: { details: AdminPaymentDetails }) {
  const { payment } = details;
  return <div className="admin-billing-detail">
    <section className="admin-user-profile"><div><p className="admin-eyebrow">STORED PAYMENT</p><h2>{payment.providerPaymentId}</h2><p>{amount(payment.amountPaise, payment.currency)} · {human(payment.status)}</p></div><dl><div><dt>Owner</dt><dd>{details.owner ? `${details.owner.name || "Name unavailable"} · ${details.owner.email}` : "Owner record unavailable"}</dd></div><div><dt>Provider subscription reference</dt><dd>{payment.providerSubscriptionId || "Not recorded"}</dd></div><div><dt>Recorded at</dt><dd>{date(payment.createdAt)}</dd></div><div><dt>Billing record type</dt><dd>{human(payment.billingMode)}</dd></div></dl></section>
    <div className="admin-billing-detail-grid">
      <section className="admin-user-section"><h2>Linked plan intent</h2>{details.plan ? <dl className="admin-user-facts"><div><dt>Plan / interval</dt><dd>{details.plan.planId} · {details.plan.interval}</dd></div><div><dt>Expected intent amount</dt><dd>{details.plan.expectedAmountPaise === null ? "Unknown — manual review" : amount(details.plan.expectedAmountPaise, details.plan.currency)}</dd></div><div><dt>Stored intent state</dt><dd>{human(details.plan.intentStatus)}</dd></div><div><dt>Intent created / updated</dt><dd>{date(details.plan.createdAt)}<small>{date(details.plan.updatedAt)}</small></dd></div></dl> : <p className="admin-user-empty">No safely matching payment intent is stored.</p>}</section>
      <section className="admin-user-section"><h2>Entitlement context</h2>{details.currentSubscription ? <><p>Current recurring Subscription row (separate from proof of this payment): <strong>{human(details.currentSubscription.status)}</strong></p><p>{details.currentSubscription.planId} · {details.currentSubscription.interval} · period end {date(details.currentSubscription.currentPeriodEnd)}</p><p>{details.currentSubscription.cancellationRequestedAt ? `Cancellation requested ${date(details.currentSubscription.cancellationRequestedAt)}` : details.currentSubscription.cancelAtPeriodEnd ? "Cancellation at period end is stored." : "No cancellation request is stored."}</p></> : details.manualAccess ? <><p>Manual one-time access period (not recurring).</p><p>{details.manualAccess.planId} · {date(details.manualAccess.startsAt)} through {date(details.manualAccess.expiresAt)}</p></> : <p className="admin-user-empty">No linked entitlement record is available. Payment status alone is not treated as current access.</p>}</section>
    </div>
    <section className="admin-user-section"><h2>Unavailable financial/provider fields</h2><ul>{details.unavailableInformation.map((item) => <li key={item}>{item[0]?.toUpperCase()}{item.slice(1)}.</li>)}</ul></section>
    <p className="admin-user-footnote">No refund amount, gateway fee, tax or net amount is calculated. Provider payment references are identifiers only; no live provider verification was performed.</p>
  </div>;
}
