import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Contact ClipForge", description: "Current contact and feedback options for ClipForge.", path: "/contact", indexable: false });

export default function ContactPage() {
  return <PublicPage eyebrow="Contact" title="A public contact channel is not configured yet." intro="We do not have a verified support email address or public feedback submission route to list here.">
    <section><h2>Before launch</h2><p>The ClipForge operator needs to publish a monitored support channel and confirm who handles billing, privacy and account requests. We will not substitute an invented email address or an unmonitored form.</p><p>Until then, use the <a href="/help">Help &amp; FAQ</a> page for current product information and the <a href="/pricing">Pricing</a> page for catalog details.</p></section>
  </PublicPage>;
}
