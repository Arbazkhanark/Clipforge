import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PreflightPanel } from "../src/components/PreflightPanel.tsx";
import type { PreflightReport } from "../src/lib/domain/preflight.ts";

test("preflight groups real ready results, recommendations, requirements and blockers separately", () => {
  const report: PreflightReport = {
    overall: "blocked",
    canStart: false,
    checks: [
      { id: "account", level: "ready", message: "Social account is connected.", itemIds: [] },
      { id: "caption", level: "recommendation", message: "One item has no caption.", itemIds: ["item-1"] },
      { id: "review", level: "action_required", message: "Review the final list.", itemIds: [] },
      { id: "media", level: "blocked", message: "Temporary media access is not configured.", itemIds: ["item-1"] },
    ],
  };
  const html = renderToStaticMarkup(<PreflightPanel report={report} />);
  assert.match(html, /1 check passed/);
  assert.match(html, /1 recommendation/);
  assert.match(html, /Final review required/);
  assert.match(html, /Blocked · 1/);
  assert.match(html, /Temporary media access is not configured/);
  assert.doesNotMatch(html.slice(html.indexOf("preflight-blocked")), /Social account is connected/);
  assert.match(html, /Resolve the blockers below before starting this cycle/);
});
