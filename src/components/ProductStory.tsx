const SCENES = [
  { number: "01", title: "Create", detail: "You record, plan, and choose what is worth sharing.", kind: "creator" },
  { number: "02", title: "Select and trim", detail: "You choose source moments and set each clip's trim range.", kind: "clips" },
  { number: "03", title: "Shape the look", detail: "Apply borders, backgrounds, framing, overlays, and saved styles.", kind: "edit" },
  { number: "04", title: "Plan the schedule", detail: "Arrange a configured cycle and review its publishing queue.", kind: "calendar" },
  { number: "05", title: "Track the outcome", detail: "See queued, attempted, provider-confirmed, failed, or review-needed states.", kind: "status" },
  { number: "06", title: "Stay in control", detail: "Focus elsewhere, then check the stored status and any action needed.", kind: "creator" },
] as const;

function CreatorGlyph() {
  return <svg className="story-creator-glyph" viewBox="0 0 96 76" role="img" aria-label="Illustration of a creator at a desk">
    <rect x="4" y="57" width="88" height="6" rx="3" fill="currentColor" opacity=".22" />
    <path d="M20 55h38v4H20z" fill="currentColor" opacity=".5" />
    <rect x="24" y="31" width="27" height="19" rx="3" fill="currentColor" opacity=".22" />
    <path d="M30 50v6m15-6v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <circle cx="69" cy="20" r="10" fill="currentColor" opacity=".68" />
    <path d="M53 48c1-13 7-19 16-19s16 7 17 19" fill="currentColor" opacity=".38" />
    <path d="M59 18c2-8 16-10 21-2" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    <rect x="6" y="11" width="25" height="16" rx="3" fill="currentColor" opacity=".12" />
    <path d="M12 19h13M12 23h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".55" />
  </svg>;
}

function SceneVisual({ kind }: { kind: (typeof SCENES)[number]["kind"] }) {
  if (kind === "creator") return <div className="story-visual story-creator"><CreatorGlyph /><span className="story-visual-note">Create · pause · review</span></div>;
  if (kind === "clips") return <div className="story-visual story-clips" aria-label="A source video selected into user-chosen trim segments"><div className="story-source"><i />Source video</div><span className="story-arrow" aria-hidden="true">→</span><div className="story-segments"><i /><i /><i /></div><small>You choose the moments</small></div>;
  if (kind === "edit") return <div className="story-visual story-edit" aria-label="Illustrative editor controls"><div className="story-frame"><span>Clip preview</span><b>Brand overlay</b></div><div className="story-edit-chips"><i>Border</i><i>Background</i><i>Saved style</i></div></div>;
  if (kind === "calendar") return <div className="story-visual story-calendar" aria-label="Illustrative publishing schedule"><div className="story-calendar-head"><b>Cycle schedule</b><span>Review before start</span></div><div className="story-calendar-grid">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <i key={day}>{day}</i>)}{["", "Reel", "", "Reel", "", "", "Reel", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].map((label, index) => <span key={index}>{label}</span>)}</div></div>;
  return <div className="story-visual story-status" aria-label="Publishing states are distinct"><span>Queued</span><b aria-hidden="true">→</b><span>Attempted</span><b aria-hidden="true">→</b><span>Provider confirmed</span><em>Uncertain outcomes stay in review</em></div>;
}

/** Static HTML and CSS only; the sequence is illustrative, contains no live records, and never publishes by itself. */
export function ProductStory() {
  return <section className="product-story" aria-labelledby="product-story-title">
    <header className="section-heading section-heading-centered"><p className="eyebrow">A creator-led workflow</p><h2 id="product-story-title">You Focus on Creating. ClipForge Helps Handle the Workflow.</h2><p>ClipForge organizes the steps you choose. You remain in control of edits, schedules, account eligibility, and what is actually published.</p></header>
    <ol className="story-scenes">{SCENES.map((scene) => <li className={`story-scene story-scene-${scene.number}`} key={scene.number}>
      <span className="story-scene-number">{scene.number}</span><SceneVisual kind={scene.kind} /><div className="story-scene-copy"><h3>{scene.title}</h3><p>{scene.detail}</p></div>
    </li>)}</ol>
    <p className="story-disclaimer">Illustrative sequence, not a live dashboard or a promise of unattended publishing. Scheduling requires a user-configured cycle and connected eligible Instagram account with valid Meta authorization; platform restrictions and provider outcomes still apply.</p>
  </section>;
}
