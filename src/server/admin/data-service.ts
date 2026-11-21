import { AppError } from "../errors.ts";
import { ADMIN_PLAN_IDS, type AdminDataRepository, type AdminListQuery, type AdminPage, type AdminUserRow, type AdminCycleRow, type AdminSocialAccountRow, type AdminPaymentRow, type AdminSubscriptionRow, type AdminManualAccessRow, type AdminBillingIntentRow, type AdminPlanEntitlementRow, type AdminPlanCounts, type AdminPlanEntitlementSummary, type AdminAnalyticsReport, type AdminPaymentDetails, type AdminAuditRow, type AdminAuditDetails, type AdminOverview, type AdminUserDetails, type AdminCycleDetails, type AdminInstagramDetails } from "./data-repository.ts";

const MAX_PAGE = 10_000;
const MAX_PAGE_SIZE = 100;
const MAX_DATE_RANGE_MS = 366 * 24 * 60 * 60 * 1000;
const CYCLE_STATUSES = new Set(["draft", "running", "paused", "stopped", "completed"]);
const ACCOUNT_STATUSES = new Set(["connected", "token_expired", "revoked", "disconnected"]);
const PAYMENT_STATUSES = new Set(["captured", "authorized", "failed", "refunded", "partially_refunded", "created"]);
const SUBSCRIPTION_STATUSES = new Set(["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"]);
const RECURRING_INTENT_STATUSES = new Set(["creating", "created", "active", "failed", "manual_review", "cancelled", "expired"]);
const MANUAL_INTENT_STATUSES = new Set(["creating", "created", "paid", "failed", "expired", "manual_review"]);

