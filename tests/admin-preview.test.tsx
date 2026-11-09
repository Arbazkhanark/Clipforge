import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_PREVIEW_PAGES } from "./fixtures/admin-preview.ts";
import { AdminPreviewPage } from "../src/components/admin/AdminPreviewPage.tsx";
import { ADMIN_PREVIEW_HOST, ADMIN_PREVIEW_PORT, assertAdminPreviewAllowed, renderAdminPreviewDocument } from "../src/server/admin/admin-preview-server.ts";

test("preview server policy fails closed in production and binds only to loopback", () => {
  assert.equal(ADMIN_PREVIEW_HOST, "127.0.0.1");
  assert.equal(ADMIN_PREVIEW_PORT, 4177);
  assert.throws(() => assertAdminPreviewAllowed("production"), /disabled in production/);
  assert.doesNotThrow(() => assertAdminPreviewAllowed("development"));
  assert.doesNotThrow(() => assertAdminPreviewAllowed(undefined));
});

test("every preview route renders a synthetic-data label and no real Admin route links", () => {
  for (const [pathname, data] of Object.entries(ADMIN_PREVIEW_PAGES)) {
    const html = renderToStaticMarkup(createElement(AdminPreviewPage, { pathname, data }));
    assert.match(html, /SYNTHETIC PREVIEW DATA/, pathname);
    assert.ok(html.includes(`<h1>${data.title.replaceAll("&", "&amp;")}</h1>`), pathname);
    assert.doesNotMatch(html, /href="\/admin(?:\/|"|\?)/, pathname);
    assert.doesNotMatch(html, /href="\/api\//, pathname);
  }
});

test("detail links stay inside the synthetic preview and unknown routes are unavailable", () => {
  const users = renderToStaticMarkup(createElement(AdminPreviewPage, { pathname: "/users", data: ADMIN_PREVIEW_PAGES["/users"] }));
  assert.match(users, /href="\/users\/preview-user-001"/);
  assert.equal(ADMIN_PREVIEW_PAGES["/admin"], undefined);
  assert.equal(ADMIN_PREVIEW_PAGES["/billing/unknown"], undefined);
  assert.equal(renderAdminPreviewDocument("/admin"), null);
});

test("Reports deliberately shows its current placeholder instead of fabricated report visuals", () => {
  const html = renderToStaticMarkup(createElement(AdminPreviewPage, { pathname: "/reports", data: ADMIN_PREVIEW_PAGES["/reports"] }));
  assert.match(html, /Reports remains a placeholder/);
  assert.match(html, /have not been implemented/);
  assert.match(html, /SYNTHETIC PREVIEW DATA/);
});

test("preview document is noindex and marks content synthetic", () => {
  const html = renderAdminPreviewDocument("/");
  assert.match(html ?? "", /name="robots" content="noindex,nofollow"/);
  assert.match(html ?? "", /SYNTHETIC PREVIEW DATA/);
});
