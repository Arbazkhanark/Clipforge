// src/components/PreflightPanel.tsx
import type { PreflightLevel, PreflightReport } from "../lib/domain/preflight.ts";

const LEVEL_TEXT: Record<PreflightLevel, string> = { ready: "Ready", recommendation: "Recommendation", action_required: "Action required", blocked: "Blocked" };

export function PreflightPanel({ report }: { report: PreflightReport }) {
  const ready = report.checks.filter((check) => check.level === "ready");
  const recommendations = report.checks.filter((check) => check.level === "recommendation");
  const required = report.checks.filter((check) => check.level === "action_required");
  const blocked = report.checks.filter((check) => check.level === "blocked");

  const list = (checks: typeof report.checks) => (
    <ul>{checks.map((check) => (
      <li key={check.id} data-level={check.level}>
        <strong>{LEVEL_TEXT[check.level]}:</strong> {check.message}
        {check.itemIds.length > 0 && <span className="muted"> ({check.itemIds.length} item{check.itemIds.length === 1 ? "" : "s"})</span>}
      </li>
    ))}</ul>
  );

  return (
    <section aria-labelledby="preflight-heading" className="preflight" data-overall={report.overall}>
      <div className="preflight-heading-row">
        <div><p className="cycles-eyebrow">PUBLISHING READINESS</p><h2 id="preflight-heading">{report.canStart ? "Ready for final review" : "Readiness check"}</h2></div>
        <span className={`preflight-state preflight-state-${report.overall}`}>{LEVEL_TEXT[report.overall]}</span>
      </div>
      <p className="preflight-status" role="status">{report.canStart ? "Checks are complete. Review the final video list before starting." : "Resolve the blockers below before starting this cycle."}</p>
      {ready.length > 0 && <details className="preflight-passed"><summary><span aria-hidden="true">✓</span> {ready.length} {ready.length === 1 ? "check" : "checks"} passed</summary>{list(ready)}</details>}
      {recommendations.length > 0 && <details className="preflight-recommendations"><summary>{recommendations.length} {recommendations.length === 1 ? "recommendation" : "recommendations"}</summary>{list(recommendations)}</details>}
      {required.length > 0 && <div className="preflight-required"><strong>Final review required</strong>{list(required)}</div>}
      {blocked.length > 0 && <div className="preflight-blocked"><h3>Blocked · {blocked.length}</h3>{list(blocked)}</div>}
      <details className="preflight-guidance"><summary>How publishing checks work</summary><p className="muted">This screen can only estimate publishing volume; published quota figures differ. The worker checks Instagram&apos;s account-specific content_publishing_limit immediately before each publish and blocks if the quota is full or unavailable. Reel media checks use the documented duration and size limits where source metadata is available.</p></details>
    </section>
  );
}
