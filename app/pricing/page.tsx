import { PricingTable } from "../../src/components/PricingTable.tsx";

export const metadata = { title: "Pricing", description: "ClipForge plans in Indian rupees, billed weekly or monthly." };

export default function PricingPage() {
  return (
    <>
      <h1>Pricing</h1>
      <p>Prices are in Indian rupees. Weekly and monthly are separate choices; your billing interval never changes unless you change it.</p>
      <PricingTable purchasable={false} />
    </>
  );
}
