import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PromotionStatusPanel, SubscriptionCheckoutButtons } from "../src/components/SubscriptionCheckoutButtons.tsx";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
type Snapshot = { redemptionId: string; status: string; listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null };
type TestStatus = { redemption: { id: string; status: string; planId: "creator" | "pro" | "agency" | null; interval: "weekly" | "monthly" | null; listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null }; coupon: { status: string; unavailable: boolean }; manualPayment: { status: string; accessStartsAt: string | null; accessEndsAt: string | null } | null; grant: { status: string; planId: "creator" | "pro" | "agency"; startsAt: string | null; expiresAt: string | null } | null };
const snapshot: Snapshot = { redemptionId: "redemption-1", status: "reserved", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR" };
const status = (over: Partial<TestStatus> = {}): TestStatus => ({
  redemption: { id: "redemption-1", status: "reserved", planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR" },
  coupon: { status: "active", unavailable: false }, manualPayment: { status: "created", accessStartsAt: null, accessEndsAt: null }, grant: null, ...over,
});
const panel = (next: ReturnType<typeof status>, coupon = snapshot) => html(<PromotionStatusPanel coupon={coupon} status={next} message="coupon applied" checkoutUrl={null} busy={false} onContinue={() => {}} onRefresh={() => {}} />);

test("coupon status panel shows the server snapshot and pending payment state", () => {
  const output = panel(status());
  assert.match(output, /Original price INR 499\.00/);
  assert.match(output, /Discount INR 49\.90/);
  assert.match(output, /Payable INR 449\.10/);
  assert.match(output, /Payment is pending verified settlement/);
  assert.match(output, /Check payment status/);
});

test("coupon status panel distinguishes verified payment, free access, and manual review", () => {
  assert.match(panel(status({ redemption: { id: "r", status: "redeemed", planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR" }, manualPayment: { status: "paid", accessStartsAt: null, accessEndsAt: null } })), /Payment verified and coupon redeemed/);
  assert.match(panel(status({ redemption: { id: "r", status: "redeemed", planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null }, manualPayment: null, grant: { status: "queued", planId: "pro", startsAt: null, expiresAt: null } }), { ...snapshot, listPricePaise: null, discountPaise: null, payablePaise: null }), /Free access is redeemed and pending activation/);
  assert.match(panel(status({ redemption: { id: "r", status: "redeemed", planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null }, manualPayment: null, grant: { status: "active", planId: "agency", startsAt: "2026-11-08T12:00:00.000Z", expiresAt: "2026-11-10T12:00:00.000Z" } }), { ...snapshot, listPricePaise: null, discountPaise: null, payablePaise: null }), /Free access is active on agency/);
  assert.match(panel(status({ manualPayment: { status: "manual_review", accessStartsAt: null, accessEndsAt: null } })), /Manual review is required/);
  assert.match(panel(status({ redemption: { id: "r", status: "released", planId: "creator", interval: "weekly", listPricePaise: 49_900, discountPaise: 4_990, payablePaise: 44_910, currency: "INR" } })), /reservation was released/);
});

test("coupon panel wires secure checkout continuation and does not report an unverified payment", () => {
  let continued = false; let refreshed = "";
  const output = html(<PromotionStatusPanel coupon={snapshot} status={status()} message="pending" checkoutUrl="https://rzp.io/i/test" busy={false} onContinue={() => { continued = true; }} onRefresh={(id) => { refreshed = id; }} />);
  assert.match(output, /Continue to secure payment/);
  assert.doesNotMatch(output, /Payment verified/);
  const node = PromotionStatusPanel({ coupon: snapshot, status: status(), message: "pending", checkoutUrl: "https://rzp.io/i/test", busy: false, onContinue: () => { continued = true; }, onRefresh: (id) => { refreshed = id; } });
  const children = node?.props.children as unknown[];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const element = value as { type?: unknown; props: Record<string, unknown> };
    if (element.type === "button") {
      const click = element.props["onClick"];
      if (typeof click === "function") click();
    }
    walk(element.props["children"]);
  };
  walk(children);
  assert.equal(continued, true);
  assert.equal(refreshed, "redemption-1");
});

test("manual coupon and free-access entry are separate from the unchanged recurring consent controls", () => {
  const output = html(<SubscriptionCheckoutButtons planId="creator" subscriptionEnabled={true} manualEnabled={true} />);
  assert.match(output, /Discount coupon for manual payment/);
  assert.match(output, /Free-access coupon code/);
  assert.match(output, /Redeem free-access coupon/);
  assert.match(output, /I agree to automatic renewal/);
  assert.match(output, /Subscribe weekly — renews every 7 days until cancelled/);
});
