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
      <p className="muted">We check Instagram's documented limit of 100 API-published posts per 24 hours (Content Publishing guide, updated Oct 20, 2026, read Nov 6, 2026). The same guide's carousel section still says 50. The live content_publishing_limit is not called. When a file has a duration or size, it is also checked against the documented Reel limits of 3 seconds to 15 minutes and 300MB.</p>
    </section>
  );
}
