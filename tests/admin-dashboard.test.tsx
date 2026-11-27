import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { PrismaAdminDataRepository } from "../src/server/admin/data-repository.ts";
import { AdminDataService } from "../src/server/admin/data-service.ts";
import { renderAdminUserDetailsPage, renderAdminUsersPage } from "../src/components/admin/AdminUsersPages.tsx";
import { renderAdminCampaignsPage, renderAdminCampaignDetailsPage } from "../src/components/admin/AdminCampaignsPages.tsx";
import { renderAdminInstagramAccountsPage, renderAdminInstagramAccountPage } from "../src/components/admin/AdminInstagramPages.tsx";
import { renderAdminBillingPage, renderAdminPaymentDetailsPage } from "../src/components/admin/AdminBillingPages.tsx";
import { renderAdminPlansPage } from "../src/components/admin/AdminPlansPage.tsx";
import { renderAdminAnalyticsPage } from "../src/components/admin/AdminAnalyticsPage.tsx";
import { renderAdminAuditDetailsPage, renderAdminAuditPage } from "../src/components/admin/AdminAuditPages.tsx";
import { buildAdminPlatformSettings } from "../src/server/admin/platform-settings.ts";
import OverviewPage from "../app/admin/(protected)/page.tsx";
import UsersPage from "../app/admin/(protected)/users/page.tsx";
import CampaignsPage from "../app/admin/(protected)/campaigns/page.tsx";
import InstagramPage from "../app/admin/(protected)/instagram/page.tsx";
import BillingPage from "../app/admin/(protected)/billing/page.tsx";
import PlansPage from "../app/admin/(protected)/plans/page.tsx";
import AnalyticsPage from "../app/admin/(protected)/analytics/page.tsx";
import ReportsPage from "../app/admin/(protected)/reports/page.tsx";
import SettingsPage from "../app/admin/(protected)/settings/page.tsx";
import ComplimentaryAccessPage from "../app/admin/(protected)/complimentary-access/page.tsx";

const now = new Date("2026-11-08T12:00:00.000Z");
const adminRuntime: Runtime = {
  mode: "unconfigured",
  repo: {} as Runtime["repo"],
  currentUserId: async () => "admin-id",
  currentPrincipal: async () => ({ userId: "admin-id", role: "admin" }),
  newId: () => "unused",
  now: () => now,
};

const pages: Array<{ name: string; href: string; label: string; render: () => Promise<ReactNode> }> = [
  { name: "Overview", href: "/admin", label: "Overview", render: OverviewPage },
  { name: "Users", href: "/admin/users", label: "Users", render: UsersPage },
  { name: "Campaigns", href: "/admin/campaigns", label: "Campaigns", render: CampaignsPage },
  { name: "Plans", href: "/admin/plans", label: "Plans", render: PlansPage },
  { name: "Complimentary access", href: "/admin/complimentary-access", label: "Complimentary access", render: ComplimentaryAccessPage },
  { name: "Analytics", href: "/admin/analytics", label: "Analytics", render: AnalyticsPage },
  { name: "Instagram", href: "/admin/instagram", label: "Instagram", render: InstagramPage },
  { name: "Billing", href: "/admin/billing", label: "Billing", render: BillingPage },
  { name: "Reports", href: "/admin/reports", label: "Reports", render: ReportsPage },
  { name: "Settings", href: "/admin/settings", label: "Settings", render: SettingsPage },
  { name: "Audit Logs", href: "/admin/audit", label: "Audit Logs", render: () => renderAdminAuditPage(Promise.resolve({})) },
];

afterEach(() => setRuntimeForTests(null));

