// Renders the real page components (the same functions Next.js will call) to HTML, against sample data.
// Proves wiring, permissions and wording. It does NOT prove they run inside Next.js (not installed here).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { DEMO_USER_ID, DEMO_CYCLE_ID, seedDemoData } from "../src/server/demo-data.ts";
import { setRuntimeForTests, getRuntime, type Runtime } from "../src/server/runtime.ts";
import DashboardPage from "../app/(app)/dashboard/page.tsx";
import MediaPage from "../app/(app)/media/page.tsx";
import CollectionsPage from "../app/(app)/collections/page.tsx";
import CollectionPage from "../app/(app)/collections/[collectionId]/page.tsx";
import CyclesPage from "../app/(app)/cycles/page.tsx";
import CyclePage from "../app/(app)/cycles/[cycleId]/page.tsx";
import AppLayout from "../app/(app)/layout.tsx";
import LoginPage from "../app/login/page.tsx";
import RegisterPage from "../app/register/page.tsx";
import { NOW } from "./helpers.ts";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
let repo: MemoryRepository;
const runtimeFor = (userId: string | null, mode: Runtime["mode"] = "demo"): Runtime =>
  ({ mode, repo, currentUserId: async () => userId, newId: () => "x", now: () => NOW });

beforeEach(() => { repo = new MemoryRepository(); seedDemoData(repo, NOW); setRuntimeForTests(runtimeFor(DEMO_USER_ID)); });
afterEach(() => { setRuntimeForTests(null); delete process.env["CLIPFORGE_DEMO_MODE"]; delete (globalThis as { __clipforgeDemoRepo?: unknown }).__clipforgeDemoRepo; });

test("dashboard: plan, counts, four usage meters, and the monthly reset date", async () => {
  const out = html(await DashboardPage());
  assert.ok(out.includes("Your plan: <strong>Creator</strong>"));
  assert.ok(out.includes("<strong>30</strong> media files")); assert.ok(out.includes("<strong>2</strong> collections"));
  for (const label of ["Storage", "Processing minutes", "Exports", "Scheduled items"]) assert.ok(out.includes(label), label);
  assert.ok(out.includes("12 of 100 used"));          // scheduled items vs Creator's 100
});

test("dashboard reset date is the first of NEXT calendar month", async () => {
  const out = html(await DashboardPage());
  assert.match(out, /Usage resets on 1 July 2026/);
});

test("media library: first page has 24 rows, paging links work, bad page numbers are rejected politely", async () => {
  const page1 = html(await MediaPage({}));
  assert.equal((page1.match(/<tr>/g) ?? []).length - 1, 24); // minus the header row
  assert.ok(page1.includes("Showing 1-24 of 30")); assert.ok(page1.includes('href="/media?page=2"')); assert.ok(!page1.includes('rel="prev"'));
  const page2 = html(await MediaPage({ searchParams: Promise.resolve({ page: "2" }) }));
  assert.equal((page2.match(/<tr>/g) ?? []).length - 1, 6); assert.ok(page2.includes('rel="prev"')); assert.ok(!page2.includes('rel="next"'));
  for (const bad of ["0", "-1", "abc", "1.5", "99999999"]) assert.ok(html(await MediaPage({ searchParams: { page: bad } })).includes("page must be a whole number"), bad);
});

