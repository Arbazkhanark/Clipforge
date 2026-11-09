import { AppError } from "../errors.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { ADMIN_FILTERS, AdminDataService, parseAdminAnalyticsDateRange, parseAdminAuditQuery, parseAdminListQuery } from "./data-service.ts";
import { adminApiRoute } from "./api-route.ts";

type ListKind = "users" | "cycles" | "instagram" | "payments" | "subscriptions" | "manual-access" | "recurring-intents" | "manual-payment-intents" | "audit";
async function getService(runtime: Runtime): Promise<AdminDataService> {
  if (!runtime.adminData) throw new AppError(503, "admin_data_unavailable", "Admin data is not available in this runtime.");
  return runtime.adminData();
}

export function createAdminDataRoute(kind: ListKind, runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const url = new URL(request.url);
    const options = kind === "cycles" ? { status: ADMIN_FILTERS.cycleStatuses }
      : kind === "instagram" ? { status: ADMIN_FILTERS.accountStatuses }
      : kind === "payments" ? { status: ADMIN_FILTERS.paymentStatuses }
      : kind === "subscriptions" ? { status: ADMIN_FILTERS.subscriptionStatuses, plans: ADMIN_FILTERS.planIds }
      : kind === "recurring-intents" ? { status: ADMIN_FILTERS.recurringIntentStatuses }
      : kind === "manual-payment-intents" ? { status: ADMIN_FILTERS.manualIntentStatuses }
      : kind === "users" ? { verified: true }
      : {};
    const query = kind === "audit" ? parseAdminAuditQuery(url) : parseAdminListQuery(url, options);
    const service = await getService(runtime());
    const data = kind === "users" ? await service.listUsers(query)
      : kind === "cycles" ? await service.listCycles(query)
      : kind === "instagram" ? await service.listSocialAccounts(query)
      : kind === "payments" ? await service.listPayments(query)
      : kind === "subscriptions" ? await service.listSubscriptions(query)
      : kind === "manual-access" ? await service.listManualAccess(query)
      : kind === "recurring-intents" ? await service.listRecurringIntents(query)
      : kind === "manual-payment-intents" ? await service.listManualPaymentIntents(query)
      : await service.listAudit(query);
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminAuditDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let auditId: string;
    try { auditId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_audit_id", "Invalid audit identifier."); }
    if (!auditId || auditId.length > 128 || auditId.includes("/") || /[\u0000-\u001f\u007f]/.test(auditId)) throw new AppError(400, "invalid_audit_id", "Invalid audit identifier.");
    const service = await getService(runtime());
    const data = await service.getAuditDetails(auditId);
    if (!data) throw new AppError(404, "not_found", "Audit record was not found.");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminPaymentDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let paymentId: string;
    try { paymentId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_payment_id", "Invalid payment identifier."); }
    if (!paymentId || paymentId.length > 128 || paymentId.includes("/") || /[\u0000-\u001f\u007f]/.test(paymentId)) throw new AppError(400, "invalid_payment_id", "Invalid payment identifier.");
    const service = await getService(runtime());
    const data = await service.getPaymentDetails(paymentId);
    if (!data) throw new AppError(404, "not_found", "Payment record was not found.");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminPlanEntitlementsRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const url = new URL(request.url);
    const allowed = new Set(["page", "pageSize", "search"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) throw new AppError(400, "invalid_admin_query", "Unsupported plan entitlement query parameter.");
    const query = parseAdminListQuery(url);
    const service = await getService(runtime());
    const [data, subscriptionCounts] = await Promise.all([service.listPlanEntitlements(query), service.getSubscriptionCountsByPlan()]);
    return Response.json({ data, subscriptionCounts }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

function analyticsCsv(report: Awaited<ReturnType<AdminDataService["getAnalyticsReport"]>>): string {
  const rows: string[][] = [["section", "date", "metric", "value"]];
  const add = (section: string, metric: string, value: string | number, date = "") => rows.push([section, date, metric, String(value)]);
  for (const day of report.series) for (const [metric, value] of Object.entries(day).filter(([key]) => key !== "day")) add("daily_trend", metric, value, day.day);
  for (const [status, count] of Object.entries(report.campaigns.currentStatusesForCyclesCreatedInRange)) add("campaign_status_snapshot", status, count);
  for (const [status, count] of Object.entries(report.publishing.currentStateCounts)) add("publishing_attempt_state_snapshot", status, count);
  for (const [status, count] of Object.entries(report.instagram.storedStatusCounts)) add("instagram_stored_status", status, count);
  for (const [status, count] of Object.entries(report.payments.storedStatusCounts)) add("payment_record_status", status, count);
  for (const [status, count] of Object.entries(report.subscriptions.currentStoredStatusCounts)) add("subscription_status_snapshot", status, count);
  for (const [plan, count] of Object.entries(report.subscriptions.allCurrentRowsByPlan)) add("current_subscription_rows_by_plan", plan, count);
  if (report.plans.complete) {
    for (const [plan, count] of Object.entries(report.plans.byPlan)) add("current_entitled_users_by_plan", plan, count);
    for (const [source, count] of Object.entries(report.plans.bySource)) add("current_entitlement_source", source, count);
    add("current_entitlement_quality", "inconsistent_entitlements", report.plans.inconsistentEntitlements);
  } else add("current_entitlement_quality", "unavailable_reason", report.plans.unavailableReason ?? "unavailable");
  add("data_quality", "incomplete_collections", report.dataQuality.incompleteCollections.join("; ") || "none");
  add("data_quality", "historical_status_transitions", report.dataQuality.historicalStatusTransitions);
  add("data_quality", "refund_fee_tax_data", report.dataQuality.refundFeeTaxData);
  const field = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return rows.map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
}

export function createAdminAnalyticsRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const { from, to } = parseAdminAnalyticsDateRange(new URL(request.url));
    const service = await getService(runtime());
    return Response.json({ data: await service.getAnalyticsReport(from, to) }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminAnalyticsCsvRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const { from, to } = parseAdminAnalyticsDateRange(new URL(request.url));
    const service = await getService(runtime());
    const report = await service.getAnalyticsReport(from, to);
    return new Response(analyticsCsv(report), { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clipforge-admin-analytics-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminOverviewRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length) throw new AppError(400, "invalid_admin_query", "Overview does not accept query parameters.");
    const service = await getService(runtime());
    return Response.json({ data: await service.getOverview() }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminUserDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let userId: string;
    try { userId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_user_id", "Invalid user identifier."); }
    if (!userId || userId.length > 128 || userId.includes("/") || /[\u0000-\u001f\u007f]/.test(userId)) throw new AppError(400, "invalid_user_id", "Invalid user identifier.");
    const service = await getService(runtime());
    const data = await service.getUserDetails(userId);
    if (!data) throw new AppError(404, "not_found", "User was not found.");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminCycleDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let cycleId: string;
    try { cycleId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_cycle_id", "Invalid cycle identifier."); }
    if (!cycleId || cycleId.length > 128 || cycleId.includes("/") || /[\u0000-\u001f\u007f]/.test(cycleId)) throw new AppError(400, "invalid_cycle_id", "Invalid cycle identifier.");
    const service = await getService(runtime());
    const data = await service.getCycleDetails(cycleId);
    if (!data) throw new AppError(404, "not_found", "Campaign was not found.");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}

export function createAdminInstagramAccountDetailRoute(runtime: () => Runtime = getRuntime) {
  return adminApiRoute(async (request) => {
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
    const encodedId = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
    let accountId: string;
    try { accountId = decodeURIComponent(encodedId); } catch { throw new AppError(400, "invalid_account_id", "Invalid account identifier."); }
    if (!accountId || accountId.length > 128 || accountId.includes("/") || /[\u0000-\u001f\u007f]/.test(accountId)) throw new AppError(400, "invalid_account_id", "Invalid account identifier.");
    const service = await getService(runtime());
    const data = await service.getInstagramAccountDetails(accountId);
    if (!data) throw new AppError(404, "not_found", "Instagram account was not found.");
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  }, runtime);
}