test("every Admin dashboard section is protected, has an active navigation item, and labels its disconnected data", async () => {
  setRuntimeForTests(adminRuntime);
  for (const page of pages) {
    const html = renderToStaticMarkup(await page.render());
    const heading = page.name === "Instagram" ? "Instagram accounts" : page.name === "Billing" ? "Billing &amp; payments" : page.name === "Plans" ? "Plans &amp; entitlements" : page.name === "Settings" ? "Platform settings" : page.name;
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
    assert.match(html, new RegExp(`href="${page.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*aria-current="page"`));
    assert.match(html, /Live data not connected/);
    for (const label of ["Overview", "Users", "Campaigns", "Plans", "Complimentary access", "Instagram", "Billing", "Analytics", "Reports", "Settings", "Audit Logs"]) {
      assert.match(html, new RegExp(`>${label}<`), `${page.name} navigation is missing ${label}`);
    }
    if (page.name !== "Overview" && page.name !== "Users" && page.name !== "Campaigns" && page.name !== "Plans" && page.name !== "Complimentary access" && page.name !== "Instagram" && page.name !== "Billing" && page.name !== "Analytics" && page.name !== "Settings" && page.name !== "Audit Logs") assert.match(html, /No sample records shown/);
  }
});

test("Complimentary Access page exposes the protected grant and state-management workflow", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await ComplimentaryAccessPage());
  assert.match(html, /Admin Granted — Permanent Free Access/);
  assert.match(html, /Search by name, email or user ID/);
  assert.match(html, /Search users/);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*Complimentary access/);
});

test("Admin Users page renders validated search/filter controls and safe paginated user rows", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "user-1", name: "Asha", email: "asha@example.test", emailVerified: now, role: "user", createdAt: now, passwordHash: "must-not-render" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminUsersPage(Promise.resolve({ search: "Asha", verified: "true" })));
  assert.match(html, /Search by name, email or ID/);
  assert.match(html, /Email verification/);
  assert.match(html, /Asha/);
  assert.match(html, /asha@example\.test/);
  assert.match(html, /View profile/);
  assert.doesNotMatch(html, /must-not-render|passwordHash/);
});

test("Admin user detail page shows stored histories and never renders sensitive values", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "user-1", name: "Asha", email: "asha@example.test", emailVerified: now, role: "user", createdAt: now, passwordHash: "must-not-render" });
  db.socialAccount.rows.push({ id: "social-1", userId: "user-1", platform: "instagram", username: "asha.reels", accountType: "BUSINESS", grantedScopes: "scope_a", status: "connected", tokenExpiresAt: now, createdAt: now, encryptedAccessToken: "token-must-not-render" });
  db.publishingCycle.rows.push({ id: "cycle-1", ownerId: "user-1", name: "Spring", status: "draft", timezone: "Asia/Kolkata", createdAt: now, updatedAt: now, scheduleSettings: { private: true } });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminUserDetailsPage("user-1"));
  assert.match(html, /ACCOUNT PROFILE/);
  assert.match(html, /Connected accounts/);
  assert.match(html, /Publishing cycles/);
  assert.match(html, /No payment records are stored/);
  assert.match(html, /Stored records only/);
  assert.doesNotMatch(html, /must-not-render|token-must-not-render|scheduleSettings|encryptedAccessToken/);
});

test("Admin Campaigns page renders search, status filters and clear unavailable state", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await renderAdminCampaignsPage(Promise.resolve({ search: "spring", status: "running" })));
  assert.match(html, /Search campaign or owner ID/);
  assert.match(html, /All cycle statuses/);
  assert.match(html, /Campaign records are unavailable/);
  assert.match(html, /Read-only/);
});

test("Admin campaign detail page renders stored configuration and publishing state labels safely", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: now, passwordHash: "do-not-display" });
  db.publishingCycle.rows.push({ id: "cycle", ownerId: "owner", socialAccountId: "no-account", name: "Launch", status: "paused", finalReviewConfirmed: false, orderMode: "manual", repeatBehavior: "never", timezone: "Asia/Kolkata", scheduleSettings: { timeZone: "Asia/Kolkata", intervalMinutes: 60, postsPerInterval: 1, daysOfWeek: [1, 2], windowStart: "09:00", windowEnd: "10:00", dailyMax: 2, endDate: null, startDate: "2026-11-08" }, createdAt: now, updatedAt: now });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminCampaignDetailsPage("cycle"));
  assert.match(html, /Stored schedule and configuration/);
  assert.match(html, /Validated stored schedule/);
  assert.match(html, /Instagram account association/);
  assert.match(html, /No cycle items are stored/);
  assert.match(html, /No live Meta status was checked/);
  assert.doesNotMatch(html, /do-not-display|encryptedAccessToken|idempotencyKey|lockToken/);
});

