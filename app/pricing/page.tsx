import { PricingTable } from "../../src/components/PricingTable.tsx";
import { readRazorpayTestConfig } from "../../src/server/billing/razorpay-client.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Plans and pricing", description: "Compare ClipForge plan prices and limits from the current product catalog.", path: "/pricing" });

export default function PricingPage() {
  return (
    <div className="public-page pricing-page">
      <header className="public-page-heading"><p className="eyebrow">Simple, visible plan limits</p><h1>Plans and pricing</h1><p className="public-page-intro">Prices are in Indian rupees. Weekly and monthly are separate choices; your billing interval never changes unless you change it.</p></header>
      <PricingTable manualPurchasable={Boolean(readRazorpayTestConfig()?.webhookSecret)} subscriptionPurchasable={(() => { const c = readRazorpayTestConfig(); return Boolean(c?.webhookSecret && c.subscriptionTotalCount && ["creator", "pro", "agency"].every((p) => c.subscriptionPlanIds[p as "creator" | "pro" | "agency"]?.weekly && c.subscriptionPlanIds[p as "creator" | "pro" | "agency"]?.monthly)); })()} />
      <p className="pricing-page-note">Plan features and limits are read from the current catalog. Payment availability depends on server configuration.</p>
    </div>
  );
}
