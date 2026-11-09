import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Privacy information — draft", description: "Draft privacy information for ClipForge. Operator and deployment details require review before publication.", path: "/privacy", indexable: false });

export default function PrivacyPage() {
  return <PublicPage eyebrow="Policy draft · not final" title="Privacy information" intro="This page is a project-specific draft, not a complete privacy notice. It is excluded from indexing until the operator reviews and completes it.">
    <section><h2>Information handled by the application</h2><p>The source includes account and authentication records, session records, uploaded-media metadata, collections, campaign items and service activity. Password credentials are stored as password hashes; session cookie tokens are stored as hashes. Google and Meta connections use their respective authorization flows.</p><p>Media storage depends on the runtime configuration. A deployment may use in-memory or local-disk storage; this source does not establish a production storage provider or region.</p></section>
    <section><h2>Details still required</h2><p>The operator must provide the legal data controller, verified contact address, retention periods, data-location details, subprocessors, deletion/export procedures and account-request process. This page must be reviewed against the actual deployed configuration before launch or advertising review.</p></section>
    <p className="notice">No advertising script or analytics tag was found in the inspected frontend. This does not establish the behavior of external deployment infrastructure.</p>
  </PublicPage>;
}