test("Admin campaign history labels soft-deleted cycles and omits pause/resume controls", async () => {
  const db = new FakePrismaClient(); const deletedAt = new Date("2026-11-28T12:00:00.000Z");
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: now });
  db.publishingCycle.rows.push({ id: "deleted-cycle", ownerId: "owner", socialAccountId: "missing", name: "Retained history", status: "stopped", deletedAt,
    finalReviewConfirmed: true, orderMode: "manual", repeatBehavior: "never", timezone: "UTC", scheduleSettings: {}, createdAt: now, updatedAt: deletedAt });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const listing = renderToStaticMarkup(await renderAdminCampaignsPage(Promise.resolve({})));
  assert.match(listing, /Deleted/);
  const details = renderToStaticMarkup(await renderAdminCampaignDetailsPage("deleted-cycle"));
  assert.match(details, /Deleted at/);
  assert.doesNotMatch(details, /Cycle controls|Pause cycle|Resume cycle/);
});

test("Admin Instagram accounts page renders search, stored-status filters and unavailable state", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await renderAdminInstagramAccountsPage(Promise.resolve({ search: "owner", status: "connected" })));
  assert.match(html, /Search username, account ID or owner ID/);
  assert.match(html, /Stored connection status/);
  assert.match(html, /Meta is not contacted/);
  assert.match(html, /Instagram account records are unavailable/);
});

test("Admin Instagram account page distinguishes stored eligibility from live Meta verification", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: now });
  db.socialAccount.rows.push({ id: "ig", userId: "owner", platform: "instagram", username: "owner.ig", accountType: "BUSINESS", grantedScopes: "instagram_business_basic instagram_business_content_publish", status: "connected", tokenExpiresAt: new Date("2026-12-01T00:00:00.000Z"), createdAt: now, encryptedAccessToken: "never-render-this" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminInstagramAccountPage("ig"));
  assert.match(html, /Stored data only/);
  assert.match(html, /Stored fields meet the current local eligibility checks/);
  assert.match(html, /Current Meta status: not verified/);
  assert.match(html, /Restrictions/);
  assert.doesNotMatch(html, /never-render-this|encryptedAccessToken|instagram_business_content_publish.*extra_unknown/);
});

test("Admin Billing page offers separated stored-record views without sample financial data", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await renderAdminBillingPage(Promise.resolve({ view: "manual-access", search: "creator" })));
  assert.match(html, /Billing &amp; payments/);
  assert.match(html, /Subscription records/);
  assert.match(html, /Recurring checkout intents/);
  assert.match(html, /Manual payment intents/);
  assert.match(html, /Manual access periods/);
  assert.match(html, /Manual access grants are one-time paid periods/);
  assert.match(html, /No sample financial records are shown/);
  assert.match(html, /No provider is contacted/);
  assert.doesNotMatch(html, /₹\s?\d|\$\s?\d/);
});

test("Admin payment detail page labels unstored fees and refunds unavailable", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: now, passwordHash: "do-not-display" });
  db.paymentRecord.rows.push({ id: "payment", userId: "owner", amountPaise: 49900, currency: "INR", status: "authorized", providerPaymentId: "pay_ref_safe", providerSubscriptionId: null, subscriptionIntentId: null, manualPaymentIntentId: null, createdAt: now, webhookPayload: "private-provider-payload" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminPaymentDetailsPage("payment"));
  assert.match(html, /pay_ref_safe/);
  assert.match(html, /payment method is not stored/i);
  assert.match(html, /gateway transaction fees are not stored/i);
  assert.match(html, /refund records and refund amounts are not stored/i);
  assert.match(html, /Payment status alone is not treated as current access/);
  assert.doesNotMatch(html, /do-not-display|private-provider-payload|webhookPayload/);
});

test("Admin recurring intent view labels pending checkout separately from captured payment", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: now });
  db.razorpaySubscriptionIntent.rows.push({ id: "intent-safe-id", userId: "owner", planId: "creator", interval: "weekly", amountPaise: 49900, currency: "INR", status: "created", createdAt: now, updatedAt: now, providerSubscriptionId: "provider-private-id", checkoutUrl: "https://provider.invalid/secret" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminBillingPage(Promise.resolve({ view: "recurring-intents", status: "created" })));
  assert.match(html, /Checkout intents are stored attempts/);
  assert.match(html, /intent-safe-id/);
  assert.match(html, /creator · weekly/);
  assert.match(html, /created/);
  assert.doesNotMatch(html, /provider-private-id|provider\.invalid|secret/);
});

