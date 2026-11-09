import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { PrismaAdminDataRepository } from "../src/server/admin/data-repository.ts";
import { AdminDataService, parseAdminListQuery, parseAdminAnalyticsDateRange, parseAdminAuditQuery } from "../src/server/admin/data-service.ts";
import { createAdminDataRoute, createAdminOverviewRoute, createAdminUserDetailRoute, createAdminCycleDetailRoute, createAdminInstagramAccountDetailRoute, createAdminPaymentDetailRoute, createAdminPlanEntitlementsRoute, createAdminAnalyticsRoute, createAdminAnalyticsCsvRoute, createAdminAuditDetailRoute } from "../src/server/admin/data-routes.ts";
import type { Runtime } from "../src/server/runtime.ts";

const at = new Date("2026-11-08T12:00:00.000Z");

function seed(db: FakePrismaClient) {
  db.user.rows.push(
    { id: "u1", name: "Asha", email: "asha@example.test", emailVerified: at, role: "user", createdAt: at, passwordHash: "must-not-return" },
    { id: "u2", name: "Ravi", email: "ravi@example.test", emailVerified: null, role: "user", createdAt: at },
    { id: "admin", name: "Admin", email: "admin@example.test", emailVerified: at, role: "admin", createdAt: at, passwordHash: "must-not-return" },
  );
  db.publishingCycle.rows.push({ id: "c1", ownerId: "u1", name: "Launch", status: "running", timezone: "Asia/Kolkata", createdAt: at, updatedAt: at, scheduleSettings: { private: true } });
  db.cycleItem.rows.push({ id: "i1", cycleId: "c1", position: 1, status: "scheduled", scheduledFor: at, createdAt: at });
  db.socialAccount.rows.push({ id: "s1", userId: "u1", platform: "instagram", username: "asha.reels", accountType: "BUSINESS", grantedScopes: "instagram_business_content_publish", status: "connected", tokenExpiresAt: at, createdAt: at, encryptedAccessToken: "must-not-return" });
  db.publishingJob.rows.push({ id: "j1", ownerId: "u1", cycleId: "c1", cycleItemId: "i1", socialAccountId: "s1", stage: "published", outcome: "success", lockToken: "must-not-return", errorDetails: "private provider payload", idempotencyKey: "key", attemptNumber: 1, startedAt: at, createdAt: at });
  db.paymentRecord.rows.push({ id: "p1", userId: "u1", amountPaise: 49900, currency: "INR", status: "captured", providerPaymentId: "pay_1", providerSubscriptionId: null, createdAt: at, secretPayload: "must-not-return" });
  db.auditLog.rows.push({ id: "a1", actorId: "admin", action: "account.provisioned", entityType: "user", entityId: "u1", createdAt: at, metadata: { token: "must-not-return" } });
}

function makeService(db = new FakePrismaClient()) {
  return { db, service: new AdminDataService(new PrismaAdminDataRepository(db), () => at) };
}

test("Admin user listing is cross-user, paginated, searchable, and excludes privileged fields and admin accounts", async () => {
  const { db, service } = makeService(); seed(db);
  const page = await service.listUsers(parseAdminListQuery(new URL("http://local/?page=1&pageSize=1&search=asha")));
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.id, "u1");
  assert.equal(page.items.length, 1);
  assert.equal("passwordHash" in page.items[0]!, false);
  assert.equal("sessions" in page.items[0]!, false);
});

test("Admin campaign and Instagram listings join safe owner summaries without exposing tokens or worker locks", async () => {
  const { db, service } = makeService(); seed(db);
  const campaigns = await service.listCycles(parseAdminListQuery(new URL("http://local/?status=running"), { status: new Set(["running"]) }));
  assert.equal(campaigns.total, 1);
  assert.deepEqual({ ownerEmail: campaigns.items[0]?.ownerEmail, itemCount: campaigns.items[0]?.itemCount, scheduled: campaigns.items[0]?.scheduledItemCount }, { ownerEmail: "asha@example.test", itemCount: 1, scheduled: 1 });
  assert.equal("scheduleSettings" in campaigns.items[0]!, false);
  const accounts = await service.listSocialAccounts(parseAdminListQuery(new URL("http://local/?search=asha")));
  assert.equal(accounts.total, 1);
  assert.equal(accounts.items[0]?.username, "asha.reels");
  assert.equal(accounts.items[0]?.permissionStatus, "incomplete");
  assert.deepEqual(accounts.items[0]?.missingRequiredScopes, ["instagram_business_basic"]);
  assert.equal(accounts.items[0]?.tokenStored, true);
  assert.equal("grantedScopes" in accounts.items[0]!, false);
  assert.equal("encryptedAccessToken" in accounts.items[0]!, false);
  assert.equal("accessToken" in accounts.items[0]!, false);
});

test("billing and audit DTOs use explicit safe fields and do not expose payload metadata", async () => {
  const { db, service } = makeService(); seed(db);
  const payments = await service.listPayments(parseAdminListQuery(new URL("http://local/?status=captured"), { status: new Set(["captured"]) }));
  assert.equal(payments.total, 1);
  assert.equal(payments.items[0]?.amountPaise, 49900);
  assert.equal("secretPayload" in payments.items[0]!, false);
  const audits = await service.listAudit(parseAdminListQuery(new URL("http://local/?search=provisioned")));
  assert.equal(audits.total, 1);
  assert.equal("metadata" in audits.items[0]!, false);
});

