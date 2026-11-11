// Server-renders the UI components and pages to HTML and checks the result.
// This proves the markup and wording; it does NOT prove the app runs inside Next.js (not installed here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { PricingTable } from "../src/components/PricingTable.tsx";
import { UsageMeter } from "../src/components/UsageMeter.tsx";
import { CycleItemsTable } from "../src/components/CycleItemsTable.tsx";
import { CycleScheduleForm } from "../src/components/CycleScheduleForm.tsx";
import { PreflightPanel } from "../src/components/PreflightPanel.tsx";
import { SchedulePreview } from "../src/components/SchedulePreview.tsx";
import { ImportWarning } from "../src/components/ImportWarning.tsx";
import { InstagramAccountsView } from "../src/components/InstagramAccounts.tsx";
import { StatusBadge } from "../src/components/StatusBadge.tsx";
import { countNoun, formatStorage } from "../src/components/format.ts";
import { DashboardView } from "../src/components/DashboardView.tsx";
import { runPreflight } from "../src/lib/domain/preflight.ts";
import { describeUsageReset } from "../src/lib/domain/usage-accounting.ts";
import { generateSlots } from "../src/lib/domain/schedule.ts";
import { CYCLE_ITEM_STATUSES } from "../src/lib/domain/types.ts";
import { makeItem, makeCycle, NOW } from "./helpers.ts";
import { AuthForm } from "../src/components/AuthForm.tsx";
import { FLASH_ERRORS, FLASH_NOTICES } from "../src/server/flash.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import LoginPage from "../app/login/page.tsx";
import RegisterPage from "../app/register/page.tsx";
import { withoutDatabaseEnv } from "./helpers/isolated-database.ts";
import HomePage from "../app/page.tsx";
import PricingPage from "../app/pricing/page.tsx";
import RootLayout from "../app/layout.tsx";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

test("pricing table shows the exact agreed prices for every plan, weekly and monthly", () => {
  const out = html(<PricingTable />);
  for (const price of ["₹0", "₹499", "₹1,999", "₹999", "₹3,999", "₹1,499", "₹5,999"]) assert.ok(out.includes(price), `missing ${price}`);
  for (const plan of ["free", "creator", "pro", "agency"]) assert.ok(out.includes(`data-plan="${plan}"`));
  // Creator keeps basic sharing + direct use + Mix/Unmix; advanced is for Pro/Agency.
  assert.match(out, /data-plan="creator"[\s\S]*Basic sharing, direct use of shared videos, Mix\/Unmix/);
  assert.match(out, /data-plan="pro"[\s\S]*Advanced sharing/);
});

test("pricing: separate renewal choices are disabled until sandbox configuration is ready", () => {
  const out = html(<PricingTable />);
  assert.ok(out.includes("Checkout stays unavailable until the relevant payment configuration is complete."));
  assert.equal((out.match(/disabled/g) ?? []).length, 15);
  assert.ok(out.includes("type=\"checkbox\""));
  assert.ok(out.includes("No automatic deductions"));
  assert.ok(!out.includes("Choose Pro"));
  const enabled = html(<PricingTable subscriptionPurchasable={true} manualPurchasable={true} />);
  assert.ok(enabled.includes("Subscribe monthly"));
  assert.ok(enabled.includes("Pay once monthly"));
});

test("usage meter: ok / warning / over states, formatted storage, and the monthly reset notice", () => {
  const notice = describeUsageReset(NOW, "Asia/Kolkata");
  const ok = html(<UsageMeter label="Exports" used={10} limit={100} resetNotice={notice} />);
  assert.ok(ok.includes('data-state="ok"')); assert.ok(ok.includes("1 July 2026")); assert.ok(ok.includes("10 of 100 used"));
  assert.ok(html(<UsageMeter label="Exports" used={85} limit={100} />).includes('data-state="warning"'));
  const over = html(<UsageMeter label="Storage" used={6 * 1024 ** 3} limit={5 * 1024 ** 3} formatValue={formatStorage} />);
  assert.ok(over.includes('data-state="over"')); assert.ok(over.includes("6 GB of 5 GB")); assert.ok(over.includes('role="alert"'));
});

test("every cycle item status has a text label", () => {
  for (const status of CYCLE_ITEM_STATUSES) assert.match(html(<StatusBadge status={status} />), new RegExp(`data-status="${status}">[A-Z]`));
});

test("cycle table: only upcoming/scheduled items are selectable; honest cover wording; reasons explained", () => {
  const items = [
    makeItem({ id: "pub", status: "published", position: 1, mediaAssetId: "m1" }),
    makeItem({ id: "up", status: "upcoming", position: 2, mediaAssetId: "m2", captionText: "Hello", coverState: "saved_internally", coverMediaId: "c" }),
    makeItem({ id: "rev", status: "needs_review", position: 3, mediaAssetId: "m3", reviewReason: "source_removed" }),
    makeItem({ id: "busy", status: "publishing", position: 4, mediaAssetId: "m4" }),
  ];
  const out = html(<CycleItemsTable items={items} mediaTitles={{ m1: "Clip A", m2: "Clip B", m3: "Clip C", m4: "Clip D" }} timeZone="Asia/Kolkata" />);
  assert.equal((out.match(/type="checkbox"/g) ?? []).length, 1);
  assert.ok(out.includes('value="up"'));
  assert.ok(out.includes("Saved in ClipForge (not confirmed on Instagram)"));
  assert.ok(!out.includes("Applied on Instagram"));
  assert.ok(out.includes("The owner removed the source video."));
  assert.ok(out.includes("Shared with you"));
  assert.ok(html(<CycleItemsTable items={[]} mediaTitles={{}} timeZone="UTC" />).includes("no videos yet"));
});

