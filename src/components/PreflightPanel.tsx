import type { PreflightLevel, PreflightReport } from "../lib/domain/preflight.ts";

const LEVEL_TEXT: Record<PreflightLevel, string> = { ready: "Ready", recommendation: "Recommendation", action_required: "Action required", blocked: "Blocked" };

export function PreflightPanel({ report }: { report: PreflightReport }) {
  return (
    <section aria-labelledby="preflight-heading" className="preflight" data-overall={report.overall}>
      <h2 id="preflight-heading">Before you start: {LEVEL_TEXT[report.overall]}</h2>
      <p role="status">{report.canStart ? "You can start this cycle." : "Fix the items below before you can start."}</p>
      <ul>
        {report.checks.map((check) => (
          <li key={check.id} data-level={check.level}>
            <strong>{LEVEL_TEXT[check.level]}:</strong> {check.message}
            {check.itemIds.length > 0 && <span className="muted"> ({check.itemIds.length} item{check.itemIds.length === 1 ? "" : "s"})</span>}
          </li>
        ))}
      </ul>
      <p className="muted">This screen can only estimate publishing volume; published quota figures differ. The worker checks Instagram's account-specific content_publishing_limit immediately before each publish and blocks if the quota is full or unavailable. Reel media checks use the documented duration and size limits where source metadata is available.</p>
    </section>
  );
}