test("media library never shows other people's media or storage details", async () => {
  const out = html(await MediaPage({})) + html(await DashboardPage());
  assert.ok(!out.includes("Sample shared clip"));
  assert.ok(!/storageKey|s3:\/\/|amazonaws|https?:\/\/[^"]*\.(mp4|mov)/i.test(out));
});

test("collections: owned and shared-with-you are separate; permissions are explained in words", async () => {
  const out = html(await CollectionsPage());
  assert.ok(out.includes("Sample collection - Client A")); assert.ok(out.includes("Shared by link"));
  assert.ok(out.includes("Sample shared collection (use allowed)"));
  assert.ok(out.includes("You can: view, use in a publishing cycle."));
  assert.ok(out.includes("You can: view."));
});

test("collection detail: shared collection shows what you may do; a collection you cannot see looks missing", async () => {
  const shared = html(await CollectionPage({ params: Promise.resolve({ collectionId: "demo-shared-col-1" }) }));
  assert.ok(shared.includes("Use videos in a publishing cycle without copying them: yes"));
  assert.ok(shared.includes("Import an independent copy: no")); assert.ok(shared.includes("Download originals: no"));
  assert.ok(shared.includes("does not give you rights to redistribute"));
  assert.ok(shared.includes("Sample shared clip 1"));
  const viewOnly = html(await CollectionPage({ params: { collectionId: "demo-shared-col-2" } }));
  assert.ok(viewOnly.includes("Use videos in a publishing cycle without copying them: no"));
  // A different user cannot see someone's private collection - same message as a missing one.
  setRuntimeForTests(runtimeFor("eve"));
  const hidden = html(await CollectionPage({ params: { collectionId: "demo-col-1" } }));
  const missing = html(await CollectionPage({ params: { collectionId: "does-not-exist" } }));
  assert.equal(hidden, missing); assert.ok(hidden.includes("Not found")); assert.ok(!hidden.includes("Client A"));
});

test("revoked sharing disappears from the shared list and the detail page", async () => {
  repo.grants.find((g) => g.collectionId === "demo-shared-col-1")!.status = "revoked";
  assert.ok(!html(await CollectionsPage()).includes("use allowed"));
  assert.ok(html(await CollectionPage({ params: { collectionId: "demo-shared-col-1" } })).includes("Not found"));
});

test("cycles: overview counts and detail with preflight and the items table", async () => {
  const overview = html(await CyclesPage());
  assert.ok(overview.includes("Sample cycle (nothing is published)")); assert.ok(overview.includes("4 videos - 4 upcoming - 0 published"));
  const detail = html(await CyclePage({ params: Promise.resolve({ cycleId: DEMO_CYCLE_ID }) }));
  assert.ok(detail.includes("Draft (not started)")); assert.ok(detail.includes("Before you start"));
  assert.ok(detail.includes("Sample clip 01")); assert.ok(detail.includes("Shared with you"));
  assert.ok(detail.includes("Saved in ClipForge (not confirmed on Instagram)"));
  assert.ok(detail.includes("not available in the screens yet")); assert.ok(detail.includes("not connected"));
  assert.ok(!detail.includes("Applied on Instagram"));
});

test("cycle detail: someone else's cycle looks like a missing one", async () => {
  setRuntimeForTests(runtimeFor("eve"));
  assert.equal(html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } })), html(await CyclePage({ params: { cycleId: "nope" } })));
});

test("cycle detail reflects a revoked share: preflight turns Blocked", async () => {
  repo.grants.find((g) => g.collectionId === "demo-shared-col-1")!.status = "revoked";
  const detail = html(await CyclePage({ params: { cycleId: DEMO_CYCLE_ID } }));
  assert.ok(detail.includes("Blocked")); assert.ok(detail.includes("can no longer be used"));
});

test("not signed in: every data page asks you to sign in and shows no data", async () => {
  setRuntimeForTests(runtimeFor(null));
  for (const page of [DashboardPage(), MediaPage({}), CollectionsPage(), CyclesPage(), CollectionPage({ params: { collectionId: "demo-col-1" } }), CyclePage({ params: { cycleId: DEMO_CYCLE_ID } })]) {
    const out = html(await page);
    assert.ok(out.includes("Sign in required"), out.slice(0, 120)); assert.ok(!out.includes("Sample"));
  }
});

test("DEFAULT (no demo flag): nothing is faked - nobody is signed in and the database is unavailable", async () => {
  setRuntimeForTests(null);
  assert.equal(getRuntime().mode, "unconfigured");
  const out = html(await DashboardPage());
  assert.ok(out.includes("Sign in required")); assert.ok(!out.includes("Sample"));
  assert.ok(!html(<AppLayout><p>x</p></AppLayout>).includes("Demo mode"));
});

test("CLIPFORGE_DEMO_MODE=true switches to sample data and shows the demo banner on every app screen", async () => {
  setRuntimeForTests(null);
  process.env["CLIPFORGE_DEMO_MODE"] = "true";
  assert.equal(getRuntime().mode, "demo");
  assert.ok(html(await MediaPage({})).includes("Sample clip"));
  const layout = html(<AppLayout><p>child</p></AppLayout>);
  assert.ok(layout.includes("data-demo-banner")); assert.ok(layout.includes("SAMPLE data")); assert.ok(layout.includes("read-only previews"));
  for (const label of ["Dashboard", "Media library", "Collections", "Publishing cycles", "Plans"]) assert.ok(layout.includes(label));
  assert.ok(layout.includes('aria-label="App"'));
});

test("login and register: real fields and labels, but submit is disabled and says why; no fake success", async () => {
  setRuntimeForTests(null); // default mode: not demo, no authentication
  for (const [Page, heading] of [[LoginPage, "Sign in"], [RegisterPage, "Create your account"]] as const) {
    const out = html(await Page());
    assert.ok(out.includes(heading)); assert.ok(out.includes("not available yet")); assert.ok(/<button type="submit" disabled/.test(out));
    assert.ok(out.includes('type="email"') && out.includes('type="password"') && out.includes("required"));
    assert.ok(/<label>/.test(out)); assert.ok(out.includes('action="#"')); assert.ok(!out.includes("/api/auth/"));
  }
  const register = html(await RegisterPage());
  assert.ok(register.includes('autoComplete="new-password"') || register.includes('autocomplete="new-password"'));
  assert.ok(!html(await LoginPage()).includes("Demo mode is on"));
});