test("audit filters, bounded pagination, actor labels and event details expose allowlisted fields only", async () => {
  const { db, service } = makeService(); seed(db);
  db.auditLog.rows.push(
    { id: "a2", actorId: "admin-2", action: "admin.user_reviewed", entityType: "User", entityId: "u2", createdAt: new Date("2026-11-07T12:00:00Z"), metadata: { providerPayload: "never-return" }, outcome: "secret-outcome" },
    { id: "a3", actorId: null, action: "system.cleanup", entityType: "MediaAsset", entityId: "m1", createdAt: new Date("2026-11-06T12:00:00Z"), metadata: { token: "never-return" } },
  );
  const query = parseAdminAuditQuery(new URL("http://local/?actorId=admin&action=user_reviewed&targetType=user&targetId=u2&from=2026-11-07&to=2026-11-08&page=1&pageSize=1"));
  const page = await service.listAudit(query);
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.id, "a2");
  assert.equal(page.items[0]?.actorKind, "admin_action_namespace");
  assert.equal(page.items[0]?.outcome, "not_stored");
  assert.equal("metadata" in page.items[0]!, false);
  const details = await service.getAuditDetails("a2");
  assert.equal(details?.metadata, "withheld");
  assert.equal(details?.historicalActorRole, "not_stored");
  assert.equal(details?.outcomeStatus, "not_stored");
  const systemEvent = await service.getAuditDetails("a3");
  assert.equal(systemEvent?.event.actorKind, "system_or_actor_unavailable");
  assert.doesNotMatch(JSON.stringify({ page, details, systemEvent }), /never-return|secret-outcome|providerPayload|token/);
  assert.throws(() => parseAdminAuditQuery(new URL("http://local/?action=x&from=2026-11-08")));
  assert.throws(() => parseAdminAuditQuery(new URL("http://local/?unexpected=x")));
  assert.throws(() => parseAdminAuditQuery(new URL("http://local/?action=x&action=y")));
  assert.throws(() => parseAdminAuditQuery(new URL("http://local/?from=2026-02-30&to=2026-03-01")));
});

test("audit API requires Admin authorization and detail endpoint returns only safe event fields", async () => {
  const { db, service } = makeService(); seed(db);
  const url = "http://localhost/api/admin/audit?actorId=admin&action=provisioned";
  assert.equal((await createAdminDataRoute("audit", () => runtimeWith("user", service))(new Request(url))).status, 403);
  const response = await createAdminDataRoute("audit", () => runtimeWith("admin", service))(new Request(url));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /account\.provisioned/);
  assert.doesNotMatch(text, /must-not-return|metadata|passwordHash/);
  const detailRoute = createAdminAuditDetailRoute(() => runtimeWith("admin", service));
  const detail = await detailRoute(new Request("http://localhost/api/admin/audit/a1"));
  assert.equal(detail.status, 200);
  const detailText = await detail.text();
  assert.match(detailText, /withheld/);
  assert.doesNotMatch(detailText, /must-not-return|token/);
  assert.equal((await createAdminAuditDetailRoute(() => runtimeWith("user", service))(new Request("http://localhost/api/admin/audit/a1"))).status, 403);
});

test("Admin billing lists paginate stored payments, subscriptions and manual access separately", async () => {
  const { db, service } = makeService(); seed(db);
  db.paymentRecord.rows[0]!.subscriptionIntentId = "recurring-intent";
  db.paymentRecord.rows[0]!.providerSubscriptionId = "sub_ref_1";
  db.razorpaySubscriptionIntent.rows.push({ id: "recurring-intent", userId: "u1", planId: "creator", interval: "weekly", amountPaise: 49900, currency: "INR", status: "active", providerSubscriptionId: "sub_ref_1", createdAt: at, updatedAt: at, checkoutUrl: "private-checkout-url" });
  db.subscription.rows.push({ id: "current-subscription", userId: "u1", planId: "creator", interval: "weekly", status: "active", currentPeriodEnd: at, cancelAtPeriodEnd: false, cancellationRequestedAt: null, createdAt: at, updatedAt: at, razorpaySubscriptionId: "sub_ref_1" });
  db.manualPaymentIntent.rows.push({ id: "manual-intent", userId: "u1", planId: "pro", interval: "monthly", amountPaise: 399900, currency: "INR", status: "paid", accessStartsAt: at, accessEndsAt: at, createdAt: at, updatedAt: at });
  db.manualPlanAccess.rows.push({ id: "manual-access", userId: "u1", intentId: "manual-intent", providerPaymentId: "pay_manual_1", planId: "pro", startsAt: at, expiresAt: new Date("2026-12-08T12:00:00Z"), createdAt: at });
  const payments = await service.listPayments(parseAdminListQuery(new URL("http://local/?search=pay_1&pageSize=1")));
  assert.equal(payments.total, 1);
  assert.equal(payments.items[0]?.billingMode, "recurring");
  assert.equal(payments.items[0]?.planId, "creator");
  assert.equal(payments.items[0]?.interval, "weekly");
  assert.equal("subscriptionIntentId" in payments.items[0]!, false);
  assert.equal("checkoutUrl" in payments.items[0]!, false);
  const subscriptions = await service.listSubscriptions(parseAdminListQuery(new URL("http://local/?status=active"), { status: new Set(["active"]) }));
  assert.equal(subscriptions.total, 1);
  assert.equal(subscriptions.items[0]?.ownerEmail, "asha@example.test");
  assert.equal(subscriptions.items[0]?.status, "active");
  const manual = await service.listManualAccess(parseAdminListQuery(new URL("http://local/?search=pro")));
  assert.equal(manual.total, 1);
  assert.equal(manual.items[0]?.paymentReferenceAvailable, true);
  assert.equal("providerPaymentId" in manual.items[0]!, false);
  const recurringIntents = await service.listRecurringIntents(parseAdminListQuery(new URL("http://local/?status=active"), { status: new Set(["active"]) }));
  assert.equal(recurringIntents.items[0]?.billingMode, "recurring");
  assert.equal("providerSubscriptionId" in recurringIntents.items[0]!, false);
  const manualIntents = await service.listManualPaymentIntents(parseAdminListQuery(new URL("http://local/?status=paid"), { status: new Set(["paid"]) }));
  assert.equal(manualIntents.items[0]?.billingMode, "manual");
  assert.equal("checkoutUrl" in manualIntents.items[0]!, false);
});

