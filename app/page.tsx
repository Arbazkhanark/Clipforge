// app/page.tsx
import { PLAN_CATALOG, PLAN_IDS, formatPaiseAsRupees } from "../src/lib/billing/catalog.ts";
import { formatCount, formatStorage } from "../src/components/format.ts";
import { ProductStory } from "../src/components/ProductStory.tsx";
import { publicPageMetadata } from "../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({
  title: "Short-form video workflows, organized",
  description: "Prepare videos, organize campaigns, and manage Instagram publishing workflows with ClipForge.",
  path: "/",
});

const FEATURES = [
  ["01", "Upload and organize", "Bring video into a private media library and group it into collections for different workflows."],
  ["02", "Make edits repeatable", "Trim clips, adjust framing, backgrounds and borders, place a brand overlay, then save reusable editing styles."],
  ["03", "Prepare a campaign", "Arrange videos, captions and covers in a publishing cycle with a schedule you can review before starting."],
  ["04", "Share with control", "Use collection permissions to collaborate on shared videos while the original owner keeps ownership."],
  ["05", "Track what happened", "Review stored queue and attempt states, including failures and outcomes that need manual review."],
  ["06", "Work in batches", "Apply a saved editing style to eligible videos and review the affected items before applying."],
] as const;

const WALKTHROUGH = [
  ["Campaign workspace", "Cycle name · connected account · preflight · final review", "Plan and review a publishing cycle before explicitly starting it."],
  ["Video upload", "Choose a source video · server validation · library record", "The upload form sends the selected file to the existing upload handler. No progress percentage is simulated."],
  ["Video editor", "Source preview · trim range · border · background · zoom · overlay", "Preview and export use stored editing settings; the browser preview is not claimed to be pixel-identical to FFmpeg."],
  ["Reusable templates", "Saved editing style · selected videos · review · apply", "Review a style before applying it. Other video settings and trim ranges are preserved unless copying trim is selected."],
  ["Caption and cover", "Caption text · selected cover · cycle item", "Saved values stay in ClipForge. A saved cover is not evidence Instagram received it."],
  ["Publishing calendar", "Cycle schedule · timezone · cadence · review", "The schedule is validated by the server and remains subject to cycle preflight."],
  ["Publishing queue", "Upcoming · scheduled · attempted · published · needs review", "Stored queue and attempt states are distinct; a scheduled item is not a live Instagram confirmation."],
  ["Collections and sharing", "Collection visibility · direct permissions · link/access controls", "Shared media keeps its owner's ownership; each action is subject to the stored grant."],
  ["Activity and status", "Stored status · timestamps · failure or review information", "Display persisted application outcomes. No dashboard metrics are fabricated in this preview."],
] as const;

function WalkthroughPreview({ title, summary, index }: { title: string; summary: string; index: number }) {
  const rows = [
    ["Cycle setup", "Account eligibility", "Review before start"],
    ["Select source video", "Server validation", "Library record"],
    ["Trim and framing", "Border and background", "Overlay and export"],
    ["Saved style", "Select owned videos", "Review affected items"],
    ["Caption", "Cover selection", "Cycle item"],
    ["Mon · Wed · Fri", "Timezone", "Schedule review"],
    ["Queued", "Attempted", "Confirmed or review"],
    ["Owner collection", "Shared permissions", "Import where allowed"],
    ["Stored event", "Outcome status", "Updated timestamp"],
  ][index] ?? [summary];
  return <div className="walkthrough-preview" aria-label={`${title} interface map, illustrative and not a screenshot`}>
    <span className="walkthrough-preview-label">Interface map · illustrative</span>
    <div className={`walkthrough-preview-rows walkthrough-preview-variant-${index}`}>{rows.map((row) => <div className="walkthrough-preview-row" key={row}><i aria-hidden="true" /><span>{row}</span></div>)}</div>
  </div>;
}

