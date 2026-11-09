import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Terms of service — draft", description: "Draft terms for ClipForge require operator and legal review before publication.", path: "/terms", indexable: false });

export default function TermsPage() {
  return <PublicPage eyebrow="Policy draft · not final" title="Terms of service" intro="This draft is not a substitute for terms approved by the ClipForge operator and legal counsel. It remains excluded from search indexing.">
    <section><h2>Service and integrations</h2><p>ClipForge provides tools for organizing and preparing video workflows. Instagram publishing depends on supported accounts, Meta permissions, media requirements, quota and deployment configuration. A scheduled or queued item is not a guarantee of publication.</p></section>
    <section><h2>Plans and payments</h2><p>Plan prices and limits are shown from the product catalog. Checkout availability and any subscription terms are shown by the configured payment flow. The operator still needs to confirm service terms, cancellation language, governing law and dispute/contact details here.</p></section>
  </PublicPage>;
}