test("payment details safely distinguish recurring/manual records and mark unstored financial data unavailable", async () => {
  const { db, service } = makeService(); seed(db);
  db.paymentRecord.rows[0]!.subscriptionIntentId = "recurring-intent";
  db.paymentRecord.rows[0]!.providerSubscriptionId = "sub_ref_1";
  db.razorpaySubscriptionIntent.rows.push({ id: "recurring-intent", userId: "u1", planId: "creator", interval: "weekly", amountPaise: 49900, currency: "INR", status: "active", providerSubscriptionId: "sub_ref_1", createdAt: at, updatedAt: at, checkoutUrl: "private-checkout-url" });
  db.subscription.rows.push({ id: "current-subscription", userId: "u1", planId: "creator", interval: "weekly", status: "active", currentPeriodEnd: at, cancelAtPeriodEnd: false, cancellationRequestedAt: null, createdAt: at, updatedAt: at, razorpaySubscriptionId: "sub_ref_1" });
  const recurring = await service.getPaymentDetails("p1");
  assert.equal(recurring?.payment.billingMode, "recurring");
  assert.equal(recurring?.plan?.planId, "creator");
  assert.equal(recurring?.currentSubscription?.status, "active");
  assert.equal(recurring?.manualAccess, null);
  assert.ok(recurring?.unavailableInformation.some((item) => item.includes("refund")));
  assert.ok(recurring?.unavailableInformation.some((item) => item.includes("fees")));
  const manualRow = { id: "p-manual", userId: "u1", amountPaise: 399900, currency: "INR", status: "captured", providerPaymentId: "pay_manual", providerSubscriptionId: null, subscriptionIntentId: null, manualPaymentIntentId: "manual-intent", createdAt: at, secret: "must-not-leak" };
  db.paymentRecord.rows.push(manualRow);
  db.manualPaymentIntent.rows.push({ id: "manual-intent", userId: "u1", planId: "pro", interval: "monthly", amountPaise: 399900, currency: "INR", status: "paid", accessStartsAt: at, accessEndsAt: new Date("2026-12-08T12:00:00Z"), createdAt: at, updatedAt: at, checkoutUrl: "private-checkout" });
  db.manualPlanAccess.rows.push({ id: "access", intentId: "manual-intent", userId: "u1", providerPaymentId: "pay_manual", planId: "pro", startsAt: at, expiresAt: new Date("2026-12-08T12:00:00Z"), createdAt: at });
  const manual = await service.getPaymentDetails("p-manual");
  assert.equal(manual?.payment.billingMode, "manual");
  assert.equal(manual?.manualAccess?.planId, "pro");
  const serialized = JSON.stringify(manual);
  assert.doesNotMatch(serialized, /private-checkout|must-not-leak|secret|encrypted|payload/i);
  assert.equal(await service.getPaymentDetails("missing"), null);
});

test("overview reports only defined counts and marks financial and activity metrics unavailable", async () => {
  const { db, service } = makeService(); seed(db);
  const overview = await service.getOverview();
  assert.equal(overview.users.registered, 2);
  assert.equal(overview.cycles.total, 1);
  assert.equal(overview.cycles.byStatus["running"], 1);
  assert.equal(overview.publishing.byStage["published"], 1);
  assert.equal(overview.instagram.byStoredStatus["connected"], 1);
  assert.equal(overview.billing.monetaryMetrics, "unavailable");
  assert.equal(overview.billing.unclassifiedStatusCount, 0);
  assert.ok(overview.unavailableMetrics.some((item) => item.includes("refunds")));
  assert.equal("active" in overview.users, false);
});

