"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { AdminShell } from "./AdminShell.tsx";

type Coupon = {
  id: string; type: "discount_coupon" | "free_access_coupon"; status: "draft" | "active" | "paused" | "expired" | "revoked";
  code: string; discountType: "percentage" | "fixed_amount" | null; discountValue: number | null; discountValueUnit: string | null;
  accessPlanId: string | null; durationDays: number | null; eligiblePlanIds: string[]; targetUserId: string | null;
  startsAt: string; expiresAt: string | null; usageLimit: number | null; createdByAdminId: string; reason: string | null;
  createdAt: string; updatedAt: string;
  usage: { reserved: number; redeemed: number; released: number; manualReview: number; countsTowardUsageLimit: number; usageLimit: number | null; remainingSlots: number | null };
};
type CouponPage = { data: Coupon[]; page: number; pageSize: number; total: number };
type Redemption = { id: string; status: string; userDisplayIdentifier: string; planId: string | null; interval: string | null; listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null; createdAt: string; updatedAt: string };
type LifecycleEvent = { id: string; eventType: string; subjectUserId: string | null; actorUserId: string | null; redemptionId: string | null; accessGrantId: string | null; occurredAt: string; outcome: string | null; auditUrl: string | null };
type HistoryPage<T> = { data: T[]; page: number; pageSize: number; total: number };
type Editor = { type: Coupon["type"]; code: string; discountType: "percentage" | "fixed_amount"; discountValue: string; eligiblePlanId: string; accessPlanId: string; durationDays: string; targetUserId: string; startsAt: string; expiresAt: string; usageLimit: string; reason: string };
type SubmitEvent = { preventDefault(): void };

const emptyEditor = (): Editor => ({ type: "discount_coupon", code: "", discountType: "percentage", discountValue: "", eligiblePlanId: "creator", accessPlanId: "creator", durationDays: "3", targetUserId: "", startsAt: "", expiresAt: "", usageLimit: "", reason: "" });
const localInput = (value: string | null): string => value ? new Date(value).toISOString().slice(0, 16) : "";
const isoOrNull = (value: string): string | null => value ? new Date(value).toISOString() : null;
const human = (value: string): string => value.replaceAll("_", " ");
const when = (value: string | null): string => value ? `${new Date(value).toLocaleString("en-IN", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC` : "No expiry";
const amount = (value: number | null, currency: string | null): string => value === null ? "Not recorded" : `${currency ?? "INR"} ${(value / 100).toFixed(2)}`;

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? `Request failed (${response.status}).`;
  } catch { return `Request failed (${response.status}).`; }
}

