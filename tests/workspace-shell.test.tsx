import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "../src/components/AppShell.tsx";
import { shouldShowPublicSiteChrome } from "../src/components/PublicSiteChrome.tsx";

test("workspace shell keeps existing account actions and navigation without the deployment notice", () => {
  const html = renderToStaticMarkup(<AppShell mode="database" signedIn googleConfigured activeTrialEndsAt={null}><h1>Workspace content</h1></AppShell>);
  for (const href of ["/dashboard", "/media", "/collections", "/cycles", "/instagram", "/editor", "/pricing", "/api/auth/logout", "/api/auth/google/start"]) assert.ok(html.includes(`href="${href}"`) || html.includes(`action="${href}"`), href);
  assert.match(html, /Workspace content/);
  assert.doesNotMatch(html, /This deployment is configured to store accounts/);
});

test("public marketing chrome is hidden only on workspace/admin paths", () => {
  for (const pathname of ["/dashboard", "/media/asset-1", "/collections", "/cycles/cycle-1", "/instagram", "/editor"]) assert.equal(shouldShowPublicSiteChrome(pathname), false, pathname);
  assert.equal(shouldShowPublicSiteChrome("/admin"), false);
  assert.equal(shouldShowPublicSiteChrome("/pricing"), true);
  assert.equal(shouldShowPublicSiteChrome("/"), true);
});