test("user detail composes bounded billing, account, cycle, publishing, usage and audit history with sensitive fields omitted", async () => {
  const { db, service } = makeService(); seed(db);
  db.subscription.rows.push({ id: "sub1", userId: "u1", planId: "creator", interval: "weekly", status: "active", currentPeriodEnd: at, cancelAtPeriodEnd: false, cancellationRequestedAt: null, createdAt: at, updatedAt: at, razorpaySubscriptionId: "private-provider-linkage" });
  db.razorpaySubscriptionIntent.rows.push({ id: "intent1", userId: "u1", planId: "creator", interval: "weekly", amountPaise: 49900, currency: "INR", status: "active", createdAt: at, updatedAt: at, checkoutUrl: "private-checkout-url", providerSubscriptionId: "private-provider-linkage" });
  db.manualPaymentIntent.rows.push({ id: "manual1", userId: "u1", planId: "pro", interval: "monthly", amountPaise: 399900, currency: "INR", status: "paid", accessStartsAt: at, accessEndsAt: at, createdAt: at, updatedAt: at, checkoutUrl: "private-checkout-url" });
  db.manualPlanAccess.rows.push({ id: "access1", userId: "u1", intentId: "manual1", providerPaymentId: "pay_1", planId: "pro", startsAt: at, expiresAt: at, createdAt: at });
  db.usageRecord.rows.push({ id: "usage1", userId: "u1", kind: "exports", amount: 2n, periodStart: at, createdAt: at, idempotencyKey: "private-key" });
  const detail = await service.getUserDetails("u1");
  assert.ok(detail);
  assert.equal(detail.subscription?.planId, "creator");
  assert.equal(detail.subscriptionIntents.length, 1);
  assert.equal(detail.manualPaymentIntents.length, 1);
  assert.equal(detail.manualAccessPeriods.length, 1);
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.socialAccounts.length, 1);
  assert.equal(detail.cycles.length, 1);
  assert.equal(detail.reels.length, 1);
  assert.equal(detail.publishingAttempts.length, 1);
  assert.equal(detail.auditHistory.length, 1);
  assert.equal(detail.usageActivity[0]?.amount, "2");
  const serialized = JSON.stringify(detail);
  for (const value of ["must-not-return", "private-checkout-url", "private-provider-linkage", "private provider payload", "secretPayload", "lockToken", "idempotencyKey", "metadata"]) assert.equal(serialized.includes(value), false, value);
  assert.equal(await service.getUserDetails("admin"), null);
  assert.equal(await service.getUserDetails("missing"), null);
});

test("Admin query validation bounds pagination, search, dates, and filters", () => {
  assert.throws(() => parseAdminListQuery(new URL("http://local/?page=0")));
  assert.throws(() => parseAdminListQuery(new URL(`http://local/?search=${"x".repeat(101)}`)));
  assert.throws(() => parseAdminListQuery(new URL("http://local/?from=2026-01-01")));
  assert.throws(() => parseAdminListQuery(new URL("http://local/?status=made-up"), { status: new Set(["running"]) }));
  assert.throws(() => parseAdminListQuery(new URL("http://local/?planId=unknown"), { plans: new Set(["free", "creator", "pro", "agency"]) }));
  const query = parseAdminListQuery(new URL("http://local/?page=2&pageSize=50&verified=true"), { verified: true });
  assert.deepEqual({ page: query.page, pageSize: query.pageSize, verified: query.verified }, { page: 2, pageSize: 50, verified: true });
});

test("Admin plan entitlement summaries follow existing stored subscription and manual-access rules", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push(
    { id: "paid", name: "Paid", email: "paid@example.test", role: "user", createdAt: at },
    { id: "trial", name: "Trial", email: "trial@example.test", role: "user", createdAt: at },
    { id: "manual", name: "Manual", email: "manual@example.test", role: "user", createdAt: at },
    { id: "unpaid", name: "Unpaid", email: "unpaid@example.test", role: "user", createdAt: at },
    { id: "unknown", name: "Unknown", email: "unknown@example.test", role: "user", createdAt: at },
    { id: "admin", name: "Admin", email: "admin@example.test", role: "admin", createdAt: at },
  );
  const future = new Date("2026-12-01T00:00:00.000Z");
  db.subscription.rows.push(
    { id: "sub-paid", userId: "paid", planId: "creator", interval: "weekly", status: "active", razorpaySubscriptionId: "sub-paid-provider", currentPeriodEnd: future, cancelAtPeriodEnd: false, createdAt: at, updatedAt: at },
    { id: "sub-trial", userId: "trial", planId: "pro", interval: "monthly", status: "authenticated", razorpaySubscriptionId: "sub-trial-provider", trialEndsAt: BigInt(Math.floor(future.getTime() / 1000)), currentPeriodEnd: null, cancelAtPeriodEnd: false, createdAt: at, updatedAt: at },
    { id: "sub-unpaid", userId: "unpaid", planId: "agency", interval: "monthly", status: "active", razorpaySubscriptionId: "sub-unpaid-provider", currentPeriodEnd: future, cancelAtPeriodEnd: false, createdAt: at, updatedAt: at },
    { id: "sub-unknown", userId: "unknown", planId: "legacy_gold", interval: "monthly", status: "active", razorpaySubscriptionId: "sub-unknown-provider", currentPeriodEnd: future, cancelAtPeriodEnd: false, createdAt: at, updatedAt: at },
  );
  db.paymentRecord.rows.push(
    { id: "paid-record", userId: "paid", providerPaymentId: "pay1", providerSubscriptionId: "sub-paid-provider", amountPaise: 49900, currency: "INR", status: "captured", createdAt: at },
    { id: "unknown-record", userId: "unknown", providerPaymentId: "pay2", providerSubscriptionId: "sub-unknown-provider", amountPaise: 1, currency: "INR", status: "captured", createdAt: at },
  );
  db.manualPlanAccess.rows.push({ id: "access-manual", userId: "manual", intentId: "intent-manual", providerPaymentId: "pay-manual", planId: "agency", startsAt: new Date("2026-11-01T00:00:00.000Z"), expiresAt: future, createdAt: at });
  const { service } = makeService(db);
  const result = await service.listPlanEntitlements(parseAdminListQuery(new URL("http://local/?pageSize=100")));
  const byId = new Map(result.items.map((row) => [row.userId, row]));
  assert.equal(result.total, 5);
  assert.equal(byId.get("paid")?.planId, "creator");
  assert.equal(byId.get("paid")?.source, "recurring_subscription");
  assert.equal(byId.get("trial")?.planId, "pro");
  assert.equal(byId.get("trial")?.source, "subscription_trial");
  assert.equal(byId.get("manual")?.planId, "agency");
  assert.equal(byId.get("manual")?.source, "manual_access");
  assert.equal(byId.get("unpaid")?.planId, "free");
  assert.equal(byId.get("unknown")?.planId, "unknown");
  assert.equal(byId.get("unknown")?.source, "inconsistent");
  assert.equal(byId.get("unknown")?.inconsistentStoredPlan, true);
  const counts = await service.getSubscriptionCountsByPlan();
  assert.equal(counts.byPlan.creator, 1);
  assert.equal(counts.unknownPlanCount, 1);
});