export function parseAdminListQuery(url: URL, options: { status?: ReadonlySet<string>; verified?: boolean; plans?: ReadonlySet<string> } = {}): AdminListQuery & { verified?: boolean } {
  const parseInteger = (name: string, fallback: number, max: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) throw new AppError(400, "invalid_admin_query", `Invalid ${name} value.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new AppError(400, "invalid_admin_query", `Invalid ${name} value.`);
    return value;
  };
  const page = parseInteger("page", 1, MAX_PAGE);
  const pageSize = parseInteger("pageSize", 25, MAX_PAGE_SIZE);
  if ((page - 1) * pageSize > 1_000_000) throw new AppError(400, "invalid_admin_query", "Requested page is too far ahead.");
  const rawSearch = url.searchParams.get("search");
  const search = rawSearch?.trim() || undefined;
  if (search && (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search))) throw new AppError(400, "invalid_admin_query", "Invalid search value.");
  const rawStatus = url.searchParams.get("status") ?? undefined;
  if (rawStatus && (!options.status || !options.status.has(rawStatus))) throw new AppError(400, "invalid_admin_filter", "Unsupported status filter.");
  const rawFrom = url.searchParams.get("from"); const rawTo = url.searchParams.get("to");
  if ((rawFrom && !rawTo) || (!rawFrom && rawTo)) throw new AppError(400, "invalid_admin_date_range", "Both from and to dates are required.");
  const from = rawFrom ? new Date(rawFrom) : undefined; const to = rawTo ? new Date(rawTo) : undefined;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) throw new AppError(400, "invalid_admin_date_range", "Invalid date range.");
  if (from && to && (to < from || to.getTime() - from.getTime() > MAX_DATE_RANGE_MS)) throw new AppError(400, "invalid_admin_date_range", "Date range must be ordered and no longer than 366 days.");
  const rawVerified = url.searchParams.get("verified");
  if (rawVerified !== null && !options.verified) throw new AppError(400, "invalid_admin_filter", "Unsupported filter.");
  if (rawVerified !== null && rawVerified !== "true" && rawVerified !== "false") throw new AppError(400, "invalid_admin_filter", "Invalid verified filter.");
  const rawPlanId = url.searchParams.get("planId") ?? undefined;
  if (rawPlanId && (!options.plans || !options.plans.has(rawPlanId))) throw new AppError(400, "invalid_admin_filter", "Unsupported plan filter.");
  return { page, pageSize, ...(search ? { search } : {}), ...(rawStatus ? { status: rawStatus } : {}), ...(rawPlanId ? { planId: rawPlanId as AdminListQuery["planId"] } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(rawVerified !== null ? { verified: rawVerified === "true" } : {}) };
}

export function parseAdminAnalyticsDateRange(url: URL): { from: Date; to: Date } {
  if ([...url.searchParams.keys()].some((key) => key !== "from" && key !== "to")) throw new AppError(400, "invalid_analytics_range", "Only from and to date filters are supported.");
  const fromText = url.searchParams.get("from"); const toText = url.searchParams.get("to");
  const validDay = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDay(fromText) || !validDay(toText)) throw new AppError(400, "invalid_analytics_range", "Provide valid from and to dates in YYYY-MM-DD format.");
  const from = new Date(`${fromText}T00:00:00.000Z`); const toStart = new Date(`${toText}T00:00:00.000Z`);
  if (toStart < from || toStart.getTime() - from.getTime() > 365 * 86_400_000) throw new AppError(400, "invalid_analytics_range", "Date range must be ordered and no longer than 366 calendar days.");
  return { from, to: new Date(toStart.getTime() + 86_400_000 - 1) };
}

export function parseAdminAuditQuery(url: URL): AdminListQuery {
  const allowed = new Set(["page", "pageSize", "search", "actorId", "action", "targetType", "targetId", "from", "to"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) throw new AppError(400, "invalid_admin_query", "Unsupported audit filter.");
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw new AppError(400, "invalid_admin_query", "Duplicate audit filter.");
  const baseUrl = new URL(url); baseUrl.searchParams.delete("from"); baseUrl.searchParams.delete("to");
  const base = parseAdminListQuery(baseUrl);
  const fromText = url.searchParams.get("from"); const toText = url.searchParams.get("to");
  const validDay = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if ((fromText !== null && !toText) || (toText !== null && !fromText) || (fromText !== null && !validDay(fromText)) || (toText !== null && !validDay(toText))) throw new AppError(400, "invalid_admin_date_range", "Provide both audit dates in YYYY-MM-DD format.");
  const from = fromText ? new Date(`${fromText}T00:00:00.000Z`) : undefined;
  const to = toText ? new Date(`${toText}T23:59:59.999Z`) : undefined;
  if (from && to && (to < from || to.getTime() - from.getTime() > 366 * 86_400_000)) throw new AppError(400, "invalid_admin_date_range", "Date range must be ordered and no longer than 366 calendar days.");
  const readFilter = (key: "actorId" | "action" | "targetType" | "targetId"): string | undefined => {
    const value = url.searchParams.get(key)?.trim();
    if (!value) return undefined;
    if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new AppError(400, "invalid_admin_filter", `Invalid ${key} filter.`);
    return value;
  };
  const actorId = readFilter("actorId"); const action = readFilter("action"); const targetType = readFilter("targetType"); const targetId = readFilter("targetId");
  return { ...base, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(actorId ? { actorId } : {}), ...(action ? { action } : {}), ...(targetType ? { targetType } : {}), ...(targetId ? { targetId } : {}) };
}

export class AdminDataService {
  constructor(private readonly repo: AdminDataRepository, private readonly now: () => Date) {}
  getOverview(): Promise<AdminOverview> { return this.repo.getOverview(this.now()); }
  listUsers(query: AdminListQuery & { verified?: boolean }): Promise<AdminPage<AdminUserRow>> { return this.repo.listUsers(query); }
  listCycles(query: AdminListQuery): Promise<AdminPage<AdminCycleRow>> { return this.repo.listCycles(query); }
  listSocialAccounts(query: AdminListQuery): Promise<AdminPage<AdminSocialAccountRow>> { return this.repo.listSocialAccounts(query, this.now()); }
  listPayments(query: AdminListQuery): Promise<AdminPage<AdminPaymentRow>> { return this.repo.listPayments(query); }
  listSubscriptions(query: AdminListQuery): Promise<AdminPage<AdminSubscriptionRow>> { return this.repo.listSubscriptions(query); }
  listManualAccess(query: AdminListQuery): Promise<AdminPage<AdminManualAccessRow>> { return this.repo.listManualAccess(query); }
  listRecurringIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>> { return this.repo.listRecurringIntents(query); }
  listManualPaymentIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>> { return this.repo.listManualPaymentIntents(query); }
  getSubscriptionCountsByPlan(): Promise<AdminPlanCounts> { return this.repo.getSubscriptionCountsByPlan(); }
  getPlanEntitlementSummary(): Promise<AdminPlanEntitlementSummary> { return this.repo.getPlanEntitlementSummary(this.now()); }
  getAnalyticsReport(from: Date, to: Date): Promise<AdminAnalyticsReport> { return this.repo.getAnalyticsReport(from, to, this.now()); }
  listPlanEntitlements(query: AdminListQuery): Promise<AdminPage<AdminPlanEntitlementRow>> { return this.repo.listPlanEntitlements(query, this.now()); }
  getPaymentDetails(paymentId: string): Promise<AdminPaymentDetails | null> { return this.repo.getPaymentDetails(paymentId); }
  listAudit(query: AdminListQuery): Promise<AdminPage<AdminAuditRow>> { return this.repo.listAudit(query); }
  getAuditDetails(auditId: string): Promise<AdminAuditDetails | null> { return this.repo.getAuditDetails(auditId); }
  getUserDetails(userId: string): Promise<AdminUserDetails | null> { return this.repo.getUserDetails(userId); }
  getUserSuspension(userId: string) { return this.repo.getUserSuspension(userId); }
  setUserSuspension(input: { userId: string; adminId: string; suspended: boolean; reason: string | null; now: Date; newId: () => string }) { return this.repo.setUserSuspension(input); }
  setCyclePauseState(input: { cycleId: string; adminId: string; action: "pause" | "resume"; reason: string | null; now: Date; newId: () => string }) { return this.repo.setCyclePauseState(input); }
  getCycleDetails(cycleId: string): Promise<AdminCycleDetails | null> { return this.repo.getCycleDetails(cycleId); }
  getInstagramAccountDetails(accountId: string): Promise<AdminInstagramDetails | null> { return this.repo.getInstagramAccountDetails(accountId, this.now()); }
}

export const ADMIN_FILTERS = { cycleStatuses: CYCLE_STATUSES, accountStatuses: ACCOUNT_STATUSES, paymentStatuses: PAYMENT_STATUSES, subscriptionStatuses: SUBSCRIPTION_STATUSES, recurringIntentStatuses: RECURRING_INTENT_STATUSES, manualIntentStatuses: MANUAL_INTENT_STATUSES, planIds: new Set(ADMIN_PLAN_IDS) } as const;
