import { PublicPage } from "../../src/components/PublicPage.tsx";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "How ClipForge works", description: "A practical guide to organizing, editing and preparing short-form video campaigns with ClipForge.", path: "/how-it-works" });

export default function HowItWorksPage() {
  return <PublicPage eyebrow="Getting started" title="Four steps from a source clip to a reviewed plan." intro="Use the workspace to prepare publishing. A scheduled item is not proof that Instagram has published it.">
    <ol className="guide-steps" id="steps"><li><span>01</span><div><h2>Create an account and connect</h2><p>Sign in, then connect an eligible Instagram professional account through the official authorization flow when configured. ClipForge does not ask for or store an Instagram password.</p></div></li><li><span>02</span><div><h2>Upload and organize</h2><p>Add source videos to your library and group related media in collections. Grant access only to people who should use that collection.</p></div></li><li><span>03</span><div><h2>Apply a style and prepare details</h2><p>Preview the source, set trim and visual options, then prepare captions and a cover. A saved style can be reviewed before applying it to multiple selected videos.</p></div></li><li><span>04</span><div><h2>Schedule, preflight and track</h2><p>Review the account, schedule and media checks before starting a cycle. The worker and official Meta response determine the stored result; uncertain results need manual review.</p></div></li></ol>
    <div className="notice"><strong>Publishing depends on eligibility.</strong> Instagram account type, approved permissions, media rules, publishing quota and server worker configuration all matter.</div><p><a className="button button-primary" href="/register">Create an account</a></p>
  </PublicPage>;
}
