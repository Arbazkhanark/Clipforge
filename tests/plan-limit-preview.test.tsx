import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import PlanLimitPreviewPage from "../app/plan-limit-preview/page.tsx";
import { isPlanLimitPreviewRequest, PLAN_LIMIT_PREVIEW_HEADER, planLimitPreviewEnabled, planLimitPreviewRequestHeaders } from "../src/lib/ui/plan-limit-preview.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const withPreviewEnv = async <T,>(work: () => Promise<T>): Promise<T> => {
  const env = process.env as unknown as Record<string, string | undefined>;
  const oldNodeEnv = env["NODE_ENV"];
  const oldDemoMode = env["CLIPFORGE_DEMO_MODE"];
  env["NODE_ENV"] = "development";
  env["CLIPFORGE_DEMO_MODE"] = "true";
  try { return await work(); }
  finally {
    if (oldNodeEnv === undefined) delete env["NODE_ENV"]; else env["NODE_ENV"] = oldNodeEnv;
    if (oldDemoMode === undefined) delete env["CLIPFORGE_DEMO_MODE"]; else env["CLIPFORGE_DEMO_MODE"] = oldDemoMode;
  }
};

test("preview guard requires development and demo mode", () => {
  assert.equal(planLimitPreviewEnabled({ NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" }), true);
  assert.equal(planLimitPreviewEnabled({ NODE_ENV: "production", CLIPFORGE_DEMO_MODE: "true" }), false);
  assert.equal(planLimitPreviewEnabled({ NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "false" }), false);
  assert.equal(isPlanLimitPreviewRequest("true", { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" }), true);
  assert.equal(isPlanLimitPreviewRequest("true", { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "false" }), false);
  assert.equal(isPlanLimitPreviewRequest(null, { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" }), false);
  assert.equal(PLAN_LIMIT_PREVIEW_HEADER, "x-clipforge-plan-limit-preview");
});

test("caller-supplied preview markers are removed from cycles, pricing, and API requests", () => {
  const env = { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" };
  for (const pathname of ["/cycles", "/pricing", "/api/media/file"]) {
    const requestHeaders = planLimitPreviewRequestHeaders(new Headers({ [PLAN_LIMIT_PREVIEW_HEADER]: "true" }), pathname, env);
    assert.equal(requestHeaders.has(PLAN_LIMIT_PREVIEW_HEADER), false, `${pathname} must not retain a spoofed marker`);
  }
});

test("proxy helper generates the preview marker only for the exact guarded route", () => {
  const incoming = new Headers({ [PLAN_LIMIT_PREVIEW_HEADER]: "spoofed" });
  assert.equal(planLimitPreviewRequestHeaders(incoming, "/plan-limit-preview", { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" }).get(PLAN_LIMIT_PREVIEW_HEADER), "true");
  for (const [pathname, env] of [
    ["/plan-limit-preview/extra", { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "true" }],
    ["/plan-limit-preview", { NODE_ENV: "production", CLIPFORGE_DEMO_MODE: "true" }],
    ["/plan-limit-preview", { NODE_ENV: "development", CLIPFORGE_DEMO_MODE: "false" }],
  ] as const) {
    const requestHeaders = planLimitPreviewRequestHeaders(incoming, pathname, env);
    assert.equal(requestHeaders.has(PLAN_LIMIT_PREVIEW_HEADER), false, `${pathname} must not receive a marker`);
  }
});

test("isolated preview shows deterministic Free plan cycle limit and stays within preview navigation", async () => {
  await withPreviewEnv(async () => {
    const out = html(await PlanLimitPreviewPage({ searchParams: Promise.resolve({ state: "limit" }) }));
    assert.ok(out.includes("Isolated visual QA · mock fixtures only"));
    assert.ok(out.includes("You’re at your cycle limit"));
    assert.ok(out.includes("<strong>1</strong><span>of</span><strong>1</strong>"));
    assert.ok(out.includes('href="/plan-limit-preview?state=plans"'));
    assert.ok(out.includes('href="/plan-limit-preview?state=normal"'));
    assert.ok(out.includes('aria-current="page">Cycle limit</a>'));
  });
});

test("plan comparison preview renders catalog plans, highlights Creator, and mounts no checkout actions", async () => {
  await withPreviewEnv(async () => {
    const out = html(await PlanLimitPreviewPage({ searchParams: Promise.resolve({ state: "plans" }) }));
    for (const plan of ["free", "creator", "pro", "agency"]) assert.ok(out.includes(`data-plan="${plan}"`));
    assert.ok(out.includes('data-plan="creator" data-resolves-cycle-limit="true"'));
    assert.ok(out.includes("Fits your cycle usage"));
    assert.ok(out.includes("Checkout is disabled in this visual preview."));
    assert.ok(!out.includes("checkout-actions"));
    assert.ok(out.includes('href="/plan-limit-preview?state=normal"'));
  });
});

test("expired preview uses an explicitly expired mock subscription", async () => {
  await withPreviewEnv(async () => {
    const out = html(await PlanLimitPreviewPage({ searchParams: Promise.resolve({ state: "expired" }) }));
    assert.ok(out.includes("Your plan has expired"));
    assert.ok(out.includes("Previously active: Creator"));
    assert.ok(out.includes("Subscription status: expired"));
    assert.ok(out.includes('data-preview-state="expired"'));
  });
});

test("normal active-plan preview shows Creator with available cycle capacity", async () => {
  await withPreviewEnv(async () => {
    const out = html(await PlanLimitPreviewPage({ searchParams: Promise.resolve({ state: "normal" }) }));
    assert.ok(out.includes('data-preview-state="normal"'));
    assert.ok(out.includes("Current plan"));
    assert.ok(out.includes("Creator"));
    assert.ok(out.includes("1 of 5"));
    assert.ok(out.includes('href="/plan-limit-preview?state=limit"'));
    assert.ok(!out.includes("Your plan has expired"));
  });
});

test("preview route fails closed in production and when demo mode is disabled", async () => {
  const env = process.env as unknown as Record<string, string | undefined>;
  const oldNodeEnv = env["NODE_ENV"];
  const oldDemoMode = env["CLIPFORGE_DEMO_MODE"];
  try {
    for (const [nodeEnv, demoMode] of [["production", "true"], ["development", "false"]]) {
      env["NODE_ENV"] = nodeEnv;
      env["CLIPFORGE_DEMO_MODE"] = demoMode;
      await assert.rejects(PlanLimitPreviewPage({}), (error: unknown) => {
        assert.match(String((error as { digest?: unknown }).digest), /NEXT_HTTP_ERROR_FALLBACK;404/);
        return true;
      });
    }
  } finally {
    if (oldNodeEnv === undefined) delete env["NODE_ENV"]; else env["NODE_ENV"] = oldNodeEnv;
    if (oldDemoMode === undefined) delete env["CLIPFORGE_DEMO_MODE"]; else env["CLIPFORGE_DEMO_MODE"] = oldDemoMode;
  }
});