test("plan entitlement API denies ordinary users and rejects unsupported query fields", async () => {
  const { service } = makeService();
  assert.equal((await createAdminPlanEntitlementsRoute(() => runtimeWith("user", service))(new Request("http://localhost/api/admin/plans/entitlements"))).status, 403);
  const admin = createAdminPlanEntitlementsRoute(() => runtimeWith("admin", service));
  assert.equal((await admin(new Request("http://localhost/api/admin/plans/entitlements?planId=creator"))).status, 400);
  const allowed = await admin(new Request("http://localhost/api/admin/plans/entitlements?page=1&pageSize=10&search=asha"));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
});

test("analytics date range validates full days and enforces the maximum period", () => {
  const range = parseAdminAnalyticsDateRange(new URL("http://local/?from=2026-11-01&to=2026-11-08"));
  assert.equal(range.from.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(range.to.toISOString(), "2026-11-08T23:59:59.999Z");
  assert.throws(() => parseAdminAnalyticsDateRange(new URL("http://local/?from=2026-11-02&to=2026-11-01")));
  assert.throws(() => parseAdminAnalyticsDateRange(new URL("http://local/?from=2025-01-01&to=2026-01-02")));
  assert.throws(() => parseAdminAnalyticsDateRange(new URL("http://local/?from=2026-02-30&to=2026-03-01")));
  assert.throws(() => parseAdminAnalyticsDateRange(new URL("http://local/?from=2026-11-01&to=2026-11-08&status=active")));
});

test("analytics report uses stored timestamps/status snapshots and excludes sensitive and financial aggregates", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "u1", name: "Asha", email: "asha@example.test", role: "user", createdAt: at, passwordHash: "private-hash" }, { id: "admin", name: "Admin", email: "admin@example.test", role: "admin", createdAt: at });
  db.publishingCycle.rows.push({ id: "cycle", ownerId: "u1", name: "Launch", status: "running", createdAt: at, secretConfig: "private" });
  db.publishingJob.rows.push(
    { id: "queued", ownerId: "u1", cycleId: "cycle", cycleItemId: "item1", stage: "queued", outcome: "in_progress", createdAt: at, lockToken: "secret-lock", errorDetails: "raw" },
    { id: "published", ownerId: "u1", cycleId: "cycle", cycleItemId: "item2", stage: "published", outcome: "success", createdAt: at, lockToken: "secret-lock" },
    { id: "review", ownerId: "u1", cycleId: "cycle", cycleItemId: "item3", stage: "needs_manual_review", outcome: "ambiguous", createdAt: at, errorMessage: "raw provider response" },
  );
  db.socialAccount.rows.push({ id: "social", userId: "u1", platform: "instagram", status: "connected", createdAt: at, encryptedAccessToken: "secret-token" });
  db.paymentRecord.rows.push({ id: "payment", userId: "u1", amountPaise: 49900, currency: "INR", status: "captured", providerPaymentId: "provider-private", createdAt: at, rawPayload: "private-payload" });
  db.subscription.rows.push({ id: "sub", userId: "u1", planId: "creator", interval: "weekly", status: "active", createdAt: at, updatedAt: at });
  const { service } = makeService(db);
  const report = await service.getAnalyticsReport(new Date("2026-11-01T00:00:00.000Z"), new Date("2026-11-08T23:59:59.999Z"));
  assert.equal(report.users.registrationsInRange, 1);
  assert.equal(report.campaigns.createdInRange, 1);
  assert.equal(report.campaigns.currentStatusesForCyclesCreatedInRange.running, 1);
  assert.equal(report.publishing.attemptsCreatedInRange, 3);
  assert.equal(report.publishing.currentStateCounts.queued, 1);
  assert.equal(report.publishing.currentStateCounts.published_recorded, 1);
  assert.equal(report.publishing.currentStateCounts.needs_review, 1);
  assert.equal(report.instagram.storedStatusCounts.connected, 1);
  assert.equal(report.payments.storedStatusCounts.captured, 1);
  assert.equal(report.payments.monetaryMetrics, "unavailable");
  assert.equal(report.subscriptions.allCurrentRowsByPlan.creator, 1);
  assert.equal(report.plans.byPlan.free, 1);
  const serialized = JSON.stringify(report);
  for (const secret of ["private-hash", "secret-lock", "raw provider response", "secret-token", "provider-private", "private-payload", "49900"]) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(report.dataQuality.incompleteCollections, []);
  assert.equal(report.dataQuality.historicalStatusTransitions, "not_stored");
});