export default function HomePage() {
  return (
    <div className="marketing-page">
      <section className="hero-section" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">A calmer way to prepare short-form video</p>
          <h1 id="hero-title">You Focus on Creating. <em>ClipForge Helps Handle the Workflow.</em></h1>
          <p className="hero-lede">ClipForge brings your video library, editing styles, campaign planning and publishing status into one organized workspace.</p>
          <div className="hero-actions"><a className="button button-primary" href="/register">Get started <span aria-hidden="true">↗</span></a><a className="button button-secondary" href="/how-it-works">See how it works</a></div>
          <p className="hero-footnote">Instagram delivery depends on an eligible account, Meta permissions and server configuration.</p>
        </div>
        <div className="hero-visual" aria-label="Illustrative ClipForge workspace preview">
          <div className="preview-window">
            <div className="preview-window-bar"><span className="preview-brand"><span className="site-brand-mark" aria-hidden="true">C</span> ClipForge</span><span className="preview-window-dots" aria-hidden="true">•••</span></div>
            <div className="preview-content">
              <div className="preview-sidebar" aria-hidden="true"><span className="preview-sidebar-mark">C</span><i /><i /><i /><i /></div>
              <div className="preview-board">
                <div className="preview-board-heading"><div><span className="preview-kicker">WORKSPACE</span><strong>Campaign studio</strong></div><span className="preview-badge">Illustrative UI</span></div>
                <div className="preview-project-card"><div className="preview-video-art"><span className="preview-play" aria-hidden="true">▶</span><span className="preview-video-tag">EDIT PREVIEW</span></div><div className="preview-project-info"><span className="preview-kicker">VIDEO EDITOR</span><strong>Brand style · 9:16</strong><span className="preview-line" /></div></div>
                <div className="preview-queue-title"><strong>Publishing workflow</strong><span>Sample layout</span></div>
                <div className="preview-queue-row"><span className="preview-row-icon">01</span><span><strong>Review campaign</strong><small>Schedule and account checks</small></span><span className="preview-state">In review</span></div>
                <div className="preview-queue-row"><span className="preview-row-icon preview-row-icon-muted">02</span><span><strong>Prepare next video</strong><small>Caption and cover</small></span><span className="preview-state preview-state-muted">Draft</span></div>
              </div>
            </div>
            <p className="preview-disclaimer">Illustrative preview · no live user or publishing data</p>
          </div>
          <span className="hero-orbit hero-orbit-one" aria-hidden="true" /><span className="hero-orbit hero-orbit-two" aria-hidden="true" />
        </div>
      </section>

      <ProductStory />

      <section className="trust-strip" aria-label="Workflow principles"><span>Private media handling</span><span>Official Meta authorization</span><span>Human review for uncertain outcomes</span></section>

      <section className="problem-solution-section content-section" aria-labelledby="problem-title">
        <div className="problem-copy"><p className="eyebrow">The coordination problem</p><h2 id="problem-title">The video is only one part of the work.</h2><p>When several clips move through a campaign, source files, trim choices, brand treatments, captions, covers, accounts, schedules and review states can end up scattered across folders and notes.</p><p>That makes it harder to answer simple questions: Which version is ready? Which cover was selected? Is the schedule confirmed? Did the provider confirm publishing, or is the result still uncertain?</p></div>
        <div className="problem-list"><article><span>01</span><p>Keep source clips and working versions straight.</p></article><article><span>02</span><p>Coordinate captions, covers, accounts and schedules.</p></article><article><span>03</span><p>Distinguish a plan from a confirmed publishing outcome.</p></article></div>
      </section>

      <section className="content-section intro-section" id="about" aria-labelledby="about-title">
        <div className="section-heading"><p className="eyebrow">What is ClipForge?</p><h2 id="about-title">A workspace for the work around the video.</h2></div>
        <div className="intro-copy"><p>Creators and clipping teams often prepare many short videos across accounts and campaigns. ClipForge is designed to keep source media, edits, captions, covers and schedules connected without losing track of what is ready.</p><p>Plan features and limits come from the current catalog. Some provider-dependent actions remain unavailable until the deployment and account meet their requirements.</p><a className="text-link" href="/about">More about ClipForge <span aria-hidden="true">→</span></a></div>
      </section>

      <section className="content-section feature-section" id="features" aria-labelledby="features-title">
        <div className="section-heading section-heading-centered"><p className="eyebrow">One connected workflow</p><h2 id="features-title">The details stay attached to the work.</h2><p>Prepare, review and organize from source video through campaign planning.</p></div>
        <div className="feature-grid">{FEATURES.map(([number, title, description]) => <article className="feature-card" key={number}><span className="feature-number">{number}</span><h3>{title}</h3><p>{description}</p></article>)}</div>
        <div className="feature-footnote"><span className="feature-footnote-icon" aria-hidden="true">i</span><p>Publishing is not guaranteed. Instagram account eligibility, permission state, media rules, quota and worker availability remain controlling checks.</p></div>
      </section>

      <section className="content-section walkthrough-section" aria-labelledby="walkthrough-title">
        <div className="section-heading section-heading-centered"><p className="eyebrow">Feature walkthrough</p><h2 id="walkthrough-title">See where each decision lives.</h2><p>These text-based interface maps reflect current product screens. They are not screenshots or live records; names, account details and metrics are not fabricated.</p></div>
        <div className="walkthrough-grid">{WALKTHROUGH.map(([title, summary, detail], index) => <article className="walkthrough-card" key={title}><div className="walkthrough-card-heading"><span>{String(index + 1).padStart(2, "0")}</span><h3>{title}</h3></div><WalkthroughPreview title={title} summary={summary} index={index} /><p>{detail}</p></article>)}</div>
      </section>

      <section className="content-section process-section" id="how-it-works" aria-labelledby="process-title">
        <div className="section-heading"><p className="eyebrow">How it works</p><h2 id="process-title">A straightforward path from upload to review.</h2><p>Each step keeps the next one visible without implying that an API action has already happened.</p></div>
        <ol className="process-list"><li><span>01</span><div><h3>Create an account and connect</h3><p>Connect an eligible Instagram professional account through the official authorization flow when the deployment supports it.</p></div></li><li><span>02</span><div><h3>Upload and organize</h3><p>Keep videos in a library or collection and manage access with explicit sharing permissions.</p></div></li><li><span>03</span><div><h3>Edit and prepare</h3><p>Trim and style videos, then prepare captions and Reel covers for the campaign.</p></div></li><li><span>04</span><div><h3>Schedule and track</h3><p>Review preflight checks and stored publishing states. Ambiguous outcomes stay in manual review.</p></div></li></ol>
        <a className="text-link" href="/how-it-works">Read the getting-started guide <span aria-hidden="true">→</span></a>
      </section>

      <section className="comparison-section" aria-labelledby="comparison-title"><div className="content-section"><div className="section-heading section-heading-centered"><p className="eyebrow">A more structured routine</p><h2 id="comparison-title">Less hunting. More visibility.</h2></div><div className="comparison-grid"><div className="comparison-card comparison-card-muted"><h3>Without a shared workspace</h3><ul><li>Clips and notes live in separate places</li><li>Preparation steps are easy to lose between tools</li><li>Campaign status needs to be tracked by hand</li></ul></div><div className="comparison-card comparison-card-featured"><h3>With ClipForge</h3><ul><li>Media, edits and collections stay organized</li><li>Campaign items keep their captions, covers and schedule</li><li>Stored outcomes and review needs are visible together</li></ul></div></div><p className="comparison-note">ClipForge organizes workflow; it does not promise reach, engagement, income or viral results.</p></div></section>

      <section className="content-section audience-section" aria-labelledby="audience-title"><div className="section-heading"><p className="eyebrow">Who it can help</p><h2 id="audience-title">For people coordinating short-form video work.</h2><p>ClipForge is a workflow tool. It does not promise earnings, audience growth or a particular publishing result.</p></div><div className="audience-grid"><article><h3>Creators</h3><p>Keep source media, visual edits and planned posts in one place while you make the creative decisions.</p></article><article><h3>Clippers</h3><p>Organize source videos and the trim ranges you select for the clips you prepare.</p></article><article><h3>Campaign teams</h3><p>Coordinate cycle items, captions, covers, schedules and review states.</p></article><article><h3>Agencies</h3><p>Use collection sharing and delegated permissions within the limits of the collection owner's plan.</p></article></div></section>

      <section className="content-section pricing-section" id="pricing" aria-labelledby="home-pricing-title"><div className="section-heading section-heading-centered"><p className="eyebrow">Plans from the current catalog</p><h2 id="home-pricing-title">Choose the pace that fits your workflow.</h2><p>Prices and selected limits below are read from ClipForge’s central plan catalog.</p></div><div className="home-plan-grid">{PLAN_IDS.map((id) => { const plan = PLAN_CATALOG[id]; return <article className={`home-plan-card${id === "pro" ? " home-plan-card-featured" : ""}`} key={id}><span className="plan-name">{plan.name}</span><strong className="home-plan-price">{formatPaiseAsRupees(plan.pricePaise.monthly)}<small> / month</small></strong><span className="home-plan-weekly">{formatPaiseAsRupees(plan.pricePaise.weekly)} weekly</span><ul><li>{formatCount(plan.limits.connectedAccounts)} connected account{plan.limits.connectedAccounts === 1 ? "" : "s"}</li><li>{formatStorage(plan.limits.storageBytes)} storage</li><li>{formatCount(plan.limits.activeCampaigns)} active campaign{plan.limits.activeCampaigns === 1 ? "" : "s"}</li><li>{plan.features.collectionSharing === "none" ? "No collection sharing" : plan.features.collectionSharing === "basic" ? "Basic collection sharing" : "Advanced collection sharing"}</li></ul><a className="button button-secondary" href="/pricing">{id === "free" ? "Explore free plan" : `Compare ${plan.name}`}</a></article>; })}</div><p className="pricing-note">Weekly and monthly billing are separate options. Checkout availability depends on current payment configuration.</p></section>

      <section className="content-section faq-preview" aria-labelledby="faq-preview-title"><div className="section-heading"><p className="eyebrow">Good to know</p><h2 id="faq-preview-title">Frequently asked questions.</h2></div><div className="faq-preview-grid"><article><h3>Does ClipForge automatically find clips?</h3><p>No. You choose the source media and trim ranges. ClipForge does not claim to discover highlight moments automatically.</p></article><article><h3>Does starting a cycle guarantee a Reel is published?</h3><p>No. A configured cycle must pass server preflight. Publishing also depends on an eligible connected Instagram account, valid Meta authorization, platform limits and worker availability.</p></article><article><h3>Can I publish without connecting Instagram?</h3><p>No. Publishing requires the official authorization flow and an eligible account. ClipForge never asks for your Instagram password.</p></article><article><h3>Are saved captions and covers already on Instagram?</h3><p>No. They are stored in ClipForge until a supported publishing operation succeeds. A saved setting alone is not evidence of provider delivery.</p></article><article><h3>Are shared videos copied into my library?</h3><p>No. Shared references preserve the owner's media. A separate authorized import flow can create a copy where the permission allows it.</p></article><article><h3>Are plan features available in every deployment?</h3><p>Prices and limits come from the central catalog. External integrations still depend on deployment configuration and provider approval.</p></article></div><a className="text-link" href="/help">Browse all help and FAQs <span aria-hidden="true">→</span></a></section>

      <section className="feedback-section" aria-labelledby="feedback-title"><div><p className="eyebrow">Keep the product honest</p><h2 id="feedback-title">No testimonials, just a clear product status.</h2><p>We do not publish invented reviews or customer counts. A public feedback form and support address are not configured in this build.</p></div><a className="button button-secondary" href="/contact">Contact information</a></section>
      <section className="final-cta" aria-labelledby="final-cta-title"><div><p className="eyebrow">A clearer next step</p><h2 id="final-cta-title">Ready to Organize Your Content Workflow?</h2><p>Explore the supported workflow, then create an account when the current deployment is ready for you.</p></div><div className="hero-actions"><a className="button button-primary" href="/register">Get Started <span aria-hidden="true">↗</span></a><a className="button button-secondary" href="/features">Explore Features</a></div></section>
    </div>
  );
}
