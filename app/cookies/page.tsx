import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Cookie information — draft", description: "Draft information about ClipForge authentication cookies and local theme preference.", path: "/cookies", indexable: false });

export default function CookiesPage() {
  return <PublicPage eyebrow="Policy draft · not final" title="Cookie and storage information" intro="This draft describes the inspected frontend only. It is excluded from indexing pending operator review of deployed configuration and consent requirements.">
    <section><h2>Application preferences and sign-in</h2><p>The customer interface stores the selected light or dark theme in the browser's local storage. Signed-in functionality uses server-managed session cookies. The exact cookie names, durations and production security settings must be documented from the deployed configuration before launch.</p></section>
    <section><h2>Advertising and analytics</h2><p>No advertising script or analytics tag was found in the inspected frontend. No advertising scripts are added by this redesign. If advertising or analytics is added later, its storage and consent behavior must be documented before it is enabled.</p></section>
  </PublicPage>;
}