export function AdminOffersClient() {
  const [page, setPage] = useState<CouponPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [query, setQuery] = useState({ search: "", type: "", status: "" });
  const [applied, setApplied] = useState(query);
  const [pageNumber, setPageNumber] = useState(1);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [selected, setSelected] = useState<Coupon | null>(null);
  const [etag, setEtag] = useState("");
  const [working, setWorking] = useState(false);
  const [redemptions, setRedemptions] = useState<HistoryPage<Redemption> | null>(null);
  const [lifecycle, setLifecycle] = useState<HistoryPage<LifecycleEvent> | null>(null);
  const [redemptionPage, setRedemptionPage] = useState(1);
  const [lifecyclePage, setLifecyclePage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const load = async (requestedPage: number, filters: typeof applied) => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ page: String(requestedPage), pageSize: "25" });
    if (filters.search) params.set("search", filters.search);
    if (filters.type) params.set("type", filters.type);
    if (filters.status) params.set("status", filters.status);
    try {
      const response = await fetch(`/api/admin/promotions?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      setPage(await response.json() as CouponPage);
    } catch (cause) { setPage(null); setError(cause instanceof Error ? cause.message : "Offers could not be loaded."); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(1, applied); }, [applied]);

  const loadHistory = async (promotionId: string, redemptionPageNumber = 1, lifecyclePageNumber = 1) => {
    setHistoryLoading(true); setHistoryError("");
    try {
      const [redemptionResponse, lifecycleResponse] = await Promise.all([
        fetch(`/api/admin/promotions/${encodeURIComponent(promotionId)}/redemptions?page=${redemptionPageNumber}&pageSize=25`, { cache: "no-store" }),
        fetch(`/api/admin/promotions/${encodeURIComponent(promotionId)}/lifecycle?page=${lifecyclePageNumber}&pageSize=25`, { cache: "no-store" }),
      ]);
      if (!redemptionResponse.ok) throw new Error(await responseError(redemptionResponse));
      if (!lifecycleResponse.ok) throw new Error(await responseError(lifecycleResponse));
      setRedemptions(await redemptionResponse.json() as HistoryPage<Redemption>);
      setLifecycle(await lifecycleResponse.json() as HistoryPage<LifecycleEvent>);
      setRedemptionPage(redemptionPageNumber); setLifecyclePage(lifecyclePageNumber);
    } catch (cause) { setHistoryError(cause instanceof Error ? cause.message : "Coupon history could not be loaded."); }
    finally { setHistoryLoading(false); }
  };

  const openCoupon = async (coupon: Coupon, edit = false) => {
    setError(""); setSuccess("");
    try {
      const response = await fetch(`/api/admin/promotions/${encodeURIComponent(coupon.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const detail = await response.json() as { data: Coupon };
      const loaded = detail.data;
      setSelected(loaded); setEtag(response.headers.get("etag") ?? ""); setEditing(edit ? loaded : null);
      setRedemptions(null); setLifecycle(null); setRedemptionPage(1); setLifecyclePage(1);
      setEditor(edit ? {
        type: loaded.type, code: loaded.code, discountType: loaded.discountType ?? "percentage", discountValue: loaded.discountValue === null ? "" : String(loaded.discountValue),
        eligiblePlanId: loaded.eligiblePlanIds[0] ?? "creator", accessPlanId: loaded.accessPlanId ?? "creator", durationDays: String(loaded.durationDays ?? 3),
        targetUserId: loaded.targetUserId ?? "", startsAt: localInput(loaded.startsAt), expiresAt: localInput(loaded.expiresAt), usageLimit: loaded.usageLimit === null ? "" : String(loaded.usageLimit), reason: loaded.reason ?? "",
      } : null);
      if (!edit) await loadHistory(loaded.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Coupon details could not be loaded."); }
  };

  const beginCreate = () => { setSelected(null); setEditing(null); setEtag(""); setEditor(emptyEditor()); setError(""); setSuccess(""); };

  const submitCoupon = async (event: SubmitEvent) => {
    event.preventDefault(); if (!editor) return;
    setWorking(true); setError(""); setSuccess("");
    const common = { type: editor.type, code: editor.code, startsAt: isoOrNull(editor.startsAt), expiresAt: isoOrNull(editor.expiresAt), usageLimit: editor.usageLimit === "" ? null : Number(editor.usageLimit), targetUserId: editor.targetUserId.trim() || null, reason: editor.reason || null };
    const body = editor.type === "discount_coupon"
      ? { ...common, discountType: editor.discountType, discountValue: Number(editor.discountValue), eligiblePlanIds: [editor.eligiblePlanId] }
      : { ...common, accessPlanId: editor.accessPlanId, durationDays: Number(editor.durationDays) };
    try {
      const response = await fetch(editing ? `/api/admin/promotions/${encodeURIComponent(editing.id)}` : "/api/admin/promotions", {
        method: editing ? "PUT" : "POST", headers: { "content-type": "application/json", ...(editing ? { "if-match": etag } : {}) }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setSuccess(editing ? "Draft coupon updated." : "Draft coupon created. It is not active until you activate it.");
      setEditor(null); setEditing(null); setSelected(null); await load(1, applied);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Coupon could not be saved."); }
    finally { setWorking(false); }
  };

  const transition = async (action: "activate" | "deactivate") => {
    if (!selected || !etag) { setError("Reload this coupon before changing its status."); return; }
    setWorking(true); setError(""); setSuccess("");
    try {
      const response = await fetch(`/api/admin/promotions/${encodeURIComponent(selected.id)}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { data: Coupon };
      setSelected(result.data); setEtag(response.headers.get("etag") ?? ""); setSuccess(action === "activate" ? "Coupon activated." : "Coupon paused."); await Promise.all([load(pageNumber, applied), loadHistory(result.data.id, redemptionPage, lifecyclePage)]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Coupon status could not be changed."); }
    finally { setWorking(false); }
  };

  return <AdminShell activeSection="offers" dataStatus={page ? "available" : "unavailable"}>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Offers</h1><p>Manage coupon definitions and explicit lifecycle transitions.</p></div><button className="admin-offer-primary" type="button" onClick={beginCreate}>Create draft coupon</button></div>
    <div className="admin-billing-notice"><strong>Coupon controls only</strong><span>Usage totals are based on persisted redemption statuses. Redemption and lifecycle histories are available in coupon details. Discounts apply to manual one-time checkout only; recurring subscriptions are unaffected.</span></div>
    {success && <p className="admin-offer-message admin-offer-success" role="status">{success}</p>}
    {error && <p className="admin-offer-message admin-offer-error" role="alert">{error} <button type="button" onClick={() => void load(pageNumber, applied)}>Retry</button></p>}
    <form className="admin-user-filters" onSubmit={(event: SubmitEvent) => { event.preventDefault(); setPageNumber(1); setApplied({ search: query.search.trim(), type: query.type, status: query.status }); }}>
      <label>Search coupon code<input type="search" maxLength={64} value={query.search} onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery({ ...query, search: event.currentTarget.value })} placeholder="e.g. SAVE50" /></label>
      <label>Coupon type<select value={query.type} onChange={(event: ChangeEvent<HTMLSelectElement>) => setQuery({ ...query, type: event.currentTarget.value })}><option value="">All types</option><option value="discount_coupon">Discount coupon</option><option value="free_access_coupon">Free-access coupon</option></select></label>
      <label>Status<select value={query.status} onChange={(event: ChangeEvent<HTMLSelectElement>) => setQuery({ ...query, status: event.currentTarget.value })}><option value="">All statuses</option>{["draft", "active", "paused", "expired", "revoked"].map((status) => <option value={status} key={status}>{human(status)}</option>)}</select></label>
      <button type="submit">Apply filters</button>
    </form>

    <OffersListState loading={loading} error={error} coupons={page?.data ?? []} retry={() => void load(pageNumber, applied)} onOpen={(coupon) => void openCoupon(coupon)} onEdit={(coupon) => void openCoupon(coupon, true)} onPage={(next) => { setPageNumber(next); void load(next, applied); }} page={page} />

    {editor && <section className="admin-offer-editor" aria-labelledby="admin-offer-form-title">
      <div className="admin-offer-section-heading"><div><p className="admin-eyebrow">{editing ? "DRAFT EDIT" : "NEW COUPON"}</p><h2 id="admin-offer-form-title">{editing ? `Edit ${editing.code}` : "Coupon definition"}</h2><p>All values are validated and calculated by the server. New coupons are always created as drafts.</p></div><button type="button" className="admin-offer-secondary" onClick={() => { setEditor(null); setEditing(null); }}>Close</button></div>
      <form className="admin-offer-form" onSubmit={(event: SubmitEvent) => void submitCoupon(event)}>
        <label>Coupon type<select disabled={Boolean(editing)} value={editor.type} onChange={(event: ChangeEvent<HTMLSelectElement>) => setEditor({ ...editor, type: event.currentTarget.value as Coupon["type"] })}><option value="discount_coupon">Discount</option><option value="free_access_coupon">Free access</option></select></label>
        <label>Coupon code<input required minLength={3} maxLength={64} pattern="[A-Za-z0-9_-]+" value={editor.code} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, code: event.currentTarget.value })} /></label>
        {editor.type === "discount_coupon" ? <>
          <label>Discount type<select value={editor.discountType} onChange={(event: ChangeEvent<HTMLSelectElement>) => setEditor({ ...editor, discountType: event.currentTarget.value as Editor["discountType"] })}><option value="percentage">Percentage</option><option value="fixed_amount">Fixed amount</option></select></label>
          <label>{editor.discountType === "fixed_amount" ? "Discount (paise)" : "Discount (percentage points)"}<input required type="number" min="1" max={editor.discountType === "percentage" ? "50" : undefined} step="1" value={editor.discountValue} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, discountValue: event.currentTarget.value })} /></label>
          <label>Eligible plan<select value={editor.eligiblePlanId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setEditor({ ...editor, eligiblePlanId: event.currentTarget.value })}>{["creator", "pro", "agency"].map((plan) => <option value={plan} key={plan}>{plan}</option>)}</select></label>
        </> : <>
          <label>Access tier<select value={editor.accessPlanId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setEditor({ ...editor, accessPlanId: event.currentTarget.value })}>{["creator", "pro", "agency"].map((plan) => <option value={plan} key={plan}>{plan}</option>)}</select></label>
          <label>Access duration (days)<input required type="number" min="1" max="30" step="1" value={editor.durationDays} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, durationDays: event.currentTarget.value })} /></label>
        </>}
        <label>Starts at<input required type="datetime-local" value={editor.startsAt} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, startsAt: event.currentTarget.value })} /></label>
        <label>Expires at (optional)<input type="datetime-local" value={editor.expiresAt} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, expiresAt: event.currentTarget.value })} /></label>
        <label>Usage limit (optional)<input type="number" min="1" step="1" value={editor.usageLimit} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, usageLimit: event.currentTarget.value })} /></label>
        <label>Target user ID (optional)<input maxLength={64} value={editor.targetUserId} onChange={(event: ChangeEvent<HTMLInputElement>) => setEditor({ ...editor, targetUserId: event.currentTarget.value })} /></label>
        <label className="admin-offer-wide">Admin reason (optional)<textarea maxLength={500} value={editor.reason} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setEditor({ ...editor, reason: event.currentTarget.value })} /></label>
        <div className="admin-offer-form-actions"><button className="admin-offer-primary" disabled={working} type="submit">{working ? "Saving…" : editing ? "Save draft" : "Create draft"}</button><span>Fixed discounts are entered in paise. Percentage discounts are whole percentage points, up to 50%.</span></div>
      </form>
    </section>}

    {selected && !editor && <section className="admin-offer-detail" aria-labelledby="admin-offer-detail-title">
      <div className="admin-offer-section-heading"><div><p className="admin-eyebrow">COUPON DETAILS</p><h2 id="admin-offer-detail-title">{selected.code}</h2><p>{human(selected.type)} · {human(selected.status)}</p></div><button type="button" className="admin-offer-secondary" onClick={() => setSelected(null)}>Close</button></div>
      <OffersHistoryDetail coupon={selected} redemptions={redemptions} lifecycle={lifecycle} loading={historyLoading} error={historyError}
        onRetry={() => void loadHistory(selected.id, redemptionPage, lifecyclePage)}
        onRedemptionPage={(next) => void loadHistory(selected.id, next, lifecyclePage)}
        onLifecyclePage={(next) => void loadHistory(selected.id, redemptionPage, next)} />
      <div className="admin-offer-actions">{selected.status === "draft" && <><button type="button" className="admin-offer-secondary" onClick={() => { setEditing(selected); setEditor({ ...emptyEditor(), type: selected.type, code: selected.code, discountType: selected.discountType ?? "percentage", discountValue: selected.discountValue === null ? "" : String(selected.discountValue), eligiblePlanId: selected.eligiblePlanIds[0] ?? "creator", accessPlanId: selected.accessPlanId ?? "creator", durationDays: String(selected.durationDays ?? 3), targetUserId: selected.targetUserId ?? "", startsAt: localInput(selected.startsAt), expiresAt: localInput(selected.expiresAt), usageLimit: selected.usageLimit === null ? "" : String(selected.usageLimit), reason: selected.reason ?? "" }); }}>Edit draft</button><button type="button" className="admin-offer-primary" disabled={working} onClick={() => void transition("activate")}>Activate coupon</button></>}{selected.status === "active" && <button type="button" className="admin-offer-secondary" disabled={working} onClick={() => void transition("deactivate")}>Pause coupon</button>}<span>Only DRAFT → ACTIVE and ACTIVE → PAUSED are available. Paused coupons cannot be reactivated here.</span></div>
    </section>}
  </AdminShell>;
}

export function OffersHistoryDetail({ coupon, redemptions, lifecycle, loading, error, onRetry, onRedemptionPage, onLifecyclePage }: {
  coupon: Coupon; redemptions: HistoryPage<Redemption> | null; lifecycle: HistoryPage<LifecycleEvent> | null; loading: boolean; error: string;
  onRetry: () => void; onRedemptionPage: (next: number) => void; onLifecyclePage: (next: number) => void;
}) {
  return <>
    <dl className="admin-offer-facts"><div><dt>Validity</dt><dd>{when(coupon.startsAt)} – {when(coupon.expiresAt)}</dd></div><div><dt>Usage limit</dt><dd>{coupon.usage.usageLimit ?? "Unlimited"}</dd></div><div><dt>Reserved</dt><dd>{coupon.usage.reserved}</dd></div><div><dt>Redeemed</dt><dd>{coupon.usage.redeemed}</dd></div><div><dt>Released</dt><dd>{coupon.usage.released}</dd></div><div><dt>Manual review</dt><dd>{coupon.usage.manualReview}</dd></div><div><dt>Counts toward limit</dt><dd>{coupon.usage.countsTowardUsageLimit}</dd></div><div><dt>Slots remaining</dt><dd>{coupon.usage.remainingSlots ?? "Unlimited"}</dd></div><div><dt>Discount</dt><dd>{coupon.discountValue === null ? "Not a discount coupon" : `${coupon.discountValue} ${coupon.discountValueUnit}`}</dd></div></dl>
    <section className="admin-offer-history" aria-labelledby="admin-redemption-history-title"><div className="admin-offer-section-heading"><div><h3 id="admin-redemption-history-title">Redemption history</h3><p>Counts use persisted redemption status. A reservation is not a confirmed payment.</p></div></div>
      {error && <p className="admin-offer-message admin-offer-error" role="alert">{error} <button type="button" onClick={onRetry}>Retry history</button></p>}
      {loading ? <p className="admin-user-unavailable" role="status">Loading redemption and lifecycle history…</p> : !redemptions ? <p className="admin-user-unavailable">Redemption history is unavailable.</p> : redemptions.data.length === 0 ? <p className="admin-user-unavailable">No redemptions are recorded for this coupon.</p> : <><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Status</th><th>User identifier</th><th>Plan</th><th>List price</th><th>Discount</th><th>Payable</th><th>Created</th><th>Updated</th></tr></thead><tbody>{redemptions.data.map((row) => <tr key={row.id}><td><span className="admin-state-label">{human(row.status)}</span></td><td>{row.userDisplayIdentifier}</td><td>{row.planId ? `${row.planId}${row.interval ? ` · ${row.interval}` : ""}` : "Not recorded"}</td><td>{amount(row.listPricePaise, row.currency)}</td><td>{amount(row.discountPaise, row.currency)}</td><td>{amount(row.payablePaise, row.currency)}</td><td>{when(row.createdAt)}</td><td>{when(row.updatedAt)}</td></tr>)}</tbody></table></div><HistoryPagination page={redemptions} label="Redemption" onPage={onRedemptionPage} /></>}
    </section>
    <section className="admin-offer-history" aria-labelledby="admin-lifecycle-history-title"><div className="admin-offer-section-heading"><div><h3 id="admin-lifecycle-history-title">Lifecycle history</h3><p>Allowlisted events only. Private event metadata is withheld.</p></div></div>
      {loading ? <p className="admin-user-unavailable" role="status">Loading lifecycle history…</p> : !lifecycle ? <p className="admin-user-unavailable">Lifecycle history is unavailable.</p> : lifecycle.data.length === 0 ? <p className="admin-user-unavailable">No lifecycle events are recorded for this coupon.</p> : <><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Event</th><th>Time</th><th>Actor</th><th>Subject</th><th>Outcome</th><th>Audit</th></tr></thead><tbody>{lifecycle.data.map((event) => <tr key={event.id}><td>{human(event.eventType)}</td><td>{when(event.occurredAt)}</td><td>{event.actorUserId ?? "System / unavailable"}</td><td>{event.subjectUserId ?? "Not applicable"}</td><td>{event.outcome ?? "Not recorded"}</td><td>{event.auditUrl ? <a href={event.auditUrl}>Open audit record</a> : "Unavailable"}</td></tr>)}</tbody></table></div><HistoryPagination page={lifecycle} label="Lifecycle" onPage={onLifecyclePage} /></>}
    </section>
  </>;
}

export function HistoryPagination<T>({ page, label, onPage }: { page: HistoryPage<T>; label: string; onPage: (next: number) => void }) {
  return <nav className="admin-user-pagination" aria-label={`${label} history pages`}><span>{page.total} records · Page {page.page}</span><div><button type="button" disabled={page.page <= 1} onClick={() => onPage(page.page - 1)}>Previous</button><button type="button" disabled={page.page * page.pageSize >= page.total} onClick={() => onPage(page.page + 1)}>Next</button></div></nav>;
}

export function OffersListState({ loading, error, coupons, retry, onOpen, onEdit, onPage, page }: {
  loading: boolean; error: string; coupons: Coupon[]; retry: () => void; onOpen: (coupon: Coupon) => void; onEdit: (coupon: Coupon) => void;
  onPage: (page: number) => void; page: CouponPage | null;
}) {
  if (loading) return <div className="admin-user-unavailable" role="status" aria-live="polite">Loading coupon offers…</div>;
  if (error) return <div className="admin-user-unavailable" role="alert">Offers could not be loaded. <button type="button" onClick={retry}>Retry</button></div>;
  if (coupons.length === 0) return <div className="admin-user-unavailable">No coupons match these filters. Create a draft coupon to get started.</div>;
  return <section className="admin-offers-list" aria-label="Coupon offers">
    <div className="admin-user-result-count">{page?.total ?? coupons.length} coupon definitions · page {page?.page ?? 1}. Reservations, confirmed redemptions, released slots and manual-review holds are counted separately.</div>
    <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Coupon</th><th>Type</th><th>Status</th><th>Validity</th><th>Usage limit</th><th>Usage status counts</th><th>Actions</th></tr></thead><tbody>{coupons.map((coupon) => <tr key={coupon.id}><td><strong>{coupon.code}</strong><small>{coupon.id}</small></td><td>{human(coupon.type)}</td><td><span className="admin-state-label">{human(coupon.status)}</span></td><td>{when(coupon.startsAt)}<small>{coupon.expiresAt ? `Until ${when(coupon.expiresAt)}` : "No end date"}</small></td><td>{coupon.usage.usageLimit ?? "Unlimited"}<small>{coupon.usage.remainingSlots === null ? "No limit configured" : `${coupon.usage.remainingSlots} slots remaining`}</small></td><td><small>Reserved {coupon.usage.reserved} · Redeemed {coupon.usage.redeemed}</small><small>Released {coupon.usage.released} · Manual review {coupon.usage.manualReview}</small></td><td><div className="admin-offer-row-actions"><button type="button" onClick={() => onOpen(coupon)}>Details</button>{coupon.status === "draft" && <button type="button" onClick={() => onEdit(coupon)}>Edit</button>}</div></td></tr>)}</tbody></table></div>
    <nav className="admin-user-pagination" aria-label="Coupon pages"><span>{page?.total ?? coupons.length} records · Page {page?.page ?? 1}</span><div><button type="button" disabled={!page || page.page <= 1} onClick={() => page && onPage(page.page - 1)}>Previous</button><button type="button" disabled={!page || page.page * page.pageSize >= page.total} onClick={() => page && onPage(page.page + 1)}>Next</button></div></nav>
  </section>;
}
