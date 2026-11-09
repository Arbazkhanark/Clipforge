import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "ClipForge features", description: "Explore video editing, collections, campaign planning and publishing workflow features in ClipForge.", path: "/features" });

const featureGroups = [
  ["Prepare video", "Bulk video upload, trimming, actual source preview, borders, backgrounds, zoom, positioning and branding overlays."],
  ["Reuse editing styles", "Save a visual style and apply it to selected videos while preserving each video's trim range by default."],
  ["Organize a campaign", "Build publishing cycles, arrange items, prepare schedules, captions and covers, and run server-side preflight."],
  ["Share collections", "Use private collections, explicit grants, access requests and secure share links. Shared references retain the owner's media."],
  ["Review publishing status", "See stored publishing attempts and manual-review states. Ambiguous outcomes are not automatically retried."],
  ["Understand account eligibility", "Connect through official Meta authorization. Instagram publishing requires supported account type, permissions and deployment configuration."],
] as const;

export default function FeaturesPage() {
  return <PublicPage eyebrow="Features" title="A connected workflow, with clear boundaries." intro="Features and limits vary by plan. Provider-dependent actions still require the relevant account, permissions and configuration.">
    <div className="public-feature-list">{featureGroups.map(([title, description], index) => <section className="public-feature-row" key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{title}</h2><p>{description}</p></div></section>)}</div>
    <p className="notice">This describes implemented product areas; it does not mean every external integration is live in every deployment.</p><a className="text-link" href="/pricing">Compare plans <span aria-hidden="true">→</span></a>
  </PublicPage>;
}