test("cycle table escapes captions and titles (no script injection)", () => {
  const evil = '<script>alert("x")</script>';
  const out = html(<CycleItemsTable items={[makeItem({ captionText: evil, mediaAssetId: "m" })]} mediaTitles={{ m: evil }} timeZone="UTC" />);
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("cycle table shows scheduled time in the user's time zone, and missing media as unavailable", () => {
  const item = makeItem({ status: "scheduled", scheduledFor: new Date("2026-06-01T03:30:00Z"), mediaAssetId: "gone" });
  const out = html(<CycleItemsTable items={[item]} mediaTitles={{}} timeZone="Asia/Kolkata" />);
  assert.ok(out.includes("9:00 am") || out.includes("9:00 AM")); assert.ok(out.includes("Unavailable video"));
});

test("cycle schedule UI shows editable settings, a planned preview, and validation state", () => {
  const todayParts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = `${todayParts.find((part) => part.type === "year")!.value}-${todayParts.find((part) => part.type === "month")!.value}-${todayParts.find((part) => part.type === "day")!.value}`;
  const out = html(<CycleScheduleForm cycleId="cycle1" items={[{ id: "i1", position: 1, title: "First Reel.mp4" }]} initialSchedule={null} initialStartDate={today} timeZone="Asia/Kolkata" editable />);
  for (const label of ["Start date", "Time zone", "Preferred publishing time", "Interval between publishing times (minutes)", "Publishing days", "Maximum per day (optional)", "Save Schedule", "Preview schedule", "Upcoming Reels preview", "First Reel.mp4", "planned dates in ClipForge only"]) assert.ok(out.includes(label), `missing ${label}`);
  assert.ok(out.includes("name=\"timeZone\"")); assert.ok(out.includes("name=\"daysOfWeek\""));
  const invalid = html(<CycleScheduleForm cycleId="cycle1" items={[]} initialSchedule={{ timeZone: "Asia/Kolkata", intervalMinutes: 0, postsPerInterval: 1, daysOfWeek: [], windowStart: "09:00", windowEnd: "09:00", dailyMax: null, endDate: null, startDate: today }} initialStartDate={today} timeZone="Asia/Kolkata" editable />);
  assert.match(invalid, /disabled=""/);
  assert.ok(invalid.includes("no editable videos to schedule yet"));
});

test("preflight panel shows level text, counts, and the unverified-limits note", () => {
  const items = [makeItem({ id: "a", captionText: "" })];
  const report = runPreflight({ cycle: makeCycle({ status: "draft" }), items, socialAccountStatus: "token_expired", scheduledItemsPerMonthLimit: 100, scheduledItemsUsedThisMonth: 0, coverSupport: "unknown", sourceAccessByItemId: { a: { allowed: true, reason: "ok" } } });
  const out = html(<PreflightPanel report={report} />);
  assert.ok(out.includes("Blocked")); assert.ok(out.includes("Fix the items below")); assert.ok(out.includes("content_publishing_limit"));
  const ready = html(<PreflightPanel report={{ overall: "ready", canStart: true, checks: [] }} />);
  assert.ok(ready.includes("You can start this cycle."));
});

test("schedule preview lists times in the chosen zone and warns about unplaced videos", () => {
  const { slots, unfilled } = generateSlots({ startFrom: new Date("2026-06-01T00:00:00Z"), count: 5, settings: { timeZone: "Asia/Kolkata", intervalMinutes: 60, postsPerInterval: 1, daysOfWeek: [1], windowStart: "09:00", windowEnd: "10:00", dailyMax: null, endDate: "2026-06-01" } });
  const out = html(<SchedulePreview slots={slots} unfilled={unfilled} timeZone="Asia/Kolkata" />);
  assert.equal((out.match(/<time /g) ?? []).length, 2);
  assert.ok(out.includes("3 videos did not get a time")); assert.ok(out.includes("not an account quota check")); assert.ok(out.includes("content_publishing_limit"));
});

test("import warning shows every required warning and a required checkbox", () => {
  const out = html(<ImportWarning videoTitle="Clip <B>" sizeBytes={2 * 1024 ** 3} action="/import" />);
  for (const text of ["independent copy", "may later remove or revoke", "does not transfer copyright", "2 GB"]) assert.ok(out.includes(text), text);
  assert.ok(out.includes("required")); assert.ok(out.includes("Clip &lt;B&gt;"));
});

test("Instagram page shows connect and disconnect without a password or token", () => {
  const out = html(<InstagramAccountsView configured={false} accounts={[{ id: "acct-1", username: "ada.clips", status: "connected", accountType: "BUSINESS", grantedScopes: ["instagram_business_content_publish"], tokenExpiresAt: "2026-08-01", hasToken: true, eligibilityStatus: "missing_permissions" }]} />);
  for (const text of ["Connect Instagram", "not configured", "@ada.clips", "Disconnect", "required", "missing required permissions"]) assert.ok(out.includes(text), text);
  assert.equal(out.includes("type=\"password\""), false);
});

test("pages render: home is honest, pricing uses the catalog, layout is accessible", async () => {
  const home = html(<HomePage />);
  assert.ok(home.includes("You Focus on Creating."));
  assert.ok(home.includes("We do not publish invented reviews or customer counts."));
  assert.ok(!/trusted by|\d+\+ (creators|users)/i.test(home));
  assert.ok(html(<PricingPage />).includes("₹3,999"));
  await withoutDatabaseEnv(async () => {
    setRuntimeForTests(null);
    const layout = html(await RootLayout({ children: <p>child</p> }));
    assert.ok(layout.includes('<html lang="en">')); assert.ok(layout.includes("Skip to main content")); assert.ok(layout.includes('aria-label="Main"')); assert.ok(layout.includes("<p>child</p>"));
    assert.ok(layout.includes('href="/login"')); assert.ok(layout.includes("Sign in")); assert.ok(!layout.includes("Signed in"));
  });
});

test("registration and sign-in copy matches database, local memory, and unconfigured modes", async () => {
  const outbox = html(<AuthForm mode="register" demoMode={false} available persistence="database" emailDelivery="outbox" />);
  assert.ok(outbox.includes('data-auth-mode="database-outbox"'));
  assert.ok(outbox.includes("No email provider is connected"));
  assert.ok(outbox.includes("confirmation and password-reset messages are unavailable"));
  assert.ok(outbox.includes("new accounts remain unverified"));
  assert.ok(!outbox.includes("stays unverified"));
  assert.ok(!/we sent/i.test(outbox));
  const unavailable = html(<AuthForm mode="login" demoMode={false} available persistence="database" emailDelivery="unavailable" />);
  assert.ok(unavailable.includes('data-auth-mode="database"'));
  assert.ok(unavailable.includes("no message is sent"));
  assert.ok(unavailable.includes("stays unverified"));
  const local = html(<AuthForm mode="login" demoMode={false} available persistence="memory" />);
  assert.ok(local.includes('data-auth-mode="local"'));
  assert.ok(local.includes("Local development accounts live in server memory"));
  assert.ok(local.includes("No email provider is connected"));
  assert.ok(local.includes("verification and password-reset messages are unavailable"));
  const off = html(<AuthForm mode="register" demoMode={false} available={false} />);
  assert.ok(off.includes("not available yet"));
  assert.ok(/<button type="submit" disabled/.test(off));
  assert.ok(FLASH_NOTICES.registered.includes("no confirmation message was sent"));
  assert.ok(!/we sent/i.test(FLASH_NOTICES.registered));
  assert.ok(FLASH_ERRORS.email_not_verified.includes("no confirmation message was sent"));
  const runtime = { mode: "database", emailDelivery: "outbox", auth: {}, currentUserId: async () => null, repo: {}, newId: () => "x", now: () => new Date(0) } as Runtime;
  await withoutDatabaseEnv(async () => {
    setRuntimeForTests(runtime);
    try {
      assert.ok(html(await LoginPage({})).includes('data-auth-mode="database-outbox"'));
      assert.ok(html(await RegisterPage({})).includes('data-auth-mode="database-outbox"'));
      setRuntimeForTests({ ...runtime, emailDelivery: "unavailable" });
      assert.ok(html(await LoginPage({})).includes('data-auth-mode="database"'));
      assert.ok(html(await LoginPage({})).includes("stays unverified"));
    } finally { setRuntimeForTests(null); }
  });
});

test("counts use the singular when there is one", () => {
  assert.equal(countNoun(1, "collection"), "collection");
  assert.equal(countNoun(0, "collection"), "collections");
  assert.equal(countNoun(2, "media file", "media files"), "media files");
  const one = html(<DashboardView data={{ planId: "free", planName: "Free", timeZone: "UTC", resetNotice: "Resets monthly.", usage: { storage: { used: 0, limit: 1 }, processingMinutes: { used: 0, limit: 1 }, exports: { used: 0, limit: 1 }, scheduledItems: { used: 0, limit: 1 } }, counts: { media: 1, collections: 1, cycles: 1, runningCycles: 0 }, campaigns: [], statusFilter: "all" }} />);
  assert.ok(one.includes("<strong>1</strong> media file")); assert.ok(!one.includes("media files"));
  assert.ok(one.includes("<strong>1</strong> collection")); assert.ok(!one.includes("collections"));
  assert.ok(one.includes("<strong>1</strong> publishing cycle")); assert.ok(!one.includes("publishing cycles"));
});
