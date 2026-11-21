import type { PrismaClientLike, Row, Where } from "../prisma/prisma-client-like.ts";
import { validateScheduleSettings, type ScheduleSettings } from "../../lib/domain/schedule.ts";
import { evaluateInstagramEligibility, normalizeInstagramScopes, type InstagramEligibilityReason } from "../../lib/integrations/instagram-eligibility.ts";
import { INSTAGRAM_REQUIRED_SCOPES } from "../../lib/integrations/instagram-capabilities.ts";
import type { PlanId } from "../../lib/billing/catalog.ts";
import { PLAN_IDS, isPlanId } from "../../lib/billing/catalog.ts";
import { effectivePlanId } from "../../lib/billing/subscription-state.ts";

export const ADMIN_PLAN_IDS: readonly PlanId[] = ["free", "creator", "pro", "agency"];

export type AdminPage<T> = { items: T[]; total: number; page: number; pageSize: number };
export type AdminListQuery = { page: number; pageSize: number; search?: string; status?: string; planId?: PlanId; from?: Date; to?: Date; verified?: boolean; actorId?: string; action?: string; targetType?: string; targetId?: string };
export type AdminUserRow = { id: string; name: string | null; email: string; emailVerified: Date | null; role: string; createdAt: Date };
export type AdminCycleRow = { id: string; ownerId: string; ownerName: string | null; ownerEmail: string; name: string; status: string; timezone: string; createdAt: Date; updatedAt: Date; itemCount: number; scheduledItemCount: number };
export type AdminStoredSchedule = ScheduleSettings & { startDate: string };
export type AdminCycleDetails = {
  cycle: { id: string; name: string; status: string; finalReviewConfirmed: boolean; orderMode: string; repeatBehavior: string; timezone: string; schedule: AdminStoredSchedule | null; scheduleAvailable: boolean; createdAt: Date; updatedAt: Date };
  owner: { id: string; name: string | null; email: string } | null;
  instagramAccount: { id: string; username: string | null; accountType: string | null; scopes: string | null; storedStatus: string; tokenExpiresAt: Date | null } | null;
  accountAssociation: "verified_owner_account" | "missing" | "owner_mismatch" | "unsupported_platform";
  items: AdminCycleItemDetails[];
  publishingAttempts: AdminCampaignAttempt[];
  historyTruncated: { items: boolean; publishingAttempts: boolean };
};
export type AdminCycleItemDetails = {
  id: string; position: number; sourceKind: string; status: string; mediaAssetId: string;
  originalMedia: { filename: string; kind: string; status: string; metadataValidated: boolean } | null;
  selectedRenderOutputId: string | null; selectedRenderStatus: "not_selected" | "available" | "missing_or_mismatched";
  scheduledFor: Date | null; publishedAt: Date | null; coverState: string;
  scheduleState: "scheduled" | "not_scheduled"; publishingState: "not_started" | "queued" | "attempted" | "published_recorded" | "failed" | "needs_review";
  latestAttemptNumber: number | null;
};
export type AdminCampaignAttempt = { id: string; cycleItemId: string; attemptNumber: number; stage: string; outcome: string; errorCategory: string | null; createdAt: Date; startedAt: Date; finishedAt: Date | null };
export type AdminSocialAccountRow = { id: string; userId: string; ownerName: string | null; ownerEmail: string; platform: string; username: string | null; accountType: string | null; grantedRequiredScopes: string[]; status: string; tokenExpiresAt: Date | null; createdAt: Date; tokenStored: boolean; permissionStatus: "complete" | "incomplete" | "malformed"; missingRequiredScopes: string[]; storedConnectionState: "connected" | "expired" | "revoked" | "disconnected" | "unknown"; eligibilityReason: InstagramEligibilityReason | null };
export type AdminInstagramDetails = {
  account: { id: string; username: string | null; accountType: string | null; storedStatus: string; tokenExpiresAt: Date | null; createdAt: Date; updatedInformation: "unavailable" };
  owner: { id: string; name: string | null; email: string } | null;
  tokenStored: boolean;
  storedConnectionState: AdminSocialAccountRow["storedConnectionState"];
  permissions: { status: AdminSocialAccountRow["permissionStatus"]; grantedRequiredScopes: string[]; missingRequiredScopes: string[] };
  storedEligibility: { eligibleFromStoredFields: boolean; reason: InstagramEligibilityReason | null };
  restrictionState: "not_stored";
  liveMetaVerified: false;
  campaigns: { id: string; name: string; status: string; timezone: string; createdAt: Date; updatedAt: Date }[];
  publishingActivity: { id: string; campaignId: string | null; campaignName: string | null; cycleItemId: string; attemptNumber: number; stage: string; outcome: string; errorCategory: string | null; createdAt: Date; startedAt: Date; finishedAt: Date | null; itemStatus?: string; scheduledFor?: Date | null }[];
  historyTruncated: { campaigns: boolean; publishingActivity: boolean };
};
export type AdminPaymentRow = { id: string; userId: string; ownerName: string | null; ownerEmail: string; amountPaise: number; currency: string; status: string; providerPaymentId: string; providerSubscriptionId: string | null; planId: string | null; interval: string | null; billingMode: "recurring" | "manual" | "unlinked" | "conflicting"; createdAt: Date };
export type AdminSubscriptionRow = { id: string; userId: string; ownerName: string | null; ownerEmail: string; planId: string; interval: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; cancellationRequestedAt: Date | null; createdAt: Date; updatedAt: Date };
export type AdminManualAccessRow = { id: string; userId: string; ownerName: string | null; ownerEmail: string; planId: string; startsAt: Date; expiresAt: Date; createdAt: Date; paymentReferenceAvailable: boolean };
export type AdminBillingIntentRow = { id: string; userId: string; ownerName: string | null; ownerEmail: string; planId: string; interval: string; amountPaise: number | null; currency: string; status: string; createdAt: Date; updatedAt: Date; billingMode: "recurring" | "manual" };
export type AdminPlanEntitlementRow = { userId: string; name: string | null; email: string; planId: string; source: "free_fallback" | "recurring_subscription" | "subscription_trial" | "manual_access" | "complimentary_access" | "inconsistent"; subscriptionStatus: string | null; subscriptionPeriodEnd: Date | null; manualAccessExpiresAt: Date | null; planDefinitionAvailable: boolean; inconsistentStoredPlan: boolean };
export type AdminPlanCounts = { byPlan: Record<PlanId, number>; unknownPlanCount: number };
export type AdminPlanEntitlementSummary = { complete: boolean; totalUsers: number; byPlan: Record<PlanId, number>; bySource: Record<"recurring_subscription" | "subscription_trial" | "manual_access", number>; inconsistentEntitlements: number; unavailableReason: string | null };
export type AdminAnalyticsReport = {
  generatedAt: Date; from: Date; to: Date;
  series: { day: string; registrations: number; campaignsCreated: number; publishingQueued: number; publishingAttempted: number; publishingRecorded: number; publishingFailed: number; publishingNeedsReview: number }[];
  users: { registrationsInRange: number };
  campaigns: { createdInRange: number; currentStatusesForCyclesCreatedInRange: Record<string, number>; unrecognizedStatusCount: number };
  publishing: { attemptsCreatedInRange: number; currentStateCounts: Record<string, number>; unclassifiedCount: number };
  instagram: { accountsCreatedInRange: number; storedStatusCounts: Record<string, number>; unrecognizedStatusCount: number };
  payments: { paymentRecordsInRange: number; storedStatusCounts: Record<string, number>; unrecognizedStatusCount: number; monetaryMetrics: "unavailable" };
  subscriptions: { rowsCreatedInRange: number; currentStoredStatusCounts: Record<string, number>; allCurrentRowsByPlan: Record<PlanId, number>; unknownPlanRowCount: number };
  plans: AdminPlanEntitlementSummary;
  dataQuality: { incompleteCollections: string[]; historicalStatusTransitions: "not_stored"; refundFeeTaxData: "not_stored" };
};
export type AdminPaymentDetails = {
  payment: { id: string; amountPaise: number; currency: string; status: string; providerPaymentId: string; providerSubscriptionId: string | null; createdAt: Date; billingMode: AdminPaymentRow["billingMode"] };
  owner: { id: string; name: string | null; email: string } | null;
  plan: { planId: string; interval: string; expectedAmountPaise: number | null; currency: string; intentStatus: string; createdAt: Date; updatedAt: Date } | null;
  currentSubscription: { planId: string; interval: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; cancellationRequestedAt: Date | null } | null;
  manualAccess: { planId: string; startsAt: Date; expiresAt: Date; createdAt: Date } | null;
  unavailableInformation: string[];
};
export type AdminAuditActorKind = "admin_action_namespace" | "actor_type_unavailable" | "system_or_actor_unavailable";
export type AdminAuditRow = { id: string; actorId: string | null; actorKind: AdminAuditActorKind; action: string; entityType: string; entityId: string; createdAt: Date; outcome: "not_stored" };
export type AdminAuditDetails = { event: AdminAuditRow; metadata: "withheld"; historicalActorRole: "not_stored"; outcomeStatus: "not_stored" };
export type AdminUserDetails = {
  profile: AdminUserRow;
  subscription: { planId: string; interval: string; status: string; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; cancellationRequestedAt: Date | null; createdAt: Date; updatedAt: Date } | null;
  subscriptionIntents: { id: string; planId: string; interval: string; amountPaise: number | null; currency: string; status: string; createdAt: Date; updatedAt: Date }[];
  manualPaymentIntents: { id: string; planId: string; interval: string; amountPaise: number; currency: string; status: string; accessStartsAt: Date | null; accessEndsAt: Date | null; createdAt: Date; updatedAt: Date }[];
  manualAccessPeriods: { id: string; intentId: string; planId: string; startsAt: Date; expiresAt: Date; createdAt: Date }[];
  payments: { id: string; amountPaise: number; currency: string; status: string; providerPaymentId: string; providerSubscriptionId: string | null; createdAt: Date }[];
  socialAccounts: { id: string; platform: string; username: string | null; accountType: string | null; grantedScopes: string | null; status: string; tokenExpiresAt: Date | null; createdAt: Date }[];
  cycles: { id: string; name: string; status: string; timezone: string; createdAt: Date; updatedAt: Date; itemCount: number; scheduledItemCount: number }[];
  reels: { id: string; cycleId: string; position: number; status: string; scheduledFor: Date | null; publishedAt: Date | null; externalPostId: string | null; createdAt: Date }[];
  publishingAttempts: { id: string; cycleId: string; cycleItemId: string; attemptNumber: number; stage: string; outcome: string; errorCategory: string | null; instagramMediaId: string | null; createdAt: Date; startedAt: Date; finishedAt: Date | null }[];
  auditHistory: AdminAuditRow[];
  usageActivity: { id: string; kind: string; amount: string; periodStart: Date; createdAt: Date }[];
  historyTruncated: { subscriptionIntents: boolean; manualPaymentIntents: boolean; manualAccessPeriods: boolean; payments: boolean; socialAccounts: boolean; cycles: boolean; reels: boolean; publishingAttempts: boolean; auditHistory: boolean; usageActivity: boolean };
};
export type AdminOverview = {
  generatedAt: Date;
  users: { registered: number };
  cycles: { total: number; byStatus: Record<string, number> };
  publishing: { totalAttempts: number; byStage: Record<string, number>; byOutcome: Record<string, number> };
  instagram: { totalStoredAccounts: number; byStoredStatus: Record<string, number> };
  billing: { paymentRecordCount: number; recordsByRecognizedStoredStatus: Record<string, number>; unclassifiedStatusCount: number; monetaryMetrics: "unavailable" };
  unavailableMetrics: string[];
};