test("Admin Plans page separates configured features from stored user entitlement results", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "user-free", name: "Free User", email: "free@example.test", role: "user", createdAt: now });
  db.subscription.rows.push({ id: "sub-active", userId: "user-free", planId: "creator", interval: "weekly", status: "active", razorpaySubscriptionId: "provider-sub", currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"), cancelAtPeriodEnd: false, cancellationRequestedAt: null, createdAt: now, updatedAt: now });
  db.paymentRecord.rows.push({ id: "payment", userId: "user-free", providerPaymentId: "pay_verified", providerSubscriptionId: "provider-sub", amountPaise: 49900, currency: "INR", status: "captured", createdAt: now });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminPlansPage(Promise.resolve({ planId: "creator", status: "active", usersSearch: "free" })));
  assert.match(html, /Application-configured plan definitions/);
  assert.match(html, /Creator/);
  assert.match(html, /₹499/);
  assert.match(html, /₹1,999/);
  assert.match(html, /Configured on/);
  assert.match(html, /User entitlement summary/);
  assert.match(html, /recurring subscription/);
  assert.match(html, /configured features are not copied here as per-user grants/i);
  assert.doesNotMatch(html, /pay_verified|provider-sub/);
});

test("Admin Analytics page applies bounded dates, labels stored history and enables safe CSV export", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "u1", name: "Asha", email: "asha@example.test", role: "user", createdAt: now });
  db.publishingCycle.rows.push({ id: "cycle", ownerId: "u1", name: "Launch", status: "running", createdAt: now, updatedAt: now });
  db.publishingJob.rows.push({ id: "job", ownerId: "u1", cycleId: "cycle", cycleItemId: "item", attemptNumber: 1, stage: "published", outcome: "success", createdAt: now, startedAt: now, lockToken: "never-show" });
  db.paymentRecord.rows.push({ id: "payment", userId: "u1", providerPaymentId: "never-show", amountPaise: 100, currency: "INR", status: "captured", createdAt: now });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminAnalyticsPage(Promise.resolve({ from: "2026-11-01", to: "2026-11-08" })));
  assert.match(html, /Daily activity/);
  assert.match(html, /Published \(recorded\)/);
  assert.match(html, /historical status transitions/);
  assert.match(html, /Export CSV/);
  assert.match(html, /Current user entitlements by plan/);
  assert.match(html, /profit and net income are not calculated/i);
  assert.doesNotMatch(html, /never-show|INR\s+\d+|₹\s?\d/);
});

test("Admin Settings page is protected and distinguishes configuration from live verification", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await SettingsPage());
  assert.match(html, /Platform settings/);
  assert.match(html, /Configuration is not a connection check/);
  assert.match(html, /Live verification: Not performed/);
  assert.match(html, /Current plan catalog/);
  assert.match(html, /Creator/);
  assert.match(html, /₹499/);
  assert.match(html, /Private S3 storage is missing or incomplete; uploads fail closed/);
  assert.match(html, /Email delivery/);
  assert.match(html, /Automatic background scheduling/);
});

test("ordinary users cannot render the Admin Settings page", async () => {
  setRuntimeForTests({ ...adminRuntime, currentPrincipal: async () => ({ userId: "ordinary-user", role: "user" }) });
  await assert.rejects(SettingsPage(), (error: unknown) => (error as { digest?: string }).digest?.endsWith(";404"));
});