test("analytics APIs require Admin authorization and CSV export contains only aggregate rows", async () => {
  const { db, service } = makeService(); seed(db);
  const url = "http://localhost/api/admin/analytics?from=2026-11-01&to=2026-11-08";
  assert.equal((await createAdminAnalyticsRoute(() => runtimeWith("user", service))(new Request(url))).status, 403);
  const admin = createAdminAnalyticsRoute(() => runtimeWith("admin", service));
  assert.equal((await admin(new Request("http://localhost/api/admin/analytics?from=2026-11-01&to=2026-11-08&search=x"))).status, 400);
  const csv = await createAdminAnalyticsCsvRoute(() => runtimeWith("admin", service))(new Request(url.replace("/analytics?", "/analytics/export?")));
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  const body = await csv.text();
  assert.match(body, /daily_trend/);
  assert.doesNotMatch(body, /asha@example\.test|must-not-return|encryptedAccessToken|private provider payload/);
});

function runtimeWith(role: "admin" | "user" | null, service: AdminDataService): Runtime {
  return {
    mode: "unconfigured", repo: {} as Runtime["repo"], currentUserId: async () => null,
    currentPrincipal: async () => role ? { userId: role === "admin" ? "admin-id" : "ordinary-id", role } : null,
    now: () => at, newId: () => "id", adminData: async () => service,
  };
}