export interface AdminDataRepository {
  getOverview(generatedAt: Date): Promise<AdminOverview>;
  listUsers(query: AdminListQuery): Promise<AdminPage<AdminUserRow>>;
  listCycles(query: AdminListQuery): Promise<AdminPage<AdminCycleRow>>;
  listSocialAccounts(query: AdminListQuery, now: Date): Promise<AdminPage<AdminSocialAccountRow>>;
  listPayments(query: AdminListQuery): Promise<AdminPage<AdminPaymentRow>>;
  listSubscriptions(query: AdminListQuery): Promise<AdminPage<AdminSubscriptionRow>>;
  listManualAccess(query: AdminListQuery): Promise<AdminPage<AdminManualAccessRow>>;
  listRecurringIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>>;
  listManualPaymentIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>>;
  getSubscriptionCountsByPlan(): Promise<AdminPlanCounts>;
  getPlanEntitlementSummary(now: Date): Promise<AdminPlanEntitlementSummary>;
  listPlanEntitlements(query: AdminListQuery, now: Date): Promise<AdminPage<AdminPlanEntitlementRow>>;
  getAnalyticsReport(from: Date, to: Date, generatedAt: Date): Promise<AdminAnalyticsReport>;
  getPaymentDetails(paymentId: string): Promise<AdminPaymentDetails | null>;
  listAudit(query: AdminListQuery): Promise<AdminPage<AdminAuditRow>>;
  getAuditDetails(auditId: string): Promise<AdminAuditDetails | null>;
  getUserDetails(userId: string): Promise<AdminUserDetails | null>;
  getCycleDetails(cycleId: string): Promise<AdminCycleDetails | null>;
  getInstagramAccountDetails(accountId: string, now: Date): Promise<AdminInstagramDetails | null>;
}

const USER_SELECT = { id: true, name: true, email: true, emailVerified: true, role: true, createdAt: true };
const CYCLE_SELECT = { id: true, ownerId: true, name: true, status: true, timezone: true, createdAt: true, updatedAt: true };
const ACCOUNT_SELECT = { id: true, userId: true, platform: true, username: true, accountType: true, grantedScopes: true, status: true, tokenExpiresAt: true, createdAt: true };
const PAYMENT_SELECT = { id: true, userId: true, amountPaise: true, currency: true, status: true, providerPaymentId: true, providerSubscriptionId: true, subscriptionIntentId: true, manualPaymentIntentId: true, createdAt: true };
const AUDIT_SELECT = { id: true, actorId: true, action: true, entityType: true, entityId: true, createdAt: true };
const HISTORY_LIMIT = 50;
const DETAIL_LIMIT = 100;
const ANALYTICS_ROW_LIMIT = 5_000;

function toDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  throw new Error("Admin data contained an invalid date.");
}
function nullableDate(value: unknown): Date | null { return value == null ? null : toDate(value); }
function str(row: Row, key: string): string { if (typeof row[key] !== "string") throw new Error(`Admin data field ${key} was invalid.`); return row[key] as string; }
function nullableStr(row: Row, key: string): string | null { const value = row[key]; return value == null ? null : typeof value === "string" ? value : null; }
function num(row: Row, key: string): number { const value = Number(row[key]); if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Admin data field ${key} was invalid.`); return value; }
function bool(row: Row, key: string): boolean { return row[key] === true; }
function parseStoredSchedule(value: unknown): AdminStoredSchedule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row["timeZone"] !== "string" || typeof row["intervalMinutes"] !== "number" || typeof row["postsPerInterval"] !== "number" || !Array.isArray(row["daysOfWeek"]) || !row["daysOfWeek"].every((day) => typeof day === "number") || typeof row["windowStart"] !== "string" || typeof row["windowEnd"] !== "string" || !(typeof row["dailyMax"] === "number" || row["dailyMax"] === null) || !(typeof row["endDate"] === "string" || row["endDate"] === null) || typeof row["startDate"] !== "string") return null;
  const dateOk = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) && new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date;
  const settings: ScheduleSettings = { timeZone: row["timeZone"], intervalMinutes: row["intervalMinutes"], postsPerInterval: row["postsPerInterval"], daysOfWeek: row["daysOfWeek"] as number[], windowStart: row["windowStart"], windowEnd: row["windowEnd"], dailyMax: row["dailyMax"], endDate: row["endDate"] };
  if (!dateOk(row["startDate"]) || (settings.endDate !== null && (!dateOk(settings.endDate) || settings.endDate < row["startDate"])) || !validateScheduleSettings(settings).valid) return null;
  return { ...settings, daysOfWeek: [...settings.daysOfWeek], startDate: row["startDate"] };
}
function pageWhere(query: AdminListQuery): Where {
  const where: Where = {};
  if (query.from || query.to) where["createdAt"] = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) };
  return where;
}
function makePage<T>(items: T[], total: number, query: AdminListQuery): AdminPage<T> { return { items, total, page: query.page, pageSize: query.pageSize }; }

function mapAuditRow(row: Row): AdminAuditRow {
  const actorId = nullableStr(row, "actorId"); const action = str(row, "action");
  const actorKind: AdminAuditActorKind = !actorId ? "system_or_actor_unavailable" : action.startsWith("admin.") ? "admin_action_namespace" : "actor_type_unavailable";
  return { id: str(row, "id"), actorId, actorKind, action, entityType: str(row, "entityType"), entityId: str(row, "entityId"), createdAt: toDate(row["createdAt"]), outcome: "not_stored" };
}
const CYCLE_STATUSES = ["draft", "running", "paused", "stopped", "completed"] as const;
const PUBLISHING_STAGES = ["queued", "claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing", "published", "failed", "needs_manual_review", "cancelled"] as const;
const PUBLISH_OUTCOMES = ["in_progress", "success", "definite_failure", "ambiguous"] as const;
const ACCOUNT_STATUSES = ["connected", "token_expired", "revoked", "disconnected"] as const;

function storedPublishingState(row: Row): "queued" | "attempted" | "published_recorded" | "failed" | "needs_review" | "cancelled" | "other" {
  const stage = str(row, "stage"); const outcome = str(row, "outcome");
  if (stage === "needs_manual_review" || outcome === "ambiguous") return "needs_review";
  if (stage === "failed" || outcome === "definite_failure") return "failed";
  if (stage === "published" && outcome === "success") return "published_recorded";
  if (stage === "queued") return "queued";
  if (stage === "cancelled") return "cancelled";
  if (["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"].includes(stage) || outcome === "in_progress") return "attempted";
  return "other";
}
function dayKey(value: unknown): string { return toDate(value).toISOString().slice(0, 10); }
function countKnown(rows: Row[], key: string, known: readonly string[]): { counts: Record<string, number>; unrecognized: number } {
  const counts = Object.fromEntries(known.map((status) => [status, 0])); let unrecognized = 0;
  for (const row of rows) { const status = str(row, key); if (Object.hasOwn(counts, status)) counts[status] = (counts[status] ?? 0) + 1; else unrecognized++; }
  return { counts, unrecognized };
}

function storedInstagramState(status: string, expiry: Date | null, now: Date): AdminSocialAccountRow["storedConnectionState"] {
  if (status === "disconnected") return "disconnected";
  if (status === "revoked") return "revoked";
  if (status === "token_expired" || (expiry !== null && expiry <= now)) return "expired";
  if (status === "connected") return "connected";
  return "unknown";
}
function storedInstagramEligibility(row: { status: string; accountType: string | null; grantedScopes: string | null; tokenExpiresAt: Date | null }, tokenStored: boolean, now: Date) {
  const normalized = normalizeInstagramScopes(row.grantedScopes);
  const eligibility = evaluateInstagramEligibility({ platform: "instagram", status: row.status, accountType: row.accountType, grantedScopes: row.grantedScopes, hasToken: tokenStored, tokenExpiresAt: row.tokenExpiresAt, now });
  return { normalized, eligibility, permissionStatus: normalized.malformed ? "malformed" as const : eligibility.missingScopes.length ? "incomplete" as const : "complete" as const };
}

async function countCycleItems(db: PrismaClientLike, cycleIds: string[]): Promise<Map<string, { total: number; scheduled: number }>> {
  const counts = new Map<string, { total: number; scheduled: number }>();
  for (let start = 0; start < cycleIds.length; start += 5) {
    const batch = cycleIds.slice(start, start + 5);
    const batchCounts = await Promise.all(batch.map(async (cycleId) => {
      const [total, scheduled] = await Promise.all([
        db.cycleItem.count({ where: { cycleId } }),
        db.cycleItem.count({ where: { cycleId, scheduledFor: { not: null } } }),
      ]);
      return [cycleId, { total, scheduled }] as const;
    }));
    for (const [cycleId, value] of batchCounts) counts.set(cycleId, value);
  }
  return counts;
}

/** Dedicated cross-user query layer. Every query selects only fields intended for Admin DTOs. */
export class PrismaAdminDataRepository implements AdminDataRepository {
  constructor(private readonly db: PrismaClientLike) {}

  async getOverview(generatedAt: Date): Promise<AdminOverview> {
    const PAYMENT_STATUSES = ["captured", "authorized", "failed", "refunded", "partially_refunded", "created"] as const;
    const [registered, cycleTotal, cycleCounts, publishingTotal, stageCounts, outcomeCounts, accountTotal, accountCounts, paymentTotal, paymentCounts] = await Promise.all([
      this.db.user.count({ where: { role: "user" } }),
      this.db.publishingCycle.count(),
      Promise.all(CYCLE_STATUSES.map(async (status) => [status, await this.db.publishingCycle.count({ where: { status } })] as const)),
      this.db.publishingJob.count(),
      Promise.all(PUBLISHING_STAGES.map(async (stage) => [stage, await this.db.publishingJob.count({ where: { stage } })] as const)),
      Promise.all(PUBLISH_OUTCOMES.map(async (outcome) => [outcome, await this.db.publishingJob.count({ where: { outcome } })] as const)),
      this.db.socialAccount.count(),
      Promise.all(ACCOUNT_STATUSES.map(async (status) => [status, await this.db.socialAccount.count({ where: { status } })] as const)),
      this.db.paymentRecord.count(),
      Promise.all(PAYMENT_STATUSES.map(async (status) => [status, await this.db.paymentRecord.count({ where: { status } })] as const)),
    ]);
    return {
      generatedAt,
      users: { registered },
      cycles: { total: cycleTotal, byStatus: Object.fromEntries(cycleCounts) },
      publishing: { totalAttempts: publishingTotal, byStage: Object.fromEntries(stageCounts), byOutcome: Object.fromEntries(outcomeCounts) },
      instagram: { totalStoredAccounts: accountTotal, byStoredStatus: Object.fromEntries(accountCounts) },
      billing: { paymentRecordCount: paymentTotal, recordsByRecognizedStoredStatus: Object.fromEntries(paymentCounts), unclassifiedStatusCount: Math.max(0, paymentTotal - paymentCounts.reduce((sum, [, count]) => sum + count, 0)), monetaryMetrics: "unavailable" },
      unavailableMetrics: ["active/inactive users (no authoritative activity state)", "plan entitlements across recurring and manual access", "gross collections, refunds, provider fees, taxes, net revenue", "date-wise activity series"],
    };
  }

  async listUsers(query: AdminListQuery): Promise<AdminPage<AdminUserRow>> {
    const where = pageWhere(query);
    if (query.search) where["OR"] = [
      { id: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
    ];
    where["role"] = "user";
    if (query.verified !== undefined) where["emailVerified"] = query.verified ? { not: null } : null;
    const [rows, total] = await Promise.all([
      this.db.user.findMany({ where, select: USER_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.user.count({ where }),
    ]);
    return makePage(rows.map((row) => ({ id: str(row, "id"), name: nullableStr(row, "name"), email: str(row, "email"), emailVerified: nullableDate(row["emailVerified"]), role: str(row, "role"), createdAt: toDate(row["createdAt"]) })), total, query);
  }

  async listCycles(query: AdminListQuery): Promise<AdminPage<AdminCycleRow>> {
    const where = pageWhere(query);
    if (query.status) where["status"] = query.status;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { name: { contains: query.search, mode: "insensitive" } }, { ownerId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.publishingCycle.findMany({ where, select: CYCLE_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.publishingCycle.count({ where }),
    ]);
    const ids = rows.map((row) => str(row, "id"));
    const owners = [...new Set(rows.map((row) => str(row, "ownerId")))];
    const [users, itemCounts] = await Promise.all([
      owners.length ? this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
      countCycleItems(this.db, ids),
    ]);
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    return makePage(rows.map((row) => {
      const ownerId = str(row, "ownerId"); const owner = userMap.get(ownerId); const itemCount = itemCounts.get(str(row, "id"));
      return { id: str(row, "id"), ownerId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", name: str(row, "name"), status: str(row, "status"), timezone: str(row, "timezone"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]), itemCount: itemCount?.total ?? 0, scheduledItemCount: itemCount?.scheduled ?? 0 };
    }), total, query);
  }

  async listSocialAccounts(query: AdminListQuery, now: Date): Promise<AdminPage<AdminSocialAccountRow>> {
    const where = pageWhere(query); where["platform"] = "instagram";
    if (query.status) where["status"] = query.status;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { username: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.socialAccount.findMany({ where, select: ACCOUNT_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.socialAccount.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const accountIds = rows.map((row) => str(row, "id"));
    const [users, tokenRows] = await Promise.all([
      owners.length ? this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
      accountIds.length ? this.db.socialAccount.findMany({ where: { id: { in: accountIds }, encryptedAccessToken: { not: null } }, select: { id: true } }) : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    const tokenIds = new Set(tokenRows.map((row) => str(row, "id")));
    return makePage(rows.map((row) => {
      const id = str(row, "id"); const userId = str(row, "userId"); const owner = userMap.get(userId); const status = str(row, "status"); const accountType = nullableStr(row, "accountType"); const grantedScopes = nullableStr(row, "grantedScopes"); const tokenExpiresAt = nullableDate(row["tokenExpiresAt"]); const tokenStored = tokenIds.has(id);
      const profile = { status, accountType, grantedScopes, tokenExpiresAt }; const assessment = storedInstagramEligibility(profile, tokenStored, now);
      return { id, userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", platform: str(row, "platform"), username: nullableStr(row, "username"), accountType, grantedRequiredScopes: assessment.normalized.malformed ? [] : INSTAGRAM_REQUIRED_SCOPES.filter((scope) => assessment.normalized.scopes.includes(scope)), status, tokenExpiresAt, createdAt: toDate(row["createdAt"]), tokenStored, permissionStatus: assessment.permissionStatus, missingRequiredScopes: assessment.eligibility.missingScopes, storedConnectionState: storedInstagramState(status, tokenExpiresAt, now), eligibilityReason: assessment.eligibility.reason };
    }), total, query);
  }

  async listPayments(query: AdminListQuery): Promise<AdminPage<AdminPaymentRow>> {
    const where = pageWhere(query);
    if (query.status) where["status"] = query.status;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }, { providerPaymentId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.paymentRecord.findMany({ where, select: PAYMENT_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.paymentRecord.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const subscriptionIntentIds = [...new Set(rows.map((row) => nullableStr(row, "subscriptionIntentId")).filter((id): id is string => id !== null))];
    const manualIntentIds = [...new Set(rows.map((row) => nullableStr(row, "manualPaymentIntentId")).filter((id): id is string => id !== null))];
    const [users, subscriptionIntents, manualIntents] = await Promise.all([
      owners.length ? this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
      subscriptionIntentIds.length ? this.db.razorpaySubscriptionIntent.findMany({ where: { id: { in: subscriptionIntentIds } }, select: { id: true, userId: true, planId: true, interval: true, providerSubscriptionId: true } }) : Promise.resolve([]),
      manualIntentIds.length ? this.db.manualPaymentIntent.findMany({ where: { id: { in: manualIntentIds } }, select: { id: true, userId: true, planId: true, interval: true } }) : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    const recurringMap = new Map(subscriptionIntents.map((row) => [str(row, "id"), row]));
    const manualMap = new Map(manualIntents.map((row) => [str(row, "id"), row]));
    return makePage(rows.map((row) => {
      const userId = str(row, "userId"); const owner = userMap.get(userId); const recurringId = nullableStr(row, "subscriptionIntentId"); const manualId = nullableStr(row, "manualPaymentIntentId");
      const recurring = recurringId ? recurringMap.get(recurringId) : undefined; const manual = manualId ? manualMap.get(manualId) : undefined;
      const recordedProviderSubscriptionId = nullableStr(row, "providerSubscriptionId");
      const recurringValid = recurring && str(recurring, "userId") === userId && (!recordedProviderSubscriptionId || recordedProviderSubscriptionId === nullableStr(recurring, "providerSubscriptionId")); const manualValid = manual && str(manual, "userId") === userId && !recordedProviderSubscriptionId;
      const billingMode: AdminPaymentRow["billingMode"] = recurringValid && manualValid ? "conflicting" : recurringValid ? "recurring" : manualValid ? "manual" : (recurringId || manualId) ? "conflicting" : "unlinked";
      const intent = recurringValid ? recurring : manualValid ? manual : undefined;
      return { id: str(row, "id"), userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", amountPaise: num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), providerPaymentId: str(row, "providerPaymentId"), providerSubscriptionId: nullableStr(row, "providerSubscriptionId"), planId: intent ? str(intent, "planId") : null, interval: intent ? str(intent, "interval") : null, billingMode, createdAt: toDate(row["createdAt"]) };
    }), total, query);
  }

  async listSubscriptions(query: AdminListQuery): Promise<AdminPage<AdminSubscriptionRow>> {
    const where = pageWhere(query);
    if (query.status) where["status"] = query.status;
    if (query.planId) where["planId"] = query.planId;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }, { planId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.subscription.findMany({ where, select: { id: true, userId: true, planId: true, interval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, cancellationRequestedAt: true, createdAt: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.subscription.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const users = owners.length ? await this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : [];
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    return makePage(rows.map((row) => { const userId = str(row, "userId"); const owner = userMap.get(userId); return { id: str(row, "id"), userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", planId: str(row, "planId"), interval: str(row, "interval"), status: str(row, "status"), currentPeriodEnd: nullableDate(row["currentPeriodEnd"]), cancelAtPeriodEnd: bool(row, "cancelAtPeriodEnd"), cancellationRequestedAt: nullableDate(row["cancellationRequestedAt"]), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]) }; }), total, query);
  }

  async getSubscriptionCountsByPlan(): Promise<AdminPlanCounts> {
    const [total, ...counts] = await Promise.all([
      this.db.subscription.count(),
      ...PLAN_IDS.map(async (planId) => this.db.subscription.count({ where: { planId } })),
    ]);
    const byPlan = Object.fromEntries(PLAN_IDS.map((planId, index) => [planId, counts[index] ?? 0])) as Record<PlanId, number>;
    return { byPlan, unknownPlanCount: Math.max(0, total - Object.values(byPlan).reduce((sum, count) => sum + count, 0)) };
  }

  async getPlanEntitlementSummary(now: Date): Promise<AdminPlanEntitlementSummary> {
    const totalUsers = await this.db.user.count({ where: { role: "user" } });
    const nowUnix = BigInt(Math.floor(now.getTime() / 1000));
    const [subscriptionRows, manualRows] = await Promise.all([
      this.db.subscription.findMany({
        where: { OR: [
          { status: "authenticated", trialEndsAt: { gt: nowUnix } },
          { status: { in: ["active", "pending"] }, currentPeriodEnd: { gt: now }, razorpaySubscriptionId: { not: null } },
          { status: "cancelled", cancelAtPeriodEnd: true, currentPeriodEnd: { gt: now }, razorpaySubscriptionId: { not: null } },
        ] },
        select: { userId: true, planId: true, interval: true, status: true, razorpaySubscriptionId: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, trialEndsAt: true },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1,
      }),
      this.db.manualPlanAccess.findMany({ where: { startsAt: { lte: now }, expiresAt: { gt: now } }, select: { userId: true, planId: true, startsAt: true, expiresAt: true }, orderBy: [{ expiresAt: "desc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
    ]);
    if (subscriptionRows.length > ANALYTICS_ROW_LIMIT || manualRows.length > ANALYTICS_ROW_LIMIT) return { complete: false, totalUsers, byPlan: { free: 0, creator: 0, pro: 0, agency: 0 }, bySource: { recurring_subscription: 0, subscription_trial: 0, manual_access: 0 }, inconsistentEntitlements: 0, unavailableReason: "Current entitlement records exceeded the bounded analytics read; no partial totals are presented." };
    const candidateRows = subscriptionRows.filter((row) => ["active", "pending", "cancelled"].includes(str(row, "status")) && nullableStr(row, "razorpaySubscriptionId") !== null);
    const captured = new Set<string>(); let capturedRowsSeen = 0;
    for (let start = 0; start < candidateRows.length; start += 250) {
      const batch = candidateRows.slice(start, start + 250);
      const userIds = [...new Set(batch.map((row) => str(row, "userId")))];
      const providerIds = [...new Set(batch.map((row) => nullableStr(row, "razorpaySubscriptionId")).filter((id): id is string => id !== null))];
      const rows = await this.db.paymentRecord.findMany({ where: { userId: { in: userIds }, providerSubscriptionId: { in: providerIds }, status: "captured" }, select: { userId: true, providerSubscriptionId: true }, take: ANALYTICS_ROW_LIMIT + 1 });
      capturedRowsSeen += rows.length;
      if (capturedRowsSeen > ANALYTICS_ROW_LIMIT) return { complete: false, totalUsers, byPlan: { free: 0, creator: 0, pro: 0, agency: 0 }, bySource: { recurring_subscription: 0, subscription_trial: 0, manual_access: 0 }, inconsistentEntitlements: 0, unavailableReason: "Captured recurring payment references exceeded the bounded analytics read; no partial totals are presented." };
      for (const row of rows) captured.add(`${str(row, "userId")}:${str(row, "providerSubscriptionId")}`);
    }
    const entitlement = new Map<string, { planId: PlanId; source: "recurring_subscription" | "subscription_trial" | "manual_access" }>();
    const inconsistent = new Set<string>();
    for (const row of subscriptionRows) {
      const userId = str(row, "userId"); const status = str(row, "status"); const storedPlan = str(row, "planId");
      const trialInPeriod = status === "authenticated" && row["trialEndsAt"] != null && Number(row["trialEndsAt"]) > Math.floor(now.getTime() / 1000);
      const trial = trialInPeriod && isPlanId(storedPlan) && effectivePlanId({ planId: storedPlan, interval: str(row, "interval") as "weekly" | "monthly", status: "authenticated", lastEventAt: 0, processedEventIds: [], trialEndsAt: Number(row["trialEndsAt"]) }, Math.floor(now.getTime() / 1000)) !== "free";
      const end = nullableDate(row["currentPeriodEnd"]); const providerId = nullableStr(row, "razorpaySubscriptionId");
      const recurring = (["active", "pending"].includes(status) || (status === "cancelled" && bool(row, "cancelAtPeriodEnd"))) && end !== null && end > now && providerId !== null && captured.has(`${userId}:${providerId}`);
      if (!trial && !recurring && !(trialInPeriod && !isPlanId(storedPlan))) continue;
      if (!isPlanId(storedPlan)) { inconsistent.add(userId); continue; }
      entitlement.set(userId, { planId: storedPlan, source: trial ? "subscription_trial" : "recurring_subscription" });
    }
    for (const row of manualRows) {
      const userId = str(row, "userId"); if (entitlement.has(userId) || inconsistent.has(userId)) continue;
      const storedPlan = str(row, "planId");
      if (!isPlanId(storedPlan)) { inconsistent.add(userId); continue; }
      entitlement.set(userId, { planId: storedPlan, source: "manual_access" });
    }
    const byPlan: Record<PlanId, number> = { free: 0, creator: 0, pro: 0, agency: 0 };
    const bySource = { recurring_subscription: 0, subscription_trial: 0, manual_access: 0 };
    for (const value of entitlement.values()) { byPlan[value.planId]++; bySource[value.source]++; }
    const entitled = entitlement.size + inconsistent.size;
    byPlan.free = Math.max(0, totalUsers - entitled);
    return { complete: true, totalUsers, byPlan, bySource, inconsistentEntitlements: inconsistent.size, unavailableReason: null };
  }

  async getAnalyticsReport(from: Date, to: Date, generatedAt: Date): Promise<AdminAnalyticsReport> {
    const createdAt = { gte: from, lte: to };
    const [userRows, cycleRows, publishingRows, accountRows, paymentRows, subscriptionRows, planCounts, plans] = await Promise.all([
      this.db.user.findMany({ where: { role: "user", createdAt }, select: { createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.db.publishingCycle.findMany({ where: { createdAt }, select: { createdAt: true, status: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.db.publishingJob.findMany({ where: { createdAt }, select: { createdAt: true, stage: true, outcome: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.db.socialAccount.findMany({ where: { createdAt }, select: { createdAt: true, status: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.db.paymentRecord.findMany({ where: { createdAt }, select: { createdAt: true, status: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.db.subscription.findMany({ where: { createdAt }, select: { status: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: ANALYTICS_ROW_LIMIT + 1 }),
      this.getSubscriptionCountsByPlan(), this.getPlanEntitlementSummary(generatedAt),
    ]);
    const incompleteCollections = [
      ["user registrations", userRows], ["campaigns", cycleRows], ["publishing attempts", publishingRows], ["Instagram account records", accountRows], ["payment records", paymentRows], ["subscription records", subscriptionRows],
    ].filter(([, rows]) => (rows as Row[]).length > ANALYTICS_ROW_LIMIT).map(([name]) => String(name));
    if (!plans.complete) incompleteCollections.push("current plan entitlements");
    const users = userRows.slice(0, ANALYTICS_ROW_LIMIT); const cycles = cycleRows.slice(0, ANALYTICS_ROW_LIMIT); const jobs = publishingRows.slice(0, ANALYTICS_ROW_LIMIT); const accounts = accountRows.slice(0, ANALYTICS_ROW_LIMIT); const payments = paymentRows.slice(0, ANALYTICS_ROW_LIMIT); const subscriptions = subscriptionRows.slice(0, ANALYTICS_ROW_LIMIT);
    const series = new Map<string, AdminAnalyticsReport["series"][number]>();
    for (let timestamp = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); timestamp <= to.getTime(); timestamp += 86_400_000) {
      const day = new Date(timestamp).toISOString().slice(0, 10);
      series.set(day, { day, registrations: 0, campaignsCreated: 0, publishingQueued: 0, publishingAttempted: 0, publishingRecorded: 0, publishingFailed: 0, publishingNeedsReview: 0 });
    }
    for (const row of users) { const entry = series.get(dayKey(row["createdAt"])); if (entry) entry.registrations++; }
    for (const row of cycles) { const entry = series.get(dayKey(row["createdAt"])); if (entry) entry.campaignsCreated++; }
    const publishingCounts: Record<string, number> = { queued: 0, attempted: 0, published_recorded: 0, failed: 0, needs_review: 0, cancelled: 0 };
    let unclassifiedCount = 0;
    for (const row of jobs) {
      const state = storedPublishingState(row); const entry = series.get(dayKey(row["createdAt"]));
      if (state === "other") { unclassifiedCount++; continue; }
      publishingCounts[state] = (publishingCounts[state] ?? 0) + 1;
      if (entry && state === "queued") entry.publishingQueued++;
      else if (entry && state === "attempted") entry.publishingAttempted++;
      else if (entry && state === "published_recorded") entry.publishingRecorded++;
      else if (entry && state === "failed") entry.publishingFailed++;
      else if (entry && state === "needs_review") entry.publishingNeedsReview++;
    }
    const campaignStatuses = countKnown(cycles, "status", CYCLE_STATUSES);
    const instagramStatuses = countKnown(accounts, "status", ACCOUNT_STATUSES);
    const paymentStatuses = countKnown(payments, "status", ["captured", "authorized", "failed", "refunded", "partially_refunded", "created"]);
    const subscriptionStatuses = countKnown(subscriptions, "status", ["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"]);
    return {
      generatedAt, from, to, series: [...series.values()], users: { registrationsInRange: users.length },
      campaigns: { createdInRange: cycles.length, currentStatusesForCyclesCreatedInRange: campaignStatuses.counts, unrecognizedStatusCount: campaignStatuses.unrecognized },
      publishing: { attemptsCreatedInRange: jobs.length, currentStateCounts: publishingCounts, unclassifiedCount },
      instagram: { accountsCreatedInRange: accounts.length, storedStatusCounts: instagramStatuses.counts, unrecognizedStatusCount: instagramStatuses.unrecognized },
      payments: { paymentRecordsInRange: payments.length, storedStatusCounts: paymentStatuses.counts, unrecognizedStatusCount: paymentStatuses.unrecognized, monetaryMetrics: "unavailable" },
      subscriptions: { rowsCreatedInRange: subscriptions.length, currentStoredStatusCounts: subscriptionStatuses.counts, allCurrentRowsByPlan: planCounts.byPlan, unknownPlanRowCount: planCounts.unknownPlanCount },
      plans, dataQuality: { incompleteCollections, historicalStatusTransitions: "not_stored", refundFeeTaxData: "not_stored" },
    };
  }

  async listPlanEntitlements(query: AdminListQuery, now: Date): Promise<AdminPage<AdminPlanEntitlementRow>> {
    const where: Where = { role: "user" };
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { email: { contains: query.search, mode: "insensitive" } }, { name: { contains: query.search, mode: "insensitive" } }];
    const [users, total] = await Promise.all([
      this.db.user.findMany({ where, select: { id: true, name: true, email: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.user.count({ where }),
    ]);
    const userIds = users.map((row) => str(row, "id"));
    if (!userIds.length) return makePage([], total, query);
    const [subscriptions, manualAccessRows, complimentaryRows] = await Promise.all([
      this.db.subscription.findMany({ where: { userId: { in: userIds } }, select: { userId: true, planId: true, interval: true, status: true, razorpaySubscriptionId: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, cancellationRequestedAt: true, trialEndsAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] }),
      this.db.manualPlanAccess.findMany({ where: { userId: { in: userIds }, startsAt: { lte: now }, expiresAt: { gt: now } }, select: { userId: true, planId: true, startsAt: true, expiresAt: true }, orderBy: [{ expiresAt: "desc" }, { id: "asc" }] }),
      this.db.complimentaryAccessGrant.findMany({ where: { userId: { in: userIds }, status: "ACTIVE" }, select: { userId: true, planId: true } }),
    ]);
    const providerIds = [...new Set(subscriptions.map((row) => nullableStr(row, "razorpaySubscriptionId")).filter((id): id is string => id !== null))];
    const paidRows = providerIds.length ? await this.db.paymentRecord.findMany({ where: { userId: { in: userIds }, providerSubscriptionId: { in: providerIds }, status: "captured" }, select: { userId: true, providerSubscriptionId: true } }) : [];
    const paidSubscriptionKeys = new Set(paidRows.map((row) => `${str(row, "userId")}:${str(row, "providerSubscriptionId")}`));
    const subscriptionByUser = new Map(subscriptions.map((row) => [str(row, "userId"), row]));
    const manualByUser = new Map<string, Row>();
    for (const row of manualAccessRows) if (!manualByUser.has(str(row, "userId"))) manualByUser.set(str(row, "userId"), row);
    const complimentaryByUser = new Map(complimentaryRows.map((row) => [str(row, "userId"), row]));
    const items = users.map((user): AdminPlanEntitlementRow => {
      const userId = str(user, "id"); const subscription = subscriptionByUser.get(userId); const manual = manualByUser.get(userId);
      const periodEnd = subscription ? nullableDate(subscription["currentPeriodEnd"]) : null;
      let planId = "free"; let source: AdminPlanEntitlementRow["source"] = "free_fallback";
      if (subscription) {
        const storedPlan = str(subscription, "planId"); const status = str(subscription, "status");
        const providerId = nullableStr(subscription, "razorpaySubscriptionId");
        const trialInPeriod = status === "authenticated" && subscription["trialEndsAt"] != null && Number(subscription["trialEndsAt"]) > Math.floor(now.getTime() / 1000);
        if (trialInPeriod) {
          if (!isPlanId(storedPlan)) { planId = "unknown"; source = "inconsistent"; }
          else {
          const trialEnd = Number(subscription["trialEndsAt"]);
          if (effectivePlanId({ planId: storedPlan, interval: str(subscription, "interval") as "weekly" | "monthly", status: "authenticated", lastEventAt: 0, processedEventIds: [], trialEndsAt: trialEnd }, Math.floor(now.getTime() / 1000)) !== "free") { planId = storedPlan; source = "subscription_trial"; }
          }
        } else if ((status === "active" || status === "pending" || (status === "cancelled" && bool(subscription, "cancelAtPeriodEnd"))) && providerId && periodEnd && periodEnd > now && paidSubscriptionKeys.has(`${userId}:${providerId}`)) {
          if (isPlanId(storedPlan)) { planId = storedPlan; source = "recurring_subscription"; }
          else { planId = "unknown"; source = "inconsistent"; }
        }
      }
      if (source === "free_fallback" && manual) {
        const storedPlan = str(manual, "planId");
        if (isPlanId(storedPlan)) { planId = storedPlan; source = "manual_access"; }
        else { planId = "unknown"; source = "inconsistent"; }
      }
      const complimentary = complimentaryByUser.get(userId);
      const complimentaryPlan = complimentary ? str(complimentary, "planId") : null;
      const tier = (id: string): number => ({ free: 0, creator: 1, pro: 2, agency: 3 }[id] ?? -1);
      if (complimentaryPlan && isPlanId(complimentaryPlan) && tier(complimentaryPlan) > tier(planId)) { planId = complimentaryPlan; source = "complimentary_access"; }
      const inconsistentStoredPlan = Boolean((subscription && !isPlanId(str(subscription, "planId"))) || (manual && !isPlanId(str(manual, "planId"))));
      return { userId, name: nullableStr(user, "name"), email: str(user, "email"), planId, source, subscriptionStatus: subscription ? str(subscription, "status") : null, subscriptionPeriodEnd: periodEnd, manualAccessExpiresAt: source === "manual_access" ? nullableDate(manual?.["expiresAt"]) : null, planDefinitionAvailable: isPlanId(planId), inconsistentStoredPlan };
    });
    return makePage(items, total, query);
  }

  async listManualAccess(query: AdminListQuery): Promise<AdminPage<AdminManualAccessRow>> {
    const where = pageWhere(query);
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }, { planId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.manualPlanAccess.findMany({ where, select: { id: true, userId: true, planId: true, startsAt: true, expiresAt: true, createdAt: true, providerPaymentId: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.manualPlanAccess.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const users = owners.length ? await this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : [];
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    return makePage(rows.map((row) => { const userId = str(row, "userId"); const owner = userMap.get(userId); return { id: str(row, "id"), userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", planId: str(row, "planId"), startsAt: toDate(row["startsAt"]), expiresAt: toDate(row["expiresAt"]), createdAt: toDate(row["createdAt"]), paymentReferenceAvailable: typeof row["providerPaymentId"] === "string" && row["providerPaymentId"].length > 0 }; }), total, query);
  }

  async listRecurringIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>> {
    const where = pageWhere(query);
    if (query.status) where["status"] = query.status;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }, { planId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.razorpaySubscriptionIntent.findMany({ where, select: { id: true, userId: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.razorpaySubscriptionIntent.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const users = owners.length ? await this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : [];
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    return makePage(rows.map((row) => { const userId = str(row, "userId"); const owner = userMap.get(userId); return { id: str(row, "id"), userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", planId: str(row, "planId"), interval: str(row, "interval"), amountPaise: row["amountPaise"] === null ? null : num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]), billingMode: "recurring" as const }; }), total, query);
  }

  async listManualPaymentIntents(query: AdminListQuery): Promise<AdminPage<AdminBillingIntentRow>> {
    const where = pageWhere(query);
    if (query.status) where["status"] = query.status;
    if (query.search) where["OR"] = [{ id: { contains: query.search, mode: "insensitive" } }, { userId: { contains: query.search, mode: "insensitive" } }, { planId: { contains: query.search, mode: "insensitive" } }];
    const [rows, total] = await Promise.all([
      this.db.manualPaymentIntent.findMany({ where, select: { id: true, userId: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.manualPaymentIntent.count({ where }),
    ]);
    const owners = [...new Set(rows.map((row) => str(row, "userId")))];
    const users = owners.length ? await this.db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true, email: true } }) : [];
    const userMap = new Map(users.map((row) => [str(row, "id"), { name: nullableStr(row, "name"), email: str(row, "email") }]));
    return makePage(rows.map((row) => { const userId = str(row, "userId"); const owner = userMap.get(userId); return { id: str(row, "id"), userId, ownerName: owner?.name ?? null, ownerEmail: owner?.email ?? "unknown", planId: str(row, "planId"), interval: str(row, "interval"), amountPaise: num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]), billingMode: "manual" as const }; }), total, query);
  }

  async getPaymentDetails(paymentId: string): Promise<AdminPaymentDetails | null> {
    const row = await this.db.paymentRecord.findUnique({ where: { id: paymentId }, select: PAYMENT_SELECT });
    if (!row) return null;
    const userId = str(row, "userId"); const recurringId = nullableStr(row, "subscriptionIntentId"); const manualId = nullableStr(row, "manualPaymentIntentId");
    const [ownerRow, recurringRow, manualRow] = await Promise.all([
      this.db.user.findUnique({ where: { id: userId, role: "user" }, select: { id: true, name: true, email: true } }),
      recurringId ? this.db.razorpaySubscriptionIntent.findUnique({ where: { id: recurringId }, select: { id: true, userId: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, providerSubscriptionId: true, createdAt: true, updatedAt: true } }) : Promise.resolve(null),
      manualId ? this.db.manualPaymentIntent.findUnique({ where: { id: manualId }, select: { id: true, userId: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, accessStartsAt: true, accessEndsAt: true, createdAt: true, updatedAt: true } }) : Promise.resolve(null),
    ]);
    const recordedProviderSubscriptionId = nullableStr(row, "providerSubscriptionId");
    const recurringValid = recurringRow && str(recurringRow, "userId") === userId && (!recordedProviderSubscriptionId || recordedProviderSubscriptionId === nullableStr(recurringRow, "providerSubscriptionId")); const manualValid = manualRow && str(manualRow, "userId") === userId && !recordedProviderSubscriptionId;
    const billingMode: AdminPaymentRow["billingMode"] = recurringValid && manualValid ? "conflicting" : recurringValid ? "recurring" : manualValid ? "manual" : (recurringId || manualId) ? "conflicting" : "unlinked";
    const linked = recurringValid ? recurringRow : manualValid ? manualRow : null;
    let currentSubscription: AdminPaymentDetails["currentSubscription"] = null;
    let manualAccess: AdminPaymentDetails["manualAccess"] = null;
    if (recurringValid && recurringRow && nullableStr(recurringRow, "providerSubscriptionId")) {
      const sub = await this.db.subscription.findFirst({ where: { userId, planId: str(recurringRow, "planId"), interval: str(recurringRow, "interval"), razorpaySubscriptionId: nullableStr(recurringRow, "providerSubscriptionId") }, select: { planId: true, interval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, cancellationRequestedAt: true } });
      if (sub) currentSubscription = { planId: str(sub, "planId"), interval: str(sub, "interval"), status: str(sub, "status"), currentPeriodEnd: nullableDate(sub["currentPeriodEnd"]), cancelAtPeriodEnd: bool(sub, "cancelAtPeriodEnd"), cancellationRequestedAt: nullableDate(sub["cancellationRequestedAt"]) };
    }
    if (manualValid && manualRow) {
      const access = await this.db.manualPlanAccess.findFirst({ where: { intentId: str(manualRow, "id"), userId }, select: { planId: true, startsAt: true, expiresAt: true, createdAt: true } });
      if (access && str(access, "planId") === str(manualRow, "planId")) manualAccess = { planId: str(access, "planId"), startsAt: toDate(access["startsAt"]), expiresAt: toDate(access["expiresAt"]), createdAt: toDate(access["createdAt"]) };
    }
    return {
      payment: { id: str(row, "id"), amountPaise: num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), providerPaymentId: str(row, "providerPaymentId"), providerSubscriptionId: nullableStr(row, "providerSubscriptionId"), createdAt: toDate(row["createdAt"]), billingMode },
      owner: ownerRow ? { id: str(ownerRow, "id"), name: nullableStr(ownerRow, "name"), email: str(ownerRow, "email") } : null,
      plan: linked ? { planId: str(linked, "planId"), interval: str(linked, "interval"), expectedAmountPaise: linked["amountPaise"] === null ? null : num(linked, "amountPaise"), currency: str(linked, "currency"), intentStatus: str(linked, "status"), createdAt: toDate(linked["createdAt"]), updatedAt: toDate(linked["updatedAt"]) } : null,
      currentSubscription, manualAccess,
      unavailableInformation: ["payment method is not stored", "refund records and refund amounts are not stored", "gateway transaction fees are not stored", "tax breakdown is not stored", "raw webhook events are not linked to a payment record"],
    };
  }

  async listAudit(query: AdminListQuery): Promise<AdminPage<AdminAuditRow>> {
    const filters: Where[] = [];
    if (query.from || query.to) filters.push({ createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } });
    if (query.search) filters.push({ OR: [{ action: { contains: query.search, mode: "insensitive" } }, { entityType: { contains: query.search, mode: "insensitive" } }, { entityId: { contains: query.search, mode: "insensitive" } }, { actorId: { contains: query.search, mode: "insensitive" } }] });
    if (query.actorId) filters.push({ actorId: { contains: query.actorId, mode: "insensitive" } });
    if (query.action) filters.push({ action: { contains: query.action, mode: "insensitive" } });
    if (query.targetType) filters.push({ entityType: { contains: query.targetType, mode: "insensitive" } });
    if (query.targetId) filters.push({ entityId: { contains: query.targetId, mode: "insensitive" } });
    const where: Where = filters.length > 1 ? { AND: filters } : filters[0] ?? {};
    const [rows, total] = await Promise.all([
      this.db.auditLog.findMany({ where, select: AUDIT_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.db.auditLog.count({ where }),
    ]);
    return makePage(rows.map(mapAuditRow), total, query);
  }

  async getAuditDetails(auditId: string): Promise<AdminAuditDetails | null> {
    const row = await this.db.auditLog.findUnique({ where: { id: auditId }, select: AUDIT_SELECT });
    if (!row) return null;
    return { event: mapAuditRow(row), metadata: "withheld", historicalActorRole: "not_stored", outcomeStatus: "not_stored" };
  }

  async getUserDetails(userId: string): Promise<AdminUserDetails | null> {
    const profileRow = await this.db.user.findUnique({ where: { id: userId, role: "user" }, select: USER_SELECT });
    if (!profileRow) return null;
    const profile: AdminUserRow = { id: str(profileRow, "id"), name: nullableStr(profileRow, "name"), email: str(profileRow, "email"), emailVerified: nullableDate(profileRow["emailVerified"]), role: str(profileRow, "role"), createdAt: toDate(profileRow["createdAt"]) };
    const [subscriptionRow, intentRows, manualIntentRows, accessRows, paymentRows, accountRows, cycleRows, usageRows] = await Promise.all([
      this.db.subscription.findFirst({ where: { userId }, select: { planId: true, interval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, cancellationRequestedAt: true, createdAt: true, updatedAt: true } }),
      this.db.razorpaySubscriptionIntent.findMany({ where: { userId }, select: { id: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.manualPaymentIntent.findMany({ where: { userId }, select: { id: true, planId: true, interval: true, amountPaise: true, currency: true, status: true, accessStartsAt: true, accessEndsAt: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.manualPlanAccess.findMany({ where: { userId }, select: { id: true, intentId: true, planId: true, startsAt: true, expiresAt: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.paymentRecord.findMany({ where: { userId }, select: { id: true, amountPaise: true, currency: true, status: true, providerPaymentId: true, providerSubscriptionId: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.socialAccount.findMany({ where: { userId }, select: { id: true, platform: true, username: true, accountType: true, grantedScopes: true, status: true, tokenExpiresAt: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.publishingCycle.findMany({ where: { ownerId: userId }, select: { id: true, name: true, status: true, timezone: true, createdAt: true, updatedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.usageRecord.findMany({ where: { userId }, select: { id: true, kind: true, amount: true, periodStart: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
    ]);
    const cycleRowsLimited = cycleRows.slice(0, HISTORY_LIMIT);
    const cycleIds = cycleRowsLimited.map((row) => str(row, "id"));
    const [itemRows, attemptRows, cycleCounts] = cycleIds.length ? await Promise.all([
      this.db.cycleItem.findMany({ where: { cycleId: { in: cycleIds } }, select: { id: true, cycleId: true, position: true, status: true, scheduledFor: true, publishedAt: true, externalPostId: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.publishingJob.findMany({ where: { ownerId: userId, cycleId: { in: cycleIds } }, select: { id: true, cycleId: true, cycleItemId: true, attemptNumber: true, stage: true, outcome: true, errorCategory: true, instagramMediaId: true, createdAt: true, startedAt: true, finishedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      countCycleItems(this.db, cycleIds),
    ]) : [[], [], new Map<string, { total: number; scheduled: number }>()];
    const auditWhere: Where = { OR: [{ actorId: userId }, { entityType: "user", entityId: userId }, ...(cycleIds.length ? [{ entityType: "cycle", entityId: { in: cycleIds } }] : [])] };
    const auditRows = await this.db.auditLog.findMany({ where: auditWhere, select: AUDIT_SELECT, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 });
    const cycles = cycleRowsLimited.map((row) => { const id = str(row, "id"); const counts = cycleCounts.get(id); return { id, name: str(row, "name"), status: str(row, "status"), timezone: str(row, "timezone"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]), itemCount: counts?.total ?? 0, scheduledItemCount: counts?.scheduled ?? 0 }; });
    const subscription = subscriptionRow ? { planId: str(subscriptionRow, "planId"), interval: str(subscriptionRow, "interval"), status: str(subscriptionRow, "status"), currentPeriodEnd: nullableDate(subscriptionRow["currentPeriodEnd"]), cancelAtPeriodEnd: subscriptionRow["cancelAtPeriodEnd"] === true, cancellationRequestedAt: nullableDate(subscriptionRow["cancellationRequestedAt"]), createdAt: toDate(subscriptionRow["createdAt"]), updatedAt: toDate(subscriptionRow["updatedAt"]) } : null;
    const mapIntent = (row: Row) => ({ id: str(row, "id"), planId: str(row, "planId"), interval: str(row, "interval"), amountPaise: row["amountPaise"] === null ? null : num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]) });
    const mapManualIntent = (row: Row) => ({ ...mapIntent(row), amountPaise: num(row, "amountPaise") });
    return {
      profile, subscription,
      subscriptionIntents: intentRows.slice(0, HISTORY_LIMIT).map(mapIntent),
      manualPaymentIntents: manualIntentRows.slice(0, HISTORY_LIMIT).map((row) => ({ ...mapManualIntent(row), accessStartsAt: nullableDate(row["accessStartsAt"]), accessEndsAt: nullableDate(row["accessEndsAt"]) })),
      manualAccessPeriods: accessRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), intentId: str(row, "intentId"), planId: str(row, "planId"), startsAt: toDate(row["startsAt"]), expiresAt: toDate(row["expiresAt"]), createdAt: toDate(row["createdAt"]) })),
      payments: paymentRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), amountPaise: num(row, "amountPaise"), currency: str(row, "currency"), status: str(row, "status"), providerPaymentId: str(row, "providerPaymentId"), providerSubscriptionId: nullableStr(row, "providerSubscriptionId"), createdAt: toDate(row["createdAt"]) })),
      socialAccounts: accountRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), platform: str(row, "platform"), username: nullableStr(row, "username"), accountType: nullableStr(row, "accountType"), grantedScopes: nullableStr(row, "grantedScopes"), status: str(row, "status"), tokenExpiresAt: nullableDate(row["tokenExpiresAt"]), createdAt: toDate(row["createdAt"]) })),
      cycles,
      reels: itemRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), cycleId: str(row, "cycleId"), position: num(row, "position"), status: str(row, "status"), scheduledFor: nullableDate(row["scheduledFor"]), publishedAt: nullableDate(row["publishedAt"]), externalPostId: nullableStr(row, "externalPostId"), createdAt: toDate(row["createdAt"]) })),
      publishingAttempts: attemptRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), cycleId: str(row, "cycleId"), cycleItemId: str(row, "cycleItemId"), attemptNumber: num(row, "attemptNumber"), stage: str(row, "stage"), outcome: str(row, "outcome"), errorCategory: nullableStr(row, "errorCategory"), instagramMediaId: nullableStr(row, "instagramMediaId"), createdAt: toDate(row["createdAt"]), startedAt: toDate(row["startedAt"]), finishedAt: nullableDate(row["finishedAt"]) })),
      auditHistory: auditRows.slice(0, HISTORY_LIMIT).map(mapAuditRow),
      usageActivity: usageRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), kind: str(row, "kind"), amount: String(row["amount"]), periodStart: toDate(row["periodStart"]), createdAt: toDate(row["createdAt"]) })),
      historyTruncated: { subscriptionIntents: intentRows.length > HISTORY_LIMIT, manualPaymentIntents: manualIntentRows.length > HISTORY_LIMIT, manualAccessPeriods: accessRows.length > HISTORY_LIMIT, payments: paymentRows.length > HISTORY_LIMIT, socialAccounts: accountRows.length > HISTORY_LIMIT, cycles: cycleRows.length > HISTORY_LIMIT, reels: itemRows.length > HISTORY_LIMIT, publishingAttempts: attemptRows.length > HISTORY_LIMIT, auditHistory: auditRows.length > HISTORY_LIMIT, usageActivity: usageRows.length > HISTORY_LIMIT },
    };
  }

  async getCycleDetails(cycleId: string): Promise<AdminCycleDetails | null> {
    const cycleRow = await this.db.publishingCycle.findUnique({ where: { id: cycleId }, select: { id: true, ownerId: true, socialAccountId: true, name: true, status: true, finalReviewConfirmed: true, orderMode: true, repeatBehavior: true, timezone: true, scheduleSettings: true, createdAt: true, updatedAt: true } });
    if (!cycleRow) return null;
    const ownerId = str(cycleRow, "ownerId");
    const [ownerRow, accountRow, itemRows, attemptRows] = await Promise.all([
      this.db.user.findUnique({ where: { id: ownerId, role: "user" }, select: { id: true, name: true, email: true } }),
      this.db.socialAccount.findUnique({ where: { id: str(cycleRow, "socialAccountId") }, select: { id: true, userId: true, platform: true, username: true, accountType: true, grantedScopes: true, status: true, tokenExpiresAt: true } }),
      this.db.cycleItem.findMany({ where: { cycleId }, select: { id: true, cycleId: true, cycleOwnerId: true, mediaAssetId: true, selectedRenderOutputId: true, selectedRenderOwnerId: true, selectedRenderSourceMediaId: true, sourceKind: true, status: true, position: true, scheduledFor: true, publishedAt: true, externalPostId: true, coverState: true, createdAt: true }, orderBy: [{ position: "asc" }, { id: "asc" }], take: DETAIL_LIMIT + 1 }),
      this.db.publishingJob.findMany({ where: { cycleId, ownerId }, select: { id: true, ownerId: true, cycleId: true, cycleItemId: true, attemptNumber: true, stage: true, outcome: true, errorCategory: true, createdAt: true, startedAt: true, finishedAt: true }, orderBy: [{ cycleItemId: "asc" }, { attemptNumber: "asc" }, { id: "asc" }], take: DETAIL_LIMIT + 1 }),
    ]);
    const itemsLimited = itemRows.slice(0, DETAIL_LIMIT);
    const mediaIds = [...new Set(itemsLimited.map((row) => str(row, "mediaAssetId")))];
    const renderIds = [...new Set(itemsLimited.map((row) => nullableStr(row, "selectedRenderOutputId")).filter((id): id is string => id !== null))];
    const [mediaRows, renderRows] = await Promise.all([
      mediaIds.length ? this.db.mediaAsset.findMany({ where: { id: { in: mediaIds } }, select: { id: true, ownerId: true, originalFilename: true, kind: true, status: true, metadataValidated: true } }) : Promise.resolve([]),
      renderIds.length ? this.db.mediaDerivative.findMany({ where: { id: { in: renderIds } }, select: { id: true, ownerId: true, mediaAssetId: true, kind: true } }) : Promise.resolve([]),
    ]);
    const mediaById = new Map(mediaRows.map((row) => [str(row, "id"), { ownerId: str(row, "ownerId"), filename: str(row, "originalFilename"), kind: str(row, "kind"), status: str(row, "status"), metadataValidated: bool(row, "metadataValidated") }]));
    const renderById = new Map(renderRows.map((row) => [str(row, "id"), { ownerId: str(row, "ownerId"), mediaAssetId: str(row, "mediaAssetId"), kind: str(row, "kind") }]));
    const safeAttempts: AdminCampaignAttempt[] = attemptRows.slice(0, DETAIL_LIMIT).map((row) => ({ id: str(row, "id"), cycleItemId: str(row, "cycleItemId"), attemptNumber: num(row, "attemptNumber"), stage: str(row, "stage"), outcome: str(row, "outcome"), errorCategory: nullableStr(row, "errorCategory"), createdAt: toDate(row["createdAt"]), startedAt: toDate(row["startedAt"]), finishedAt: nullableDate(row["finishedAt"]) }));
    const latestByItem = new Map<string, AdminCampaignAttempt>();
    for (const attempt of safeAttempts) { const old = latestByItem.get(attempt.cycleItemId); if (!old || attempt.attemptNumber > old.attemptNumber || (attempt.attemptNumber === old.attemptNumber && attempt.createdAt > old.createdAt)) latestByItem.set(attempt.cycleItemId, attempt); }
    const items: AdminCycleItemDetails[] = itemsLimited.map((row) => {
      const id = str(row, "id"); const mediaAssetId = str(row, "mediaAssetId"); const source = mediaById.get(mediaAssetId); const selectedRenderOutputId = nullableStr(row, "selectedRenderOutputId"); const render = selectedRenderOutputId ? renderById.get(selectedRenderOutputId) : undefined;
      const renderValid = Boolean(selectedRenderOutputId && render && render.kind === "render" && render.ownerId === ownerId && render.mediaAssetId === mediaAssetId && nullableStr(row, "selectedRenderOwnerId") === ownerId && nullableStr(row, "selectedRenderSourceMediaId") === mediaAssetId);
      const latest = latestByItem.get(id); const state = str(row, "status");
      let publishingState: AdminCycleItemDetails["publishingState"] = "not_started";
      if ((state === "published" && nullableDate(row["publishedAt"]) !== null && nullableStr(row, "externalPostId") !== null) || (latest?.stage === "published" && latest.outcome === "success")) publishingState = "published_recorded";
      else if (state === "needs_review" || latest?.stage === "needs_manual_review" || latest?.outcome === "ambiguous") publishingState = "needs_review";
      else if (state === "failed" || latest?.stage === "failed" || latest?.outcome === "definite_failure") publishingState = "failed";
      else if (latest?.stage === "queued") publishingState = "queued";
      else if (latest || state === "processing" || state === "publishing") publishingState = "attempted";
      return {
        id, position: num(row, "position"), sourceKind: str(row, "sourceKind"), status: state, mediaAssetId,
        originalMedia: source ? { filename: source.filename, kind: source.kind, status: source.status, metadataValidated: source.metadataValidated } : null,
        selectedRenderOutputId, selectedRenderStatus: selectedRenderOutputId ? (renderValid ? "available" : "missing_or_mismatched") : "not_selected",
        scheduledFor: nullableDate(row["scheduledFor"]), publishedAt: nullableDate(row["publishedAt"]), coverState: str(row, "coverState"),
        scheduleState: row["scheduledFor"] instanceof Date ? "scheduled" : "not_scheduled", publishingState, latestAttemptNumber: latest?.attemptNumber ?? null,
      };
    });
    let accountAssociation: AdminCycleDetails["accountAssociation"] = "missing";
    let instagramAccount: AdminCycleDetails["instagramAccount"] = null;
    if (accountRow) {
      if (str(accountRow, "userId") !== ownerId) accountAssociation = "owner_mismatch";
      else if (str(accountRow, "platform") !== "instagram") accountAssociation = "unsupported_platform";
      else {
        accountAssociation = "verified_owner_account";
        instagramAccount = { id: str(accountRow, "id"), username: nullableStr(accountRow, "username"), accountType: nullableStr(accountRow, "accountType"), scopes: nullableStr(accountRow, "grantedScopes"), storedStatus: str(accountRow, "status"), tokenExpiresAt: nullableDate(accountRow["tokenExpiresAt"]) };
      }
    }
    const schedule = parseStoredSchedule(cycleRow["scheduleSettings"]);
    return {
      cycle: { id: str(cycleRow, "id"), name: str(cycleRow, "name"), status: str(cycleRow, "status"), finalReviewConfirmed: bool(cycleRow, "finalReviewConfirmed"), orderMode: str(cycleRow, "orderMode"), repeatBehavior: str(cycleRow, "repeatBehavior"), timezone: str(cycleRow, "timezone"), schedule, scheduleAvailable: schedule !== null, createdAt: toDate(cycleRow["createdAt"]), updatedAt: toDate(cycleRow["updatedAt"]) },
      owner: ownerRow ? { id: str(ownerRow, "id"), name: nullableStr(ownerRow, "name"), email: str(ownerRow, "email") } : null,
      instagramAccount, accountAssociation, items, publishingAttempts: safeAttempts,
      historyTruncated: { items: itemRows.length > DETAIL_LIMIT, publishingAttempts: attemptRows.length > DETAIL_LIMIT },
    };
  }

  async getInstagramAccountDetails(accountId: string, now: Date): Promise<AdminInstagramDetails | null> {
    const accountRow = await this.db.socialAccount.findFirst({ where: { id: accountId, platform: "instagram" }, select: { id: true, userId: true, platform: true, username: true, accountType: true, grantedScopes: true, status: true, tokenExpiresAt: true, createdAt: true } });
    if (!accountRow) return null;
    const ownerId = str(accountRow, "userId");
    const [ownerRow, tokenRow, campaignRows, attemptRows] = await Promise.all([
      this.db.user.findUnique({ where: { id: ownerId, role: "user" }, select: { id: true, name: true, email: true } }),
      this.db.socialAccount.findFirst({ where: { id: accountId, encryptedAccessToken: { not: null } }, select: { id: true } }),
      this.db.publishingCycle.findMany({ where: { ownerId, socialAccountId: accountId }, select: { id: true, ownerId: true, socialAccountId: true, name: true, status: true, timezone: true, createdAt: true, updatedAt: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: HISTORY_LIMIT + 1 }),
      this.db.publishingJob.findMany({ where: { ownerId, socialAccountId: accountId }, select: { id: true, ownerId: true, socialAccountId: true, cycleId: true, cycleItemId: true, attemptNumber: true, stage: true, outcome: true, errorCategory: true, createdAt: true, startedAt: true, finishedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: DETAIL_LIMIT + 1 }),
    ]);
    const tokenStored = tokenRow !== null;
    const status = str(accountRow, "status"); const accountType = nullableStr(accountRow, "accountType"); const grantedScopes = nullableStr(accountRow, "grantedScopes"); const tokenExpiresAt = nullableDate(accountRow["tokenExpiresAt"]);
    const assessment = storedInstagramEligibility({ status, accountType, grantedScopes, tokenExpiresAt }, tokenStored, now);
    const campaigns = campaignRows.slice(0, HISTORY_LIMIT).map((row) => ({ id: str(row, "id"), name: str(row, "name"), status: str(row, "status"), timezone: str(row, "timezone"), createdAt: toDate(row["createdAt"]), updatedAt: toDate(row["updatedAt"]) }));
    const activityRows = attemptRows.slice(0, DETAIL_LIMIT);
    const cycleIds = [...new Set(activityRows.map((row) => str(row, "cycleId")))];
    const itemIds = [...new Set(activityRows.map((row) => str(row, "cycleItemId")))];
    const [relatedCycles, items] = await Promise.all([
      cycleIds.length ? this.db.publishingCycle.findMany({ where: { id: { in: cycleIds }, ownerId, socialAccountId: accountId }, select: { id: true, name: true } }) : Promise.resolve([]),
      itemIds.length ? this.db.cycleItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, cycleId: true, status: true, scheduledFor: true } }) : Promise.resolve([]),
    ]);
    const cycleById = new Map(relatedCycles.map((row) => [str(row, "id"), str(row, "name")]));
    const itemById = new Map(items.map((row) => [str(row, "id"), { cycleId: str(row, "cycleId"), status: str(row, "status"), scheduledFor: nullableDate(row["scheduledFor"]) }]));
    return {
      account: { id: str(accountRow, "id"), username: nullableStr(accountRow, "username"), accountType, storedStatus: status, tokenExpiresAt, createdAt: toDate(accountRow["createdAt"]), updatedInformation: "unavailable" },
      owner: ownerRow ? { id: str(ownerRow, "id"), name: nullableStr(ownerRow, "name"), email: str(ownerRow, "email") } : null,
      tokenStored,
      storedConnectionState: storedInstagramState(status, tokenExpiresAt, now),
      permissions: { status: assessment.permissionStatus, grantedRequiredScopes: assessment.normalized.malformed ? [] : INSTAGRAM_REQUIRED_SCOPES.filter((scope) => assessment.normalized.scopes.includes(scope)), missingRequiredScopes: assessment.eligibility.missingScopes },
      storedEligibility: { eligibleFromStoredFields: assessment.eligibility.eligible, reason: assessment.eligibility.reason },
      restrictionState: "not_stored", liveMetaVerified: false,
      campaigns,
      publishingActivity: activityRows.map((row) => {
        const cycleId = str(row, "cycleId"); const cycleItemId = str(row, "cycleItemId"); const item = itemById.get(cycleItemId);
        const verifiedItem = item?.cycleId === cycleId ? item : undefined;
        return { id: str(row, "id"), campaignId: cycleById.has(cycleId) ? cycleId : null, campaignName: cycleById.get(cycleId) ?? null, cycleItemId, attemptNumber: num(row, "attemptNumber"), stage: str(row, "stage"), outcome: str(row, "outcome"), errorCategory: nullableStr(row, "errorCategory"), createdAt: toDate(row["createdAt"]), startedAt: toDate(row["startedAt"]), finishedAt: nullableDate(row["finishedAt"]), ...(verifiedItem ? { itemStatus: verifiedItem.status, scheduledFor: verifiedItem.scheduledFor } : {}) };
      }),
      historyTruncated: { campaigns: campaignRows.length > HISTORY_LIMIT, publishingActivity: attemptRows.length > DETAIL_LIMIT },
    };
  }
}
