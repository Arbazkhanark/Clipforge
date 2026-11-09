import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "About ClipForge", description: "Learn what ClipForge is building for short-form video preparation and publishing workflows.", path: "/about" });

export default function AboutPage() {
  return <PublicPage eyebrow="About" title="A workspace for the work around every clip." intro="ClipForge is being built to help creators and clipping teams keep videos, editing decisions, campaign plans and publishing status connected.">
    <section><h2>Built around preparation</h2><p>Short-form video work includes more than exporting a clip. Teams also organize source media, choose a format, apply a visual style, prepare captions and covers, review account eligibility, and keep track of what happened. ClipForge brings those steps into a single workflow.</p></section>
    <section><h2>Designed to be clear about status</h2><p>Saved, queued, attempted, published and uncertain are different states. ClipForge is designed to show the state it has stored and to keep uncertain publishing outcomes in manual review.</p></section>
    <section><h2>Still in development</h2><p>Provider availability depends on server configuration, account eligibility and permissions. We do not promise reach, engagement, revenue or publishing outcomes.</p><p>Company identity, support contact and legal policy details are not configured on this page. See the relevant draft policy pages before relying on them.</p></section>
  </PublicPage>;
}
