import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Refund and cancellation information — draft", description: "Refund and cancellation terms require confirmation from the ClipForge operator.", path: "/refunds", indexable: false });

export default function RefundsPage() {
  return <PublicPage eyebrow="Policy draft · not final" title="Refund and cancellation information" intro="A final refund policy has not been verified in the inspected project content. This draft is excluded from indexing and is not a promise of a particular refund outcome.">
    <section><h2>Before purchasing</h2><p>Review the plan, interval, amount and any renewal information shown in the secure checkout flow. Do not rely on this draft as a substitute for the applicable purchase terms.</p></section>
    <section><h2>Operator action required</h2><p>The operator must publish refund eligibility, request procedure, time limits, cancellation effects, payment support contact and applicable legal details before enabling advertising or treating this page as final.</p><p>Current contact channel: not configured.</p></section>
  </PublicPage>;
}