test("Admin API routes deny anonymous and ordinary users and allow persisted admin principals", async () => {
  const { service } = makeService();
  for (const role of [null, "user"] as const) {
    const route = createAdminDataRoute("users", () => runtimeWith(role, service));
    const response = await route(new Request("http://localhost/api/admin/users"));
    assert.equal(response.status, role === null ? 401 : 403);
  }
  const route = createAdminDataRoute("users", () => runtimeWith("admin", service));
  const response = await route(new Request("http://localhost/api/admin/users?page=1&pageSize=10"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("overview API fails closed when data is unavailable and requires Admin authorization", async () => {
  const anonymous = createAdminOverviewRoute(() => ({ mode: "unconfigured", repo: {} as Runtime["repo"], currentUserId: async () => null, currentPrincipal: async () => null, now: () => at, newId: () => "id" }));
  assert.equal((await anonymous(new Request("http://localhost/api/admin/overview"))).status, 401);
  const unavailable = createAdminOverviewRoute(() => ({ mode: "unconfigured", repo: {} as Runtime["repo"], currentUserId: async () => null, currentPrincipal: async () => ({ userId: "admin", role: "admin" }), now: () => at, newId: () => "id" }));
  assert.equal((await unavailable(new Request("http://localhost/api/admin/overview"))).status, 503);
});

test("user detail API is protected, read-only, owner-agnostic only for Admin, and returns a safe DTO", async () => {
  const db = new FakePrismaClient(); seed(db);
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => at);
  const ordinary = createAdminUserDetailRoute(() => runtimeWith("user", service));
  assert.equal((await ordinary(new Request("http://localhost/api/admin/users/u1"))).status, 403);
  const admin = createAdminUserDetailRoute(() => runtimeWith("admin", service));
  const response = await admin(new Request("http://localhost/api/admin/users/u1"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /asha@example\.test/);
  assert.doesNotMatch(body, /must-not-return|encryptedAccessToken|lockToken|private provider payload/);
  assert.equal((await admin(new Request("http://localhost/api/admin/users/admin"))).status, 404);
});

test("campaign details distinguish schedule, queue, attempts, published record, failure, and ambiguous review safely", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: at, passwordHash: "secret-hash" });
  db.socialAccount.rows.push({ id: "ig", userId: "owner", platform: "instagram", username: "owner.ig", accountType: "BUSINESS", grantedScopes: "scope_a", status: "connected", tokenExpiresAt: at, createdAt: at, encryptedAccessToken: "secret-token" });
  db.publishingCycle.rows.push({ id: "cycle", ownerId: "owner", socialAccountId: "ig", name: "Cycle", status: "running", finalReviewConfirmed: true, orderMode: "manual", repeatBehavior: "never", timezone: "Asia/Kolkata", scheduleSettings: { timeZone: "Asia/Kolkata", intervalMinutes: 1440, postsPerInterval: 1, daysOfWeek: [1, 2, 3], windowStart: "09:00", windowEnd: "10:00", dailyMax: 1, endDate: null, startDate: "2026-11-08", secret: "not-a-whitelisted-setting" }, createdAt: at, updatedAt: at });
  const item = (id: string, position: number, status: string, patch: Record<string, unknown> = {}) => ({ id, cycleId: "cycle", cycleOwnerId: "owner", mediaAssetId: `media-${id}`, selectedRenderOutputId: null, selectedRenderOwnerId: null, selectedRenderSourceMediaId: null, sourceKind: "owned", status, position, scheduledFor: at, publishedAt: null, externalPostId: null, coverState: "none", createdAt: at, ...patch });
  db.cycleItem.rows.push(
    item("i-queued", 1, "scheduled"),
    item("i-published", 2, "published", { publishedAt: at, externalPostId: "post-confirmed", selectedRenderOutputId: "render-1", selectedRenderOwnerId: "owner", selectedRenderSourceMediaId: "media-i-published" }),
    item("i-failed", 3, "failed"),
    item("i-review", 4, "needs_review"),
  );
  for (const id of ["i-queued", "i-published", "i-failed", "i-review"]) db.mediaAsset.rows.push({ id: `media-${id}`, ownerId: "owner", originalFilename: `${id}.mp4`, kind: "video", status: "active", metadataValidated: true, storageKey: `private-${id}` });
  db.mediaDerivative.rows.push({ id: "render-1", ownerId: "owner", mediaAssetId: "media-i-published", kind: "render", storageKey: "private-render", settingsHash: "hash", createdAt: at });
  const job = (id: string, cycleItemId: string, attemptNumber: number, stage: string, outcome: string) => ({ id, ownerId: "owner", cycleId: "cycle", cycleItemId, socialAccountId: "ig", attemptNumber, stage, outcome, errorCategory: stage === "failed" ? "provider_rejected" : null, createdAt: at, startedAt: at, finishedAt: stage === "queued" ? null : at, lockToken: "secret-lock", workerId: "secret-worker", leaseExpiresAt: at, idempotencyKey: "secret-idempotency", errorMessage: "raw provider message", errorDetails: "provider body", containerId: "private-container" });
  db.publishingJob.rows.push(job("j-queued-old", "i-queued", 1, "failed", "definite_failure"), job("j-queued", "i-queued", 2, "queued", "in_progress"), job("j-published", "i-published", 1, "published", "success"), job("j-failed", "i-failed", 1, "failed", "definite_failure"), job("j-review", "i-review", 1, "needs_manual_review", "ambiguous"));
  const { service } = makeService(db);
  const detail = await service.getCycleDetails("cycle");
  assert.ok(detail);
  assert.equal(detail.accountAssociation, "verified_owner_account");
  assert.equal(detail.cycle.scheduleAvailable, true);
  assert.equal("secret" in (detail.cycle.schedule as unknown as Record<string, unknown>), false);
  assert.deepEqual(detail.items.map((entry) => entry.publishingState), ["queued", "published_recorded", "failed", "needs_review"]);
  assert.equal(detail.items[1]?.selectedRenderStatus, "available");
  assert.equal(detail.items[1]?.selectedRenderOutputId, "render-1");
  assert.equal(detail.publishingAttempts.length, 5);
  assert.equal(detail.items[0]?.latestAttemptNumber, 2);
  const serialized = JSON.stringify(detail);
  for (const secret of ["secret-token", "secret-lock", "secret-worker", "secret-idempotency", "raw provider message", "provider body", "private-container", "private-render", "passwordHash", "encryptedAccessToken"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(await service.getCycleDetails("missing"), null);
});

test("campaign detail API requires Admin authorization and never returns a live-status claim", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: at });
  db.publishingCycle.rows.push({ id: "cycle", ownerId: "owner", socialAccountId: "missing", name: "Cycle", status: "draft", finalReviewConfirmed: false, orderMode: "manual", repeatBehavior: "never", timezone: "Asia/Kolkata", scheduleSettings: {}, createdAt: at, updatedAt: at });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => at);
  const ordinary = createAdminCycleDetailRoute(() => runtimeWith("user", service));
  assert.equal((await ordinary(new Request("http://localhost/api/admin/campaigns/cycle"))).status, 403);
  const admin = createAdminCycleDetailRoute(() => runtimeWith("admin", service));
  const response = await admin(new Request("http://localhost/api/admin/campaigns/cycle"));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /missing/);
});