test("Admin Settings configuration snapshot redacts environment values and labels missing/incomplete services", () => {
  const snapshot = buildAdminPlatformSettings({
    NODE_ENV: "test",
    GOOGLE_CLIENT_ID: "google-client-secret-test-marker",
    GOOGLE_CLIENT_SECRET: "google-private-test-marker",
    GOOGLE_OAUTH_REDIRECT_URI: "https://example.test/api/auth/google/callback",
    INSTAGRAM_APP_ID: "ig-app-id-test-marker",
    INSTAGRAM_APP_SECRET: "ig-secret-test-marker",
    INSTAGRAM_OAUTH_REDIRECT_URI: "https://example.test/api/instagram/callback",
    INSTAGRAM_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64url"),
    RAZORPAY_KEY_ID: "rzp_test_fake_key",
    RAZORPAY_KEY_SECRET: "razorpay-secret-test-marker",
    RAZORPAY_WEBHOOK_SECRET: "webhook-secret-test-marker",
    RAZORPAY_PLAN_CREATOR_WEEKLY: "creator-weekly-test-marker",
    CLIPFORGE_SMTP_HOST: "smtp-host-test-marker",
    CLIPFORGE_SMTP_PASSWORD: "smtp-secret-test-marker",
    CLIPFORGE_EMAIL_PROVIDER: "smtp",
  });
  const serialized = JSON.stringify(snapshot);
  for (const marker of ["google-client-secret-test-marker", "google-private-test-marker", "ig-secret-test-marker", "razorpay-secret-test-marker", "webhook-secret-test-marker", "smtp-secret-test-marker", "smtp-host-test-marker", "creator-weekly-test-marker"]) {
    assert.equal(serialized.includes(marker), false, `${marker} leaked into the settings DTO`);
  }
  const groups = new Map(snapshot.groups.map((group) => [group.title, group.items]));
  const instagram = groups.get("Instagram / Meta") ?? [];
  assert.equal(instagram.find((entry) => entry.label === "Instagram OAuth configuration")?.state, "configured");
  const billing = groups.get("Razorpay") ?? [];
  assert.equal(billing.find((entry) => entry.label === "Recurring provider plans")?.state, "incomplete");
  const email = groups.get("Email & background jobs") ?? [];
  assert.equal(email.find((entry) => entry.label === "Email delivery")?.state, "incomplete");
  assert.equal(snapshot.plans.length, 4);
  assert.equal(snapshot.plans.find((plan) => plan.id === "creator")?.weekly, "₹499");
  assert.ok(snapshot.groups.flatMap((group) => group.items).every((entry) => entry.liveVerified === false));
});

test("Admin Audit Logs page filters stored allowlisted fields and event detail withholds metadata", async () => {
  const db = new FakePrismaClient();
  db.auditLog.rows.push({ id: "audit-1", actorId: "admin-id", action: "admin.account_reviewed", entityType: "User", entityId: "user-7", createdAt: now, metadata: { password: "private-audit-value" }, outcome: "sensitive-outcome" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => now);
  setRuntimeForTests({ ...adminRuntime, adminData: async () => service });
  const html = renderToStaticMarkup(await renderAdminAuditPage(Promise.resolve({ actorId: "admin-id", action: "account_reviewed", targetType: "User", targetId: "user-7", from: "2026-11-08", to: "2026-11-08" })));
  assert.match(html, /Audit Logs/);
  assert.match(html, /Actor ID/);
  assert.match(html, /Target type/);
  assert.match(html, /admin\.account_reviewed/);
  assert.match(html, /Admin action namespace/);
  assert.match(html, /Outcome/);
  assert.match(html, /View details/);
  assert.doesNotMatch(html, /private-audit-value|sensitive-outcome/);
  const detail = renderToStaticMarkup(await renderAdminAuditDetailsPage("audit-1"));
  assert.match(detail, /RECORDED EVENT/);
  assert.match(detail, /Metadata withheld/);
  assert.match(detail, /Historical actor roles and outcomes for older records are unavailable/);
  assert.doesNotMatch(detail, /private-audit-value|sensitive-outcome/);
});

test("overview presents unavailable summaries without invented figures or demo financial records", async () => {
  setRuntimeForTests(adminRuntime);
  const html = renderToStaticMarkup(await OverviewPage());
  assert.match(html, /Users/);
  assert.match(html, /Campaigns/);
  assert.match(html, /Instagram/);
  assert.match(html, /Billing/);
  assert.match(html, /Live data is unavailable/);
  assert.doesNotMatch(html, /₹|\$\s?\d|\b\d{2,}\s*(users|campaigns|payments)/i);
});
