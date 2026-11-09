"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import type { BillingInterval, PlanId } from "../lib/billing/catalog.ts";

type CouponSnapshot = { redemptionId: string; status: string; listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null };
type RedemptionStatus = {
  redemption: { id: string; status: string; planId: PlanId | null; interval: BillingInterval | null; listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null };
  coupon: { status: string; unavailable: boolean };
  manualPayment: { status: string; accessStartsAt: string | null; accessEndsAt: string | null } | null;
  grant: { status: string; planId: Exclude<PlanId, "free">; startsAt: string | null; expiresAt: string | null } | null;
};
type StoredRedemption = { id: string; planId: PlanId };
const LAST_REDEMPTION_KEY = "clipforge:last-promotion-redemption";
const money = (paise: number | null, currency: string | null): string => paise === null ? "Unavailable" : `${currency ?? "INR"} ${(paise / 100).toFixed(2)}`;
function stableIdempotencyKey(storageKey: string): string {
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const next = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, next);
  return next;
}
function rememberRedemption(id: string, planId: PlanId): void { window.sessionStorage.setItem(LAST_REDEMPTION_KEY, JSON.stringify({ id, planId } satisfies StoredRedemption)); }
function redemptionMessage(status: RedemptionStatus): string {
  if (status.manualPayment?.status === "manual_review" || status.redemption.status === "manual_review") return "Manual review is required. No coupon was released and no payment success is assumed.";
  if (status.grant?.status === "active") return `Free access is active on ${status.grant.planId} through ${status.grant.expiresAt ? new Date(status.grant.expiresAt).toLocaleString() : "the stored expiry is unavailable"}.`;
  if (status.grant?.status === "queued") return `Free access is redeemed and pending activation on ${status.grant.planId}. It will start according to the stored access queue.`;
  if (status.grant?.status === "expired") return "Free promotional access has expired. Existing videos and account data are preserved.";
  if (status.grant?.status === "revoked") return "Free promotional access was revoked. Existing paid access and account data are preserved.";
  if (status.redemption.status === "redeemed" && status.manualPayment?.status === "paid") return "Payment verified and coupon redeemed. Access is recorded for the paid period.";
  if (status.redemption.status === "released") return "This coupon reservation was released and cannot be used again.";
  if (status.manualPayment?.status === "failed" || status.manualPayment?.status === "expired") return "The payment attempt is stored as ended, but the coupon remains reserved pending reconciliation.";
  if (status.redemption.status === "reserved") return "Coupon applied. Payment is pending verified settlement.";
  return "Coupon status is unavailable. Check again or contact support.";
}

export function PromotionStatusPanel({ coupon, status, message, checkoutUrl, busy, onContinue, onRefresh }: {
  coupon: CouponSnapshot | null; status: RedemptionStatus | null; message: string; checkoutUrl: string | null; busy: boolean;
  onContinue: () => void; onRefresh: (redemptionId: string) => void;
}) {
  if (!coupon) return null;
  return <section className="promotion-checkout-status" aria-label="Coupon checkout status"><h3>Coupon status</h3>
    {coupon.listPricePaise !== null && <p>Original price {money(coupon.listPricePaise, coupon.currency)} · Discount {money(coupon.discountPaise, coupon.currency)} · Payable {money(coupon.payablePaise, coupon.currency)}</p>}
    <p role="status">{status ? redemptionMessage(status) : message}</p>
    {checkoutUrl && <button type="button" disabled={busy} onClick={onContinue}>Continue to secure payment</button>}
    {coupon.status === "reserved" && coupon.listPricePaise !== null && <button type="button" disabled={busy} onClick={() => onRefresh(coupon.redemptionId)}>Check payment status</button>}
  </section>;
}