test("payment detail API is read-only and protected by the Admin boundary", async () => {
  const { db, service } = makeService(); seed(db);
  const anonymous = createAdminPaymentDetailRoute(() => runtimeWith(null, service));
  const ordinary = createAdminPaymentDetailRoute(() => runtimeWith("user", service));
  const admin = createAdminPaymentDetailRoute(() => runtimeWith("admin", service));
  assert.equal((await anonymous(new Request("http://localhost/api/admin/billing/payments/p1"))).status, 401);
  assert.equal((await ordinary(new Request("http://localhost/api/admin/billing/payments/p1"))).status, 403);
  const response = await admin(new Request("http://localhost/api/admin/billing/payments/p1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await admin(new Request("http://localhost/api/admin/billing/payments/missing"))).status, 404);
});

test("subscription and manual-access APIs require Admin and expose only their separate read-only records", async () => {
  const { db, service } = makeService(); seed(db);
  db.subscription.rows.push({ id: "sub", userId: "u1", planId: "creator", interval: "weekly", status: "pending", createdAt: at, updatedAt: at, privateProviderId: "hidden" });
  db.manualPlanAccess.rows.push({ id: "access", userId: "u1", intentId: "intent", providerPaymentId: "private-reference", planId: "pro", startsAt: at, expiresAt: at, createdAt: at });
  const userRoute = createAdminDataRoute("subscriptions", () => runtimeWith("user", service));
  assert.equal((await userRoute(new Request("http://localhost/api/admin/billing/subscriptions"))).status, 403);
  const subscriptionRoute = createAdminDataRoute("subscriptions", () => runtimeWith("admin", service));
  const subscriptions = await subscriptionRoute(new Request("http://localhost/api/admin/billing/subscriptions?status=pending"));
  assert.equal(subscriptions.status, 200);
  assert.match(await subscriptions.text(), /creator/);
  assert.doesNotMatch(await createAdminDataRoute("manual-access", () => runtimeWith("admin", service))(new Request("http://localhost/api/admin/billing/manual-access")).then((r) => r.text()), /private-reference/);
  assert.equal((await subscriptionRoute(new Request("http://localhost/api/admin/billing/subscriptions?status=invalid"))).status, 400);
  const intentRoute = createAdminDataRoute("manual-payment-intents", () => runtimeWith("admin", service));
  const intentResponse = await intentRoute(new Request("http://localhost/api/admin/billing/manual-payment-intents"));
  assert.equal(intentResponse.status, 200);
  assert.doesNotMatch(await intentResponse.text(), /private-checkout|providerPaymentLinkId/);
});

test("Instagram detail uses stored permissions and expiry, joins account activity, and omits credentials and raw scopes", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: at, passwordHash: "secret-password-hash" });
  db.socialAccount.rows.push({ id: "ig", userId: "owner", platform: "instagram", username: "owner.ig", accountType: "BUSINESS", grantedScopes: "instagram_business_basic instagram_business_content_publish extra_unknown_scope", status: "connected", tokenExpiresAt: new Date("2026-12-01T00:00:00.000Z"), createdAt: at, encryptedAccessToken: "secret-ciphertext" });
  db.publishingCycle.rows.push({ id: "cy", ownerId: "owner", socialAccountId: "ig", name: "Cycle A", status: "running", timezone: "Asia/Kolkata", createdAt: at, updatedAt: at });
  db.cycleItem.rows.push({ id: "ci", cycleId: "cy", status: "failed", scheduledFor: at });
  db.publishingJob.rows.push({ id: "job", ownerId: "owner", socialAccountId: "ig", cycleId: "cy", cycleItemId: "ci", attemptNumber: 2, stage: "failed", outcome: "definite_failure", errorCategory: "provider_rejected", createdAt: at, startedAt: at, finishedAt: at, lockToken: "secret-lock", idempotencyKey: "secret-idem", errorMessage: "raw provider payload" });
  const { service } = makeService(db);
  const detail = await service.getInstagramAccountDetails("ig");
  assert.ok(detail);
  assert.equal(detail.account.username, "owner.ig");
  assert.equal(detail.storedConnectionState, "connected");
  assert.equal(detail.tokenStored, true);
  assert.equal(detail.permissions.status, "complete");
  assert.equal(detail.permissions.grantedRequiredScopes.length, 2);
  assert.equal(detail.storedEligibility.eligibleFromStoredFields, true);
  assert.equal(detail.restrictionState, "not_stored");
  assert.equal(detail.liveMetaVerified, false);
  assert.equal(detail.campaigns[0]?.name, "Cycle A");
  assert.equal(detail.publishingActivity[0]?.outcome, "definite_failure");
  assert.equal(detail.publishingActivity[0]?.itemStatus, "failed");
  const serialized = JSON.stringify(detail);
  for (const secret of ["secret-ciphertext", "secret-password-hash", "secret-lock", "secret-idem", "raw provider payload", "extra_unknown_scope", "encryptedAccessToken"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(await service.getInstagramAccountDetails("missing"), null);
});

test("Instagram account API rejects ordinary users and returns explicit non-live verification status to Admin", async () => {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "owner", name: "Owner", email: "owner@example.test", role: "user", createdAt: at });
  db.socialAccount.rows.push({ id: "ig", userId: "owner", platform: "instagram", username: "owner.ig", accountType: "UNKNOWN", grantedScopes: null, status: "disconnected", tokenExpiresAt: null, createdAt: at });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => at);
  const ordinary = createAdminInstagramAccountDetailRoute(() => runtimeWith("user", service));
  assert.equal((await ordinary(new Request("http://localhost/api/admin/instagram/accounts/ig"))).status, 403);
  const admin = createAdminInstagramAccountDetailRoute(() => runtimeWith("admin", service));
  const response = await admin(new Request("http://localhost/api/admin/instagram/accounts/ig"));
  assert.equal(response.status, 200);
  const json = await response.json() as { data: { liveMetaVerified: boolean; storedConnectionState: string; tokenStored: boolean; storedEligibility: { eligibleFromStoredFields: boolean } } };
  assert.equal(json.data.liveMetaVerified, false);
  assert.equal(json.data.storedConnectionState, "disconnected");
  assert.equal(json.data.tokenStored, false);
  assert.equal(json.data.storedEligibility.eligibleFromStoredFields, false);
});