export function SubscriptionCheckoutButtons({ planId, subscriptionEnabled, manualEnabled }: { planId: PlanId; subscriptionEnabled: boolean; manualEnabled: boolean }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoRenewConsent, setAutoRenewConsent] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [freeAccessCode, setFreeAccessCode] = useState("");
  const [couponSnapshot, setCouponSnapshot] = useState<CouponSnapshot | null>(null);
  const [promotionStatus, setPromotionStatus] = useState<RedemptionStatus | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const refreshPromotionStatus = async (redemptionId: string) => {
    const response = await fetch(`/api/promotions/redemptions/${encodeURIComponent(redemptionId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Promotion status is unavailable. Sign in to view your own redemption.");
    const result = await response.json() as { data: RedemptionStatus };
    setPromotionStatus(result.data);
    setCouponSnapshot({ redemptionId: result.data.redemption.id, status: result.data.redemption.status, listPricePaise: result.data.redemption.listPricePaise, discountPaise: result.data.redemption.discountPaise, payablePaise: result.data.redemption.payablePaise, currency: result.data.redemption.currency });
    setMessage(redemptionMessage(result.data));
  };

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(LAST_REDEMPTION_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<StoredRedemption>;
      if (typeof parsed.id === "string" && parsed.planId === planId) void refreshPromotionStatus(parsed.id).catch(() => undefined);
    } catch { /* session storage is an optional recovery hint; the server remains authoritative */ }
  }, [planId]);

  const start = async (interval: BillingInterval, mode: "subscription" | "manual") => {
    if (busy || (mode === "subscription" ? !subscriptionEnabled || !autoRenewConsent : !manualEnabled)) return;
    setBusy(true); setMessage("Opening secure checkout…");
    try {
      const normalizedCode = couponCode.trim().toUpperCase();
      const hasDiscountCoupon = mode === "manual" && normalizedCode.length > 0;
      const idempotencyKey = hasDiscountCoupon ? stableIdempotencyKey(`clipforge:manual:${planId}:${interval}:${normalizedCode}`) : crypto.randomUUID();
      const response = await fetch(mode === "subscription" ? "/api/payments/razorpay/subscriptions" : "/api/payments/razorpay/manual", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ planId, interval, ...(mode === "subscription" ? { autoRenewConsent } : hasDiscountCoupon ? { couponCode } : {}) }) });
      const data = await response.json() as { checkoutUrl?: unknown; error?: string; coupon?: CouponSnapshot; paymentStatus?: string };
      if (!response.ok && data.coupon?.redemptionId) {
        setCouponSnapshot(data.coupon); rememberRedemption(data.coupon.redemptionId, planId);
        await refreshPromotionStatus(data.coupon.redemptionId).catch(() => undefined);
      }
      if (!response.ok) {
        const messages: Record<string, string> = { coupon_unavailable: "Coupon expired or unavailable for this plan or checkout.", checkout_requires_review: "Manual review is required. The coupon reservation remains held; check its status below.", checkout_in_progress: "Payment setup is pending. The coupon remains reserved while the existing attempt is checked." };
        throw new Error(messages[data.error ?? ""] ?? "checkout_unavailable");
      }
      if (!response.ok || typeof data.checkoutUrl !== "string") throw new Error(data.error ?? "checkout_unavailable");
      if (hasDiscountCoupon && data.coupon?.redemptionId) {
        rememberRedemption(data.coupon.redemptionId, planId);
        setCouponSnapshot(data.coupon); setCheckoutUrl(data.checkoutUrl);
        setMessage(`Coupon applied. ${money(data.coupon.listPricePaise, data.coupon.currency)} − ${money(data.coupon.discountPaise, data.coupon.currency)} = ${money(data.coupon.payablePaise, data.coupon.currency)}. Payment pending verified settlement.`);
        await refreshPromotionStatus(data.coupon.redemptionId).catch(() => undefined);
        setBusy(false);
        return;
      }
      window.location.assign(data.checkoutUrl);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Checkout could not start. Sign in and try again, or contact support if a previous request is still being reviewed."); setBusy(false); }
  };

  const redeemFreeAccess = async () => {
    const normalizedCode = freeAccessCode.trim().toUpperCase();
    if (busy || !normalizedCode) { setMessage("Enter a free-access coupon code first."); return; }
    setBusy(true); setMessage("Checking and redeeming the free-access coupon…"); setCheckoutUrl(null); setPromotionStatus(null); setCouponSnapshot(null);
    try {
      const idempotencyKey = stableIdempotencyKey(`clipforge:free-coupon:${normalizedCode}`);
      const response = await fetch("/api/promotions/redeem", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify({ code: freeAccessCode }) });
      const result = await response.json() as { error?: string; data?: { redemption: { id: string; status: string }; grant: { status: string; planId: Exclude<PlanId, "free">; expiresAt: string | null } } };
      if (!response.ok || !result.data) {
        const messages: Record<string, string> = { coupon_unavailable: "Coupon expired or unavailable.", unauthenticated: "Sign in to redeem a free-access coupon.", coupon_redemption_conflict: "This coupon redemption needs support review." };
        throw new Error(messages[result.error ?? ""] ?? "Free-access coupon could not be redeemed.");
      }
      rememberRedemption(result.data.redemption.id, result.data.grant.planId);
      await refreshPromotionStatus(result.data.redemption.id);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "Free-access coupon status is unavailable."); }
    finally { setBusy(false); }
  };

  if (planId === "free") return <p>Free plan</p>;

  return <div className="checkout-actions">
    <fieldset><legend>Auto-renew subscription</legend>
      <label><input type="checkbox" checked={autoRenewConsent} onChange={(event: ChangeEvent<HTMLInputElement>) => setAutoRenewConsent(event.currentTarget.checked)} /> I agree to automatic renewal at the displayed amount and frequency until I cancel. Cancellation follows the period-end policy.</label>
      <button type="button" disabled={!subscriptionEnabled || busy || !autoRenewConsent} onClick={() => void start("weekly", "subscription")}>Subscribe weekly — renews every 7 days until cancelled</button>
      <button type="button" disabled={!subscriptionEnabled || busy || !autoRenewConsent} onClick={() => void start("monthly", "subscription")}>Subscribe monthly — renews monthly until cancelled</button>
      {!subscriptionEnabled && <small>Auto-renew checkout is unavailable until sandbox plan configuration is complete.</small>}
    </fieldset>
    <fieldset><legend>Pay once / Manual renewal</legend>
      <p>One payment only. No automatic deductions. Weekly access lasts 7 days; monthly access lasts one calendar month. Access then expires unless you pay again.</p>
      <label>Discount coupon for manual payment<input type="text" autoComplete="off" maxLength={64} value={couponCode} onChange={(event: ChangeEvent<HTMLInputElement>) => setCouponCode(event.currentTarget.value)} placeholder="Optional discount code" /></label>
      <button type="button" disabled={!manualEnabled || busy} onClick={() => void start("weekly", "manual")}>Pay once weekly</button>
      <button type="button" disabled={!manualEnabled || busy} onClick={() => void start("monthly", "manual")}>Pay once monthly</button>
      {!manualEnabled && <small>Manual payment checkout is unavailable until sandbox billing is configured.</small>}
      <label>Free-access coupon code<input type="text" autoComplete="off" maxLength={64} value={freeAccessCode} onChange={(event: ChangeEvent<HTMLInputElement>) => setFreeAccessCode(event.currentTarget.value)} placeholder="Access coupon code" /></label>
      <button type="button" disabled={busy || !freeAccessCode.trim()} onClick={() => void redeemFreeAccess()}>Redeem free-access coupon</button>
    </fieldset>
    <PromotionStatusPanel coupon={couponSnapshot} status={promotionStatus} message={message} checkoutUrl={checkoutUrl} busy={busy} onContinue={() => checkoutUrl && window.location.assign(checkoutUrl)} onRefresh={(id) => void refreshPromotionStatus(id)} />
    {message && <p role="status">{message}</p>}
    <small>Plans and entitlements update only after server-verified Razorpay payment records or signed subscription events.</small>
  </div>;
}
