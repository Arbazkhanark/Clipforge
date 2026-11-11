// In-memory Repository for tests (and local experiments). It follows the same rules as the real
// database must: every method that reads yields once (so concurrent requests really interleave),
// and the version-checked save is atomic.
import { getPlan, type PlanId } from "../lib/billing/catalog.ts";
import { randomUUID } from "node:crypto";
import type { CaptionRevision } from "../lib/domain/caption-cover-updates.ts";
import { compareMedia, mediaMatchesSearch, type MediaSort } from "../lib/domain/media-list.ts";
import type { Capability, CollectionPermissionGrant, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../lib/domain/types.ts";
import type { UsageRecordDraft } from "../lib/domain/usage-accounting.ts";
import type { ApplyVideoSettingsBatchInput, AuditEntry, ClaimPublishingAttemptInput, CreatePublishingAttemptInput, CreateRenderJobResult, CycleRecord, EditingTemplateRecord, InstagramConnectionWrite, PersistedCycleSchedule, PublishingAttemptRecord, PublishingJobRecord, PublishingAttemptUpdate, RenderJobClaim, RenderJobRecord, RenderOutputRecord, Repository, SaveRenderResult, SelectCycleItemRenderOutputInput, SocialAccountRecord, RazorpaySubscriptionIntentRecord, ReserveRazorpaySubscriptionIntentInput, RazorpayIntentStatus, ManualPaymentIntentRecord, ManualIntentStatus, SettleManualPaymentInput, TransitionCouponStatusResult } from "./repository.ts";
import { canTransitionPublishingAttempt, isActivePublishingAttempt, publishingOutcomeForStage, safePublishingError } from "../lib/domain/publishing-attempt.ts";
import { buildPublishIdempotencyKey, isCycleFinished } from "../lib/domain/cycle-state.ts";
import { decideSettledCycle, itemsEligibleForRepeat } from "../lib/domain/publish-workflow.ts";
import { evaluateInstagramEligibility } from "../lib/integrations/instagram-eligibility.ts";
import { applySubscriptionEvent, hasPaidEntitlements, type SubscriptionStatus } from "../lib/billing/subscription-state.ts";
import { accessPeriodEnd } from "../lib/billing/access-period.ts";
import { resolveDeferredAccessState, resolveEffectiveEntitlement } from "../lib/billing/entitlement-resolver.ts";
import { parseEditingSettings } from "../lib/domain/editing-settings.ts";
import { planGrantCreation, planGrantRevocation } from "../lib/domain/sharing-management.ts";
import { canCreateAccessRequest, canImportVideo, decideAccessRequest, getCollectionCapabilities, validateShareLinkSettings } from "../lib/domain/sharing-permissions.ts";
import { mediaKeyFor, stagingKeyFor } from "./storage/media-storage.ts";
import { calculateDiscountAmounts, normalizePromotionCode, promotionRedemptionTransitionAllowed, samePromotionDefinition, validDiscountSnapshot, validPromotionEventMetadata, validPromotionRecord } from "../lib/domain/promotions.ts";
import type { CreatePromotionRedemptionInput, CreatePromotionalAccessGrantInput, PromotionLifecycleEventInput, PromotionLifecycleEventRecord, PromotionRecord, PromotionRedemptionRecord, PromotionalAccessGrantRecord, RedeemFreeAccessCouponInput, RedeemFreeAccessCouponResult, ReserveDiscountedManualPaymentIntentInput, ReserveDiscountedManualPaymentIntentResult } from "./repository.ts";
import type { CollectionAccessRequestRecord, CollectionGrantMutationResult, CollectionShareLinkRecord, CollectionShareLinkSummary, CreateCollectionAccessRequestInput, CreateCollectionGrantInput, CreateCollectionShareLinkInput, DecideCollectionAccessRequestInput, MediaImportClaim, MediaImportFinalizationInput, MediaImportJobRecord, MediaImportRequestInput, MediaImportVerificationInput, RevokeCollectionGrantInput, UpdateCollectionShareLinkInput } from "./repository.ts";

const clone = <T>(value: T): T => structuredClone(value);
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : typeof value === "object" && value !== null ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}` : JSON.stringify(value) ?? "undefined";
const promotionMetadataKey = (metadata: Record<string, unknown> | null | undefined): string => JSON.stringify(metadata ? Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))) : null);
/** Fields a version-checked save may change; identity fields (id, cycleId, cycleOwnerId) never do. */
const MUTABLE_ITEM_FIELDS = ["mediaAssetId", "selectedRenderOutputId", "sourceKind", "sourceCollectionId", "status", "position", "version", "scheduledFor", "captionText", "captionSource", "coverMediaId", "coverIsCustom", "coverState", "lockedBy", "lockExpiresAt", "reviewReason"] as const;
const tick = (): Promise<void> => Promise.resolve();

export class MemoryRepository implements Repository {
  plans = new Map<string, PlanId>();
  razorpaySubscriptions = new Map<string, { userId: string; planId: PlanId; interval: "weekly" | "monthly"; status: SubscriptionStatus; lastEventAt: number; trialEndsAt?: number | null; currentPeriodEnd?: Date | null; cancelAtPeriodEnd?: boolean; cancellationRequestedAt?: Date | null }>();
  subscriptionContinuations = new Map<string, { id: string; subscriptionId: string; providerSubscriptionId: string; cycleEnd: Date; status: "reserved" | "applied" | "manual_review" | "skipped"; errorCategory?: string }>();
  razorpayWebhookEvents = new Map<string, { eventType: string; status: "processed" | "ignored" }>();
  razorpaySubscriptionIntents = new Map<string, RazorpaySubscriptionIntentRecord>();
  razorpayPayments = new Map<string, { userId: string; intentId: string; amountPaise: number; currency: string; status: string; providerSubscriptionId: string }>();
  manualPaymentIntents = new Map<string, ManualPaymentIntentRecord>();
  manualPlanAccesses = new Map<string, { id: string; userId: string; intentId: string; providerPaymentId: string; planId: PlanId; startsAt: Date; expiresAt: Date }>();
  manualPayments = new Map<string, { userId: string; intentId: string; paymentLinkId: string; amountPaise: number; currency: string; status: string }>();
  promotions = new Map<string, PromotionRecord>();
  promotionRedemptions = new Map<string, PromotionRedemptionRecord>();
  promotionalAccessGrants = new Map<string, PromotionalAccessGrantRecord>();
  promotionLifecycleEvents = new Map<string, PromotionLifecycleEventRecord>();
  userRoles = new Map<string, "user" | "admin">();
  private promotionSequence = 0n;
  private promotionLocks = new Map<string, Promise<void>>();
  cycles = new Map<string, CycleRecord>();
  items = new Map<string, CycleItem>();
  media = new Map<string, MediaAsset>();
  collections = new Map<string, VideoCollection>();
  grants: CollectionPermissionGrant[] = [];
  collectionAccessRequests = new Map<string, CollectionAccessRequestRecord>();
  collectionShareLinks = new Map<string, CollectionShareLinkRecord>();
  mediaImportJobs = new Map<string, MediaImportJobRecord>();
  socialAccounts = new Map<string, SocialAccountRecord>();
  publishingJobs = new Map<string, PublishingAttemptRecord>();
  /** Ciphertext only. Never copied onto SocialAccountRecord. */
  private instagramTokens = new Map<string, string>();
  captionRevisions: CaptionRevision[] = [];
  audit: AuditEntry[] = [];
  templates = new Map<string, EditingTemplateRecord>();
  renders = new Map<string, RenderOutputRecord & { storageKey: string; settingsHash: string }>();
  renderJobs = new Map<string, RenderJobRecord>();
  usageKeys = new Set<string>();
  storageKeys = new Map<string, string>();
  thumbnailKeys = new Map<string, string | null>();
  /** Usage per user AND month, like the UsageRecord table. Use setUsage() to fill it. */
  usageByMonth = new Map<string, { processingSeconds: number; exports: number; scheduledItems: number }>();
  setUsage(userId: string, monthStart: Date, usage: { processingSeconds: number; exports: number; scheduledItems: number }): void { this.usageByMonth.set(`${userId}|${monthStart.toISOString()}`, usage); }
  /** Test hook: runs right before a version-checked save, to simulate another request/worker winning the race. */
  beforeItemSave: (() => void) | null = null;
  /** Test hook: return false to simulate a promotion lifecycle/audit insert failure. */
  beforePromotionEventInsert: ((input: PromotionLifecycleEventInput) => boolean) | null = null;
  /** Test hook: return false to simulate the audit-log insert failing after lifecycle validation. */
  beforePromotionAuditInsert: ((input: PromotionLifecycleEventInput) => boolean) | null = null;
  /** Test hook: return false to simulate a promotional grant insert failure. */
  beforePromotionalGrantInsert: ((grant: PromotionalAccessGrantRecord) => boolean) | null = null;
  /** Failure hooks for atomic discounted checkout reservation tests. */
  beforeDiscountedIntentInsert: ((intent: ManualPaymentIntentRecord) => boolean) | null = null;
  beforeDiscountRedemptionInsert: ((redemption: PromotionRedemptionRecord) => boolean) | null = null;
  /** Test hook for each write in atomic manual-payment settlement. */
  beforeManualPaymentSettlementWrite: ((stage: "payment_record" | "manual_access" | "intent_paid" | "redemption_redeemed") => boolean) | null = null;
  /** Test hook: simulate the sharing audit insert failing after the grant write. */
  beforeSharingAuditInsert: ((entry: AuditEntry) => boolean) | null = null;
  beforeMediaImportAuditInsert: ((entry: AuditEntry) => boolean) | null = null;
  /** Test hook for atomic import writes; return false to fail before that write. */
  beforeMediaImportWrite: ((stage: "job_create" | "asset_create" | "job_transition") => boolean) | null = null;
  /** Test hook: simulate audit failure during an atomic bulk settings application. */
  beforeBulkSettingsAuditInsert: ((entry: AuditEntry) => boolean) | null = null;

  /** Test/demo seed helper; production authorization still reads the persisted user role. */
  setUserRole(userId: string, role: "user" | "admin"): void { this.userRoles.set(userId, role); }
  private async withPromotionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.promotionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.promotionLocks.set(key, current);
    await previous;
    try { return await work(); }
    finally { release(); if (this.promotionLocks.get(key) === current) this.promotionLocks.delete(key); }
  }
  private async withSharingLocks<T>(userIds: string[], collectionId: string, work: () => Promise<T>): Promise<T> {
    const users = [...new Set(userIds)].sort();
    const acquireUser = (index: number): Promise<T> => index >= users.length
      ? this.withPromotionLock(`collection:${collectionId}`, work)
      : this.withPromotionLock(`user:${users[index]}`, () => acquireUser(index + 1));
    return acquireUser(0);
  }
  private async insertPromotionEvent(input: PromotionLifecycleEventInput): Promise<boolean> {
    if (this.beforePromotionEventInsert && !this.beforePromotionEventInsert(input)) return false;
    const metadata = validPromotionEventMetadata(input.metadata);
    if (input.metadata && !metadata) return false;
    const promotion = this.promotions.get(input.promotionId);
    if (!promotion) return false;
    const redemption = input.redemptionId ? this.promotionRedemptions.get(input.redemptionId) : null;
    const grant = input.accessGrantId ? this.promotionalAccessGrants.get(input.accessGrantId) : null;
    if (input.redemptionId && (!redemption || redemption.promotionId !== input.promotionId || redemption.userId !== input.subjectUserId)) return false;
    if (input.accessGrantId && (!grant || grant.promotionId !== input.promotionId || grant.userId !== input.subjectUserId)) return false;
    if (input.actorUserId && this.userRoles.get(input.actorUserId) !== "admin") return false;
    if (input.subjectUserId && !this.userRoles.has(input.subjectUserId)) return false;
    const old = this.promotionLifecycleEvents.get(input.eventKey);
    if (old) {
      const eventMatches = old.promotionId === input.promotionId && old.eventType === input.eventType && old.subjectUserId === (input.subjectUserId ?? null) && old.actorUserId === (input.actorUserId ?? null) && old.redemptionId === (input.redemptionId ?? null) && old.accessGrantId === (input.accessGrantId ?? null) && old.outcome === (input.outcome ?? null) && old.occurredAt.getTime() === input.occurredAt.getTime() && promotionMetadataKey(old.metadata) === promotionMetadataKey(metadata);
      const entityType = input.accessGrantId ? "PromotionalAccessGrant" : input.redemptionId ? "PromotionRedemption" : "Promotion";
      const entityId = input.accessGrantId ?? input.redemptionId ?? input.promotionId;
      const auditMetadata = { eventKey: input.eventKey, outcome: input.outcome ?? null, ...(metadata ?? {}) };
      const auditMatches = this.audit.some((entry) => entry.actorId === (input.actorUserId ?? null) && entry.action === `promotion.${input.eventType}` && entry.entityType === entityType && entry.entityId === entityId && promotionMetadataKey(entry.metadata) === promotionMetadataKey(auditMetadata));
      return eventMatches && auditMatches;
    }
    const event: PromotionLifecycleEventRecord = { id: input.id || `promotion-event-${this.promotionLifecycleEvents.size + 1}`, eventKey: input.eventKey, eventType: input.eventType, promotionId: input.promotionId,
      subjectUserId: input.subjectUserId ?? null, actorUserId: input.actorUserId ?? null, redemptionId: input.redemptionId ?? null, accessGrantId: input.accessGrantId ?? null,
      occurredAt: new Date(input.occurredAt), outcome: input.outcome ?? null, metadata };
    if (this.beforePromotionAuditInsert && !this.beforePromotionAuditInsert(input)) return false;
    this.promotionLifecycleEvents.set(input.eventKey, event);
    const entityType = input.accessGrantId ? "PromotionalAccessGrant" : input.redemptionId ? "PromotionRedemption" : "Promotion";
    const entityId = input.accessGrantId ?? input.redemptionId ?? input.promotionId;
    this.audit.push({ actorId: input.actorUserId ?? null, action: `promotion.${input.eventType}`, entityType, entityId, metadata: { eventKey: input.eventKey, outcome: input.outcome ?? null, ...(metadata ?? {}) } });
    return true;
  }
  private async hasPaidAccessForPromotion(userId: string, now: Date): Promise<boolean> {
    const entry = [...this.razorpaySubscriptions.entries()].find(([, sub]) => sub.userId === userId);
    const [subscriptionId, sub] = entry ?? [undefined, undefined];
    const hasCapturedPayment = Boolean(subscriptionId && [...this.razorpayPayments.values()].some((payment) => payment.providerSubscriptionId === subscriptionId && payment.status === "captured"));
    const hasFailedPayment = Boolean(subscriptionId && [...this.razorpayPayments.values()].some((payment) => payment.providerSubscriptionId === subscriptionId && payment.status === "failed"));
    const state = resolveDeferredAccessState({
      now,
      subscription: sub ? { planId: sub.planId, status: sub.status, trialEndsAt: sub.trialEndsAt ?? null, currentPeriodEnd: sub.currentPeriodEnd ?? null, cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true, hasCapturedPayment, hasFailedPayment } : null,
      manualAccess: [...this.manualPlanAccesses.values()].filter((access) => access.userId === userId).map((access) => ({ planId: access.planId, startsAt: access.startsAt, expiresAt: access.expiresAt })),
      legacyPlanId: sub ? null : this.plans.get(userId),
    });
    return state !== "ended";
  }
  async createPromotion(record: PromotionRecord): Promise<boolean> {
    await tick();
    if (!validPromotionRecord(record) || (record.code && normalizePromotionCode(record.code) !== record.code) || this.userRoles.get(record.createdByAdminId) !== "admin" || (record.targetUserId !== null && !this.userRoles.has(record.targetUserId))) return false;
    const existing = this.promotions.get(record.id);
    if (existing) return samePromotionDefinition(existing, record);
    if (record.code !== null && [...this.promotions.values()].some((p) => p.code === record.code)) return false;
    this.promotions.set(record.id, clone(record));
    const logged = await this.insertPromotionEvent({ id: `event-${record.id}`, eventKey: `promotion:${record.id}:created`, eventType: "promotion_created", promotionId: record.id, subjectUserId: record.targetUserId, actorUserId: record.createdByAdminId, occurredAt: record.createdAt, metadata: { reason: record.reason, status: record.status } });
    if (!logged) { this.promotions.delete(record.id); return false; }
    return true;
  }
  async updateDraftPromotion(input: { record: PromotionRecord; expectedUpdatedAt: Date; actorUserId: string }): Promise<import("./repository.ts").UpdateDraftPromotionResult> {
    const { record, expectedUpdatedAt, actorUserId } = input;
    if (!Number.isFinite(expectedUpdatedAt.getTime()) || !validPromotionRecord(record) || (record.code && normalizePromotionCode(record.code) !== record.code)) return { status: "conflict" };
    return this.withPromotionLock(`user:${actorUserId}`, () => this.withPromotionLock(`promotion:${record.id}`, async () => {
      await tick();
      const current = this.promotions.get(record.id);
      if (!current) return { status: "missing" };
      if (current.status !== "draft") return { status: "not_draft" };
      if (this.userRoles.get(actorUserId) !== "admin") return { status: "conflict" };
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: "stale" };
      if ((current.type !== "discount_coupon" && current.type !== "free_access_coupon") || record.type !== current.type || record.id !== current.id || record.status !== "draft" || record.createdByAdminId !== current.createdByAdminId || record.createdAt.getTime() !== current.createdAt.getTime()) return { status: "conflict" };
      if (record.targetUserId !== null && !this.userRoles.has(record.targetUserId)) return { status: "target_user_missing" };
      if ([...this.promotionRedemptions.values()].some((row) => row.promotionId === record.id) || [...this.promotionalAccessGrants.values()].some((row) => row.promotionId === record.id)) return { status: "history" };
      if (record.code !== null && [...this.promotions.values()].some((row) => row.id !== record.id && row.code === record.code)) return { status: "duplicate_code" };

      // updatedAt is the optimistic-concurrency token. Keep it strictly increasing at the
      // schema's millisecond precision, even if two edits happen within one clock tick.
      const updatedAt = new Date(Math.max(record.updatedAt.getTime(), expectedUpdatedAt.getTime() + 1));
      const updated = { ...record, updatedAt };
      const eventKey = `promotion:${record.id}:updated:${updatedAt.getTime()}`;
      const oldAuditLength = this.audit.length;
      this.promotions.set(record.id, clone(updated));
      try {
        const logged = await this.insertPromotionEvent({
          id: `event-${record.id}-updated-${updatedAt.getTime()}`, eventKey, eventType: "promotion_updated", promotionId: record.id,
          actorUserId, occurredAt: updatedAt, metadata: { status: "draft", source: "admin_draft_edit", reason: updated.reason, reasonOld: current.reason, reasonNew: updated.reason },
        });
        if (!logged) {
          this.promotions.set(record.id, clone(current));
          this.promotionLifecycleEvents.delete(eventKey);
          this.audit.length = oldAuditLength;
          return { status: "conflict" };
        }
        return { status: "updated", promotion: clone(updated) };
      } catch {
        this.promotions.set(record.id, clone(current));
        this.promotionLifecycleEvents.delete(eventKey);
        this.audit.length = oldAuditLength;
        return { status: "conflict" };
      }
    }));
  }
  async updatePromotionReason(input: { id: string; reason: string | null; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<import("./repository.ts").UpdatePromotionReasonResult> {
    if (!Number.isFinite(input.expectedUpdatedAt.getTime()) || !Number.isFinite(input.now.getTime()) || (input.reason !== null && (typeof input.reason !== "string" || input.reason.length > 500))) return { status: "conflict" };
    return this.withPromotionLock(`user:${input.actorUserId}`, () => this.withPromotionLock(`promotion:${input.id}`, async () => {
      await tick();
      const current = this.promotions.get(input.id);
      if (!current) return { status: "missing" };
      if (this.userRoles.get(input.actorUserId) !== "admin") return { status: "conflict" };
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return { status: "stale" };
      const updatedAt = new Date(Math.max(input.now.getTime(), input.expectedUpdatedAt.getTime() + 1));
      const updated = { ...current, reason: input.reason, updatedAt };
      const eventKey = `promotion:${input.id}:reason:${updatedAt.getTime()}`;
      const event = { id: `event-${input.id}-reason-${updatedAt.getTime()}`, eventKey, eventType: "promotion_updated" as const, promotionId: input.id, actorUserId: input.actorUserId, occurredAt: updatedAt, metadata: { source: "admin_reason_update", status: current.status, reasonOld: current.reason, reasonNew: input.reason } };
      const oldAuditLength = this.audit.length;
      this.promotions.set(input.id, clone(updated));
      try {
        if (!await this.insertPromotionEvent(event)) throw new Error("Promotion reason audit could not be recorded.");
        return { status: "updated", promotion: clone(updated) };
      } catch {
        this.promotions.set(input.id, clone(current));
        this.promotionLifecycleEvents.delete(eventKey);
        this.audit.length = oldAuditLength;
        return { status: "conflict" };
      }
    }));
  }
  async transitionCouponStatus(input: { id: string; expectedStatus: "draft" | "active"; nextStatus: "active" | "paused"; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<TransitionCouponStatusResult> {
    if (!Number.isFinite(input.expectedUpdatedAt.getTime()) || !Number.isFinite(input.now.getTime()) || !((input.expectedStatus === "draft" && input.nextStatus === "active") || (input.expectedStatus === "active" && input.nextStatus === "paused"))) return { status: "conflict" };
    return this.withPromotionLock(`user:${input.actorUserId}`, () => this.withPromotionLock(`promotion:${input.id}`, async () => {
      await tick();
      const current = this.promotions.get(input.id);
      if (!current) return { status: "missing" };
      if (current.type !== "discount_coupon" && current.type !== "free_access_coupon") return { status: "not_coupon" };
      if (this.userRoles.get(input.actorUserId) !== "admin") return { status: "conflict" };
      if (current.status !== input.expectedStatus) return { status: "invalid_status" };
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return { status: "stale" };

      const updatedAt = new Date(Math.max(input.now.getTime(), input.expectedUpdatedAt.getTime() + 1));
      const updated = { ...current, status: input.nextStatus, updatedAt };
      const eventType = input.nextStatus === "paused" ? "promotion_paused" as const : "promotion_updated" as const;
      const action = input.nextStatus === "paused" ? "deactivated" : "activated";
      const eventKey = `promotion:${input.id}:${action}:${updatedAt.getTime()}`;
      const oldAuditLength = this.audit.length;
      this.promotions.set(input.id, clone(updated));
      try {
        const logged = await this.insertPromotionEvent({
          id: `event-${input.id}-${action}-${updatedAt.getTime()}`, eventKey, eventType, promotionId: input.id,
          actorUserId: input.actorUserId, occurredAt: updatedAt, metadata: { status: input.nextStatus, source: `admin_coupon_${action}` },
        });
        if (!logged) {
          this.promotions.set(input.id, clone(current)); this.promotionLifecycleEvents.delete(eventKey); this.audit.length = oldAuditLength;
          return { status: "conflict" };
        }
        return { status: "updated", promotion: clone(updated) };
      } catch {
        this.promotions.set(input.id, clone(current)); this.promotionLifecycleEvents.delete(eventKey); this.audit.length = oldAuditLength;
        return { status: "conflict" };
      }
    }));
  }
  async listPromotions(query: { skip: number; take: number; search?: string; type?: "discount_coupon" | "free_access_coupon"; status?: PromotionRecord["status"] }): Promise<{ items: PromotionRecord[]; total: number }> {
    await tick();
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const search = query.search?.toLocaleUpperCase("en-US");
    const rows = [...this.promotions.values()]
      .filter((row) => (row.type === "discount_coupon" || row.type === "free_access_coupon") && (query.type === undefined || row.type === query.type) && (query.status === undefined || row.status === query.status) && (search === undefined || row.code?.toLocaleUpperCase("en-US").includes(search)))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
    return { items: rows.slice(query.skip, query.skip + query.take).map(clone), total: rows.length };
  }
  async getPromotionUsageCounts(promotionIds: string[]) {
    await tick();
    const result: Record<string, { reserved: number; redeemed: number; released: number; manualReview: number }> = {};
    for (const id of [...new Set(promotionIds)].slice(0, 100)) result[id] = { reserved: 0, redeemed: 0, released: 0, manualReview: 0 };
    for (const row of this.promotionRedemptions.values()) {
      const counts = result[row.promotionId];
      if (!counts) continue;
      if (row.status === "reserved") counts.reserved += 1;
      else if (row.status === "redeemed") counts.redeemed += 1;
      else if (row.status === "released") counts.released += 1;
      else if (row.status === "manual_review") counts.manualReview += 1;
    }
    return result;
  }
  async listPromotionRedemptionHistory(promotionId: string, query: { skip: number; take: number }) {
    await tick();
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const rows = [...this.promotionRedemptions.values()].filter((row) => row.promotionId === promotionId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
    return { items: rows.slice(query.skip, query.skip + query.take).map((row) => ({ id: row.id, userId: row.userId, status: row.status, planId: row.planId, interval: row.interval, listPricePaise: row.listPricePaise, discountPaise: row.discountPaise, payablePaise: row.payablePaise, currency: row.currency, createdAt: clone(row.createdAt), updatedAt: clone(row.updatedAt) })), total: rows.length };
  }
  async listPromotionLifecycleHistory(promotionId: string, query: { skip: number; take: number }) {
    await tick();
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const rows = [...this.promotionLifecycleEvents.values()].filter((event) => event.promotionId === promotionId)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.id.localeCompare(b.id));
    return { items: rows.slice(query.skip, query.skip + query.take).map((event) => ({ id: event.id, eventType: event.eventType, subjectUserId: event.subjectUserId, actorUserId: event.actorUserId, redemptionId: event.redemptionId, accessGrantId: event.accessGrantId, occurredAt: clone(event.occurredAt), outcome: event.outcome, auditId: null })), total: rows.length };
  }
  async getUserPromotionRedemptionStatus(userId: string, redemptionId: string) {
    await tick();
    const redemption = this.promotionRedemptions.get(redemptionId);
    if (!redemption || redemption.userId !== userId) return null;
    const promotion = this.promotions.get(redemption.promotionId);
    if (!promotion || (promotion.type !== "discount_coupon" && promotion.type !== "free_access_coupon")) return null;
    let manualPayment: { id: string; status: ManualPaymentIntentRecord["status"]; accessStartsAt: Date | null; accessEndsAt: Date | null } | null = null;
    if (redemption.manualPaymentIntentId !== null) {
      if (redemption.manualPaymentIntentUserId !== userId) return null;
      const intent = this.manualPaymentIntents.get(redemption.manualPaymentIntentId);
      if (!intent || intent.userId !== userId) return null;
      manualPayment = { id: intent.id, status: intent.status, accessStartsAt: intent.accessStartsAt ? clone(intent.accessStartsAt) : null, accessEndsAt: intent.accessEndsAt ? clone(intent.accessEndsAt) : null };
    } else if (redemption.manualPaymentIntentUserId !== null || promotion.type === "discount_coupon") return null;
    const matchingGrants = [...this.promotionalAccessGrants.values()].filter((grant) => grant.redemptionId === redemptionId);
    if (matchingGrants.length > 1) return null;
    const grantRecord = matchingGrants[0] ?? null;
    if (grantRecord && (grantRecord.userId !== userId || grantRecord.promotionId !== promotion.id || grantRecord.kind !== "free_access_coupon")) return null;
    if (promotion.type === "discount_coupon" && grantRecord) return null;
    if (promotion.type === "free_access_coupon" && (!grantRecord || redemption.status !== "redeemed")) return null;
    return {
      redemption: { id: redemption.id, promotionId: redemption.promotionId, userId: redemption.userId, status: redemption.status, planId: redemption.planId, interval: redemption.interval, listPricePaise: redemption.listPricePaise, discountPaise: redemption.discountPaise, payablePaise: redemption.payablePaise, currency: redemption.currency, redeemedAt: redemption.redeemedAt ? clone(redemption.redeemedAt) : null, createdAt: clone(redemption.createdAt), updatedAt: clone(redemption.updatedAt) },
      coupon: { status: promotion.status, startsAt: clone(promotion.startsAt), expiresAt: promotion.expiresAt ? clone(promotion.expiresAt) : null },
      manualPayment,
      grant: grantRecord ? { id: grantRecord.id, status: grantRecord.status, planId: grantRecord.planId, startsAt: grantRecord.startsAt ? clone(grantRecord.startsAt) : null, expiresAt: grantRecord.expiresAt ? clone(grantRecord.expiresAt) : null } : null,
    };
  }
  async getPromotion(id: string): Promise<PromotionRecord | null> { await tick(); const row = this.promotions.get(id); return row ? clone(row) : null; }
  async getPromotionByCode(code: string): Promise<PromotionRecord | null> { await tick(); const normalized = normalizePromotionCode(code); if (!/^[A-Z0-9_-]{3,64}$/.test(normalized)) return null; const row = [...this.promotions.values()].find((p) => p.code === normalized); return row ? clone(row) : null; }
  async createOrGetPromotionRedemption(input: CreatePromotionRedemptionInput): Promise<{ status: "created" | "existing" | "conflict"; redemption?: PromotionRedemptionRecord }> {
    // Match the database lock order: user first, then promotion.
    return this.withPromotionLock(`user:${input.userId}`, () => this.withPromotionLock(`promotion:${input.promotionId}`, async () => {
      await tick();
      const p = this.promotions.get(input.promotionId);
      if (!p || p.type !== "discount_coupon" || !this.userRoles.has(input.userId)) return { status: "conflict" as const };
      const oldKey = [...this.promotionRedemptions.values()].find((r) => r.userId === input.userId && r.idempotencyKey === input.idempotencyKey);
      if (oldKey) {
        const exact = oldKey.promotionId === input.promotionId && oldKey.planId === (input.planId ?? null) && oldKey.interval === (input.interval ?? null) && oldKey.listPricePaise === (input.listPricePaise ?? null) && oldKey.discountPaise === (input.discountPaise ?? null) && oldKey.payablePaise === (input.payablePaise ?? null);
        return exact ? { status: "existing" as const, redemption: clone(oldKey) } : { status: "conflict" as const };
      }
      const discounted = input.planId !== undefined && input.planId !== null && input.interval !== undefined && input.interval !== null && input.listPricePaise !== undefined && input.listPricePaise !== null && input.discountPaise !== undefined && input.discountPaise !== null && input.payablePaise !== undefined && input.payablePaise !== null && validDiscountSnapshot(p, { userId: input.userId, planId: input.planId, interval: input.interval, listPricePaise: input.listPricePaise, discountPaise: input.discountPaise, payablePaise: input.payablePaise, now: input.now });
      if (!discounted) return { status: "conflict" as const };
      if ([...this.promotionRedemptions.values()].some((r) => r.promotionId === input.promotionId && r.userId === input.userId)) return { status: "conflict" as const };
      const usage = [...this.promotionRedemptions.values()].filter((r) => r.promotionId === input.promotionId && ["reserved", "redeemed", "manual_review"].includes(r.status)).length;
      if (p.usageLimit !== null && usage >= p.usageLimit) return { status: "conflict" as const };
      if (input.manualPaymentIntentId) {
        const intent = this.manualPaymentIntents.get(input.manualPaymentIntentId);
        if (!intent || intent.userId !== input.userId || !["creating", "created"].includes(intent.status) || intent.planId !== input.planId || intent.interval !== input.interval || intent.amountPaise !== input.payablePaise) return { status: "conflict" as const };
      }
      const row: PromotionRedemptionRecord = { id: input.id, promotionId: input.promotionId, userId: input.userId, status: "reserved", idempotencyKey: input.idempotencyKey,
        planId: input.planId ?? null, interval: input.interval ?? null, listPricePaise: input.listPricePaise ?? null, discountPaise: input.discountPaise ?? null, payablePaise: input.payablePaise ?? null, currency: "INR",
        manualPaymentIntentId: input.manualPaymentIntentId ?? null, manualPaymentIntentUserId: input.manualPaymentIntentId ? input.userId : null, reservedAt: clone(input.now), redeemedAt: null, releasedAt: null, createdAt: clone(input.now), updatedAt: clone(input.now) };
      this.promotionRedemptions.set(row.id, row);
      const logged = await this.insertPromotionEvent({ id: `event-${row.id}`, eventKey: `redemption:${row.id}:reserved`, eventType: "coupon_reserved", promotionId: row.promotionId, subjectUserId: row.userId, redemptionId: row.id, occurredAt: input.now, metadata: { status: row.status, planId: row.planId, discountPaise: row.discountPaise, payablePaise: row.payablePaise } });
      if (!logged) { this.promotionRedemptions.delete(row.id); return { status: "conflict" as const }; }
      return { status: "created" as const, redemption: clone(row) };
    }));
  }
  async redeemFreeAccessCoupon(input: RedeemFreeAccessCouponInput): Promise<RedeemFreeAccessCouponResult> {
    const code = normalizePromotionCode(input.code);
    if (!/^[A-Z0-9_-]{3,64}$/.test(code) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.redemptionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.grantId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) || !Number.isFinite(input.now.getTime())) return { status: "conflict" };

    // Match the database lock order shared with paid-period writes and grant activation.
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick();
      if (!this.userRoles.has(input.userId)) return { status: "conflict" };
      const initial = [...this.promotions.values()].find((promotion) => promotion.code === code);
      if (!initial) return { status: "unavailable" };
      return this.withPromotionLock(`promotion:${initial.id}`, async () => {
        await tick();
        const promotion = this.promotions.get(initial.id);
        if (!promotion || promotion.code !== code) return { status: "unavailable" };

        const priorKey = [...this.promotionRedemptions.values()].find((row) => row.userId === input.userId && row.idempotencyKey === input.idempotencyKey);
        if (priorKey) {
          if (priorKey.promotionId !== promotion.id || priorKey.planId !== null || priorKey.interval !== null || priorKey.listPricePaise !== null || priorKey.discountPaise !== null || priorKey.payablePaise !== null || priorKey.manualPaymentIntentId !== null) return { status: "conflict" };
          const grant = [...this.promotionalAccessGrants.values()].find((row) => row.redemptionId === priorKey.id);
          if (!grant || grant.userId !== input.userId || grant.promotionId !== promotion.id || grant.kind !== "free_access_coupon") return { status: "conflict" };
          return { status: "existing", redemption: clone(priorKey), grant: clone(grant) };
        }

        if (!validPromotionRecord(promotion) || promotion.type !== "free_access_coupon" || promotion.status !== "active" || promotion.code !== code ||
          promotion.startsAt > input.now || (promotion.expiresAt !== null && promotion.expiresAt <= input.now) || (promotion.targetUserId !== null && promotion.targetUserId !== input.userId) ||
          !promotion.accessPlanId || promotion.accessPlanId === "free" || !Number.isSafeInteger(promotion.durationDays) || promotion.durationDays === null || promotion.durationDays < 1 || promotion.durationDays > 30) return { status: "unavailable" };

        // Free coupons are one-use per user, including any historical redemption state.
        if ([...this.promotionRedemptions.values()].some((row) => row.promotionId === promotion.id && row.userId === input.userId)) return { status: "unavailable" };
        const usage = [...this.promotionRedemptions.values()].filter((row) => row.promotionId === promotion.id && ["reserved", "redeemed", "manual_review"].includes(row.status)).length;
        if (promotion.usageLimit !== null && usage >= promotion.usageLimit) return { status: "unavailable" };

        const redemptionEventKey = `redemption:${input.redemptionId}:redeemed`;
        const grantEventKey = `grant:${input.grantId}:created`;
        if (this.promotionRedemptions.has(input.redemptionId) || this.promotionalAccessGrants.has(input.grantId) || this.promotionLifecycleEvents.has(redemptionEventKey) || this.promotionLifecycleEvents.has(grantEventKey)) return { status: "conflict" };
        const redemption: PromotionRedemptionRecord = {
          id: input.redemptionId, promotionId: promotion.id, userId: input.userId, status: "redeemed", idempotencyKey: input.idempotencyKey,
          planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null,
          manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: clone(input.now), redeemedAt: clone(input.now), releasedAt: null,
          createdAt: clone(input.now), updatedAt: clone(input.now),
        };
        const grant: PromotionalAccessGrantRecord = {
          id: input.grantId, promotionId: promotion.id, userId: input.userId, redemptionId: redemption.id, kind: "free_access_coupon",
          activationPolicy: "after_current_access", status: "queued", planId: promotion.accessPlanId, durationDays: promotion.durationDays,
          queueSequence: this.promotionSequence + 1n, startsAt: null, expiresAt: null, activatedAt: null, revokedAt: null,
          grantedByAdminId: null, reason: null, createdAt: clone(input.now), updatedAt: clone(input.now),
        };

        const rollback = () => {
          this.promotionRedemptions.delete(redemption.id);
          this.promotionalAccessGrants.delete(grant.id);
          this.promotionLifecycleEvents.delete(redemptionEventKey);
          this.promotionLifecycleEvents.delete(grantEventKey);
          const eventKeys = new Set([redemptionEventKey, grantEventKey]);
          this.audit = this.audit.filter((entry) => !eventKeys.has(String(entry.metadata?.["eventKey"] ?? "")));
        };
        this.promotionRedemptions.set(redemption.id, redemption);
        try {
          if (this.beforePromotionalGrantInsert && !this.beforePromotionalGrantInsert(clone(grant))) { rollback(); return { status: "conflict" }; }
          this.promotionSequence += 1n;
          this.promotionalAccessGrants.set(grant.id, grant);
          const redeemedLogged = await this.insertPromotionEvent({ id: `event-${redemption.id}-redeemed`, eventKey: redemptionEventKey, eventType: "coupon_redeemed", promotionId: promotion.id, subjectUserId: input.userId, redemptionId: redemption.id, occurredAt: input.now, metadata: { status: "redeemed", planId: promotion.accessPlanId, durationDays: promotion.durationDays, source: "free_access_coupon" } });
          if (!redeemedLogged) { rollback(); return { status: "conflict" }; }
          const grantLogged = await this.insertPromotionEvent({ id: `event-${grant.id}-created`, eventKey: grantEventKey, eventType: "grant_created", promotionId: promotion.id, subjectUserId: input.userId, redemptionId: redemption.id, accessGrantId: grant.id, occurredAt: input.now, metadata: { status: "queued", planId: grant.planId, durationDays: grant.durationDays, source: "free_access_coupon" } });
          if (!grantLogged) { rollback(); return { status: "conflict" }; }
          return { status: "created", redemption: clone(redemption), grant: clone(grant) };
        } catch {
          rollback();
          return { status: "conflict" };
        }
      });
    });
  }
  async transitionPromotionRedemption(input: { id: string; userId: string; expectedStatus: PromotionRedemptionRecord["status"]; nextStatus: PromotionRedemptionRecord["status"]; now: Date }): Promise<boolean> {
    if (!promotionRedemptionTransitionAllowed(input.expectedStatus, input.nextStatus)) return false;
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick(); const row = this.promotionRedemptions.get(input.id);
      if (row?.userId === input.userId && row.status === input.nextStatus) return this.promotionLifecycleEvents.has(`redemption:${input.id}:${input.nextStatus}`);
      if (!row || row.userId !== input.userId || row.status !== input.expectedStatus) return false;
      if (input.nextStatus === "released" || input.nextStatus === "redeemed") {
        if (!row.manualPaymentIntentId) return false;
        const intent = this.manualPaymentIntents.get(row.manualPaymentIntentId);
        if (!intent || intent.userId !== input.userId) return false;
        if (input.nextStatus === "released" && intent.status !== "failed" && intent.status !== "expired") return false;
        if (input.nextStatus === "redeemed" && intent.status !== "paid") return false;
      }
      const updated: PromotionRedemptionRecord = { ...row, status: input.nextStatus, redeemedAt: input.nextStatus === "redeemed" ? clone(input.now) : row.redeemedAt, releasedAt: input.nextStatus === "released" ? clone(input.now) : null, updatedAt: clone(input.now) };
      this.promotionRedemptions.set(input.id, updated);
      const eventType = input.nextStatus === "redeemed" ? "coupon_redeemed" : input.nextStatus === "released" ? "coupon_released" : "manual_review_required";
      const logged = await this.insertPromotionEvent({ id: `event-${input.id}-${input.nextStatus}`, eventKey: `redemption:${input.id}:${input.nextStatus}`, eventType, promotionId: row.promotionId, subjectUserId: input.userId, redemptionId: input.id, occurredAt: input.now, metadata: { status: input.nextStatus } });
      if (!logged) { this.promotionRedemptions.set(input.id, row); return false; }
      return true;
    });
  }
  async createPromotionalAccessGrant(input: CreatePromotionalAccessGrantInput): Promise<{ status: "created" | "existing" | "conflict"; grant?: PromotionalAccessGrantRecord }> {
    return this.withPromotionLock(`user:${input.userId}`, () => this.withPromotionLock(`promotion:${input.promotionId}`, async () => {
      await tick();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !Number.isSafeInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 30) return { status: "conflict" as const };
      const p = this.promotions.get(input.promotionId);
      const couponGrant = input.kind === "free_access_coupon";
      if (!p || !this.userRoles.has(input.userId) || p.accessPlanId !== input.planId || p.durationDays !== input.durationDays) return { status: "conflict" as const };
      if (couponGrant ? (input.grantedByAdminId !== null && input.grantedByAdminId !== undefined) : (!p.targetUserId || p.targetUserId !== input.userId || p.createdByAdminId !== input.grantedByAdminId || this.userRoles.get(input.grantedByAdminId ?? "") !== "admin" || p.status !== "active" || p.startsAt > input.now || (p.expiresAt !== null && p.expiresAt <= input.now))) return { status: "conflict" as const };
      if ((input.kind === "bonus_days" && p.type !== "bonus_days") || (input.kind === "tier_access" && p.type !== "tier_access") || (input.kind === "free_access_coupon" && p.type !== "free_access_coupon")) return { status: "conflict" as const };
      const redemption = input.redemptionId ? this.promotionRedemptions.get(input.redemptionId) : null;
      if (input.kind === "free_access_coupon" ? (!redemption || redemption.userId !== input.userId || redemption.promotionId !== input.promotionId || redemption.status !== "redeemed") : Boolean(input.redemptionId)) return { status: "conflict" as const };
      const prior = this.promotionalAccessGrants.get(input.id);
      if (prior) {
        const same = prior.promotionId === input.promotionId && prior.userId === input.userId && prior.redemptionId === (input.redemptionId ?? null) && prior.kind === input.kind && prior.activationPolicy === input.activationPolicy && prior.planId === input.planId && prior.durationDays === input.durationDays && prior.grantedByAdminId === (input.grantedByAdminId ?? null);
        return same ? { status: "existing" as const, grant: clone(prior) } : { status: "conflict" as const };
      }
      const grant: PromotionalAccessGrantRecord = { id: input.id, promotionId: input.promotionId, userId: input.userId, redemptionId: redemption?.id ?? null, kind: input.kind, activationPolicy: input.activationPolicy, status: "queued", planId: input.planId,
        durationDays: input.durationDays, queueSequence: ++this.promotionSequence, startsAt: null, expiresAt: null, activatedAt: null, revokedAt: null, grantedByAdminId: input.grantedByAdminId ?? null, reason: input.reason ?? null, createdAt: clone(input.now), updatedAt: clone(input.now) };
      this.promotionalAccessGrants.set(grant.id, grant);
      const logged = await this.insertPromotionEvent({ id: `event-${grant.id}`, eventKey: `grant:${grant.id}:created`, eventType: "grant_created", promotionId: grant.promotionId, subjectUserId: grant.userId, actorUserId: grant.grantedByAdminId, redemptionId: grant.redemptionId, accessGrantId: grant.id, occurredAt: input.now, metadata: { status: "queued", planId: grant.planId, durationDays: grant.durationDays, reason: grant.reason } });
      if (!logged) { this.promotionalAccessGrants.delete(grant.id); return { status: "conflict" as const }; }
      return { status: "created" as const, grant: clone(grant) };
    }));
  }
  async activateNextPromotionalAccessGrant(userId: string, now: Date): Promise<PromotionalAccessGrantRecord | null> {
    return this.withPromotionLock(`user:${userId}`, async () => {
      const grantSnapshot = new Map([...this.promotionalAccessGrants].map(([id, grant]) => [id, clone(grant)]));
      const eventSnapshot = new Map([...this.promotionLifecycleEvents].map(([key, event]) => [key, clone(event)]));
      const auditLength = this.audit.length;
      const rollback = () => {
        this.promotionalAccessGrants = new Map(grantSnapshot);
        this.promotionLifecycleEvents = new Map(eventSnapshot);
        this.audit.length = auditLength;
      };
      try {
        await tick(); if (!this.userRoles.has(userId)) return null;
        const next = [...this.promotionalAccessGrants.values()].filter((g) => g.userId === userId && g.status === "queued").sort((a, b) => a.queueSequence < b.queueSequence ? -1 : a.queueSequence > b.queueSequence ? 1 : 0)[0];
        const paidAccessBlocks = Boolean(next && next.activationPolicy === "after_current_access" && await this.hasPaidAccessForPromotion(userId, now));
        for (const [id, row] of this.promotionalAccessGrants) if (row.userId === userId && row.status === "active" && row.expiresAt && row.expiresAt <= now) {
          this.promotionalAccessGrants.set(id, { ...row, status: "expired", updatedAt: clone(now) });
          const logged = await this.insertPromotionEvent({ id: `event-${id}-expired`, eventKey: `grant:${id}:expired`, eventType: "grant_expired", promotionId: row.promotionId, subjectUserId: userId, accessGrantId: id, occurredAt: now, metadata: { status: "expired" } });
          if (!logged) { rollback(); return null; }
        }
        if ([...this.promotionalAccessGrants.values()].some((g) => g.userId === userId && g.status === "active" && g.startsAt && g.startsAt <= now && g.expiresAt && g.expiresAt > now)) return null;
        if (!next || paidAccessBlocks) return null;
        const updated: PromotionalAccessGrantRecord = { ...next, status: "active", startsAt: clone(now), expiresAt: new Date(now.getTime() + next.durationDays * 86_400_000), activatedAt: clone(now), updatedAt: clone(now) };
        this.promotionalAccessGrants.set(next.id, updated);
        const logged = await this.insertPromotionEvent({ id: `event-${next.id}-activated`, eventKey: `grant:${next.id}:activated`, eventType: "grant_activated", promotionId: next.promotionId, subjectUserId: userId, accessGrantId: next.id, occurredAt: now, metadata: { status: "active", planId: next.planId, durationDays: next.durationDays } });
        if (!logged) { rollback(); return null; }
        return clone(updated);
      } catch (error) { rollback(); throw error; }
    });
  }
  async transitionPromotionalAccessGrant(input: { id: string; userId: string; actorUserId?: string | null; expectedStatus: PromotionalAccessGrantRecord["status"]; nextStatus: "expired" | "revoked"; now: Date }): Promise<boolean> {
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick(); const row = this.promotionalAccessGrants.get(input.id);
      if (row?.userId === input.userId && row.status === input.nextStatus) return this.promotionLifecycleEvents.has(`grant:${input.id}:${input.nextStatus}`);
      if (!row || row.userId !== input.userId || row.status !== input.expectedStatus || (input.expectedStatus !== "queued" && input.expectedStatus !== "active") || (input.nextStatus === "expired" && (input.expectedStatus !== "active" || !row.expiresAt || row.expiresAt > input.now)) || (input.nextStatus === "revoked" && this.userRoles.get(input.actorUserId ?? "") !== "admin")) return false;
      const updated = { ...row, status: input.nextStatus, revokedAt: input.nextStatus === "revoked" ? clone(input.now) : null, updatedAt: clone(input.now) };
      this.promotionalAccessGrants.set(input.id, updated);
      const logged = await this.insertPromotionEvent({ id: `event-${input.id}-${input.nextStatus}`, eventKey: `grant:${input.id}:${input.nextStatus}`, eventType: input.nextStatus === "revoked" ? "grant_revoked" : "grant_expired", promotionId: row.promotionId, subjectUserId: row.userId, actorUserId: input.actorUserId ?? null, accessGrantId: row.id, occurredAt: input.now, metadata: { status: input.nextStatus } });
      if (!logged) { this.promotionalAccessGrants.set(input.id, row); return false; }
      return true;
    });
  }
  async getPromotionalAccessGrant(userId: string, grantId: string): Promise<PromotionalAccessGrantRecord | null> { await tick(); const row = this.promotionalAccessGrants.get(grantId); return row?.userId === userId ? clone(row) : null; }
  async listPromotionalAccessGrantsForUser(userId: string): Promise<PromotionalAccessGrantRecord[]> { await tick(); return [...this.promotionalAccessGrants.values()].filter((g) => g.userId === userId).sort((a, b) => a.queueSequence < b.queueSequence ? -1 : a.queueSequence > b.queueSequence ? 1 : 0).map(clone); }
  async createPromotionLifecycleEvent(input: PromotionLifecycleEventInput): Promise<"created" | "duplicate" | "conflict"> {
    await tick(); if (!/^[A-Za-z0-9:_-]{1,200}$/.test(input.eventKey) || (input.metadata && !validPromotionEventMetadata(input.metadata))) return "conflict";
    const promotion = this.promotions.get(input.promotionId);
    const redemption = input.redemptionId ? this.promotionRedemptions.get(input.redemptionId) : null;
    const grant = input.accessGrantId ? this.promotionalAccessGrants.get(input.accessGrantId) : null;
    if (!promotion || (input.actorUserId && this.userRoles.get(input.actorUserId) !== "admin") || (input.subjectUserId && !this.userRoles.has(input.subjectUserId)) ||
      (input.redemptionId && (!redemption || redemption.promotionId !== input.promotionId || redemption.userId !== input.subjectUserId)) ||
      (input.accessGrantId && (!grant || grant.promotionId !== input.promotionId || grant.userId !== input.subjectUserId))) return "conflict";
    const prior = this.promotionLifecycleEvents.get(input.eventKey);
    if (prior) return prior.promotionId === input.promotionId && prior.eventType === input.eventType && prior.subjectUserId === (input.subjectUserId ?? null) && prior.actorUserId === (input.actorUserId ?? null) && prior.redemptionId === (input.redemptionId ?? null) && prior.accessGrantId === (input.accessGrantId ?? null) && prior.outcome === (input.outcome ?? null) && prior.occurredAt.getTime() === input.occurredAt.getTime() && promotionMetadataKey(prior.metadata) === promotionMetadataKey(validPromotionEventMetadata(input.metadata)) ? "duplicate" : "conflict";
    return await this.insertPromotionEvent(input) ? "created" : "conflict";
  }
  async listPromotionLifecycleEvents(promotionId: string): Promise<PromotionLifecycleEventRecord[]> { await tick(); return [...this.promotionLifecycleEvents.values()].filter((event) => event.promotionId === promotionId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).map(clone); }

  private resolvePlanIdForUser(userId: string, at: Date): PlanId {
    const subscriptionEntry = [...this.razorpaySubscriptions.entries()].find(([, value]) => value.userId === userId);
    const subId = subscriptionEntry?.[0];
    const sub = subscriptionEntry?.[1];
    const subscription = sub ? {
      planId: sub.planId, status: sub.status, trialEndsAt: sub.trialEndsAt ?? null, currentPeriodEnd: sub.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
      hasCapturedPayment: Boolean(subId && [...this.razorpayPayments.values()].some((payment) => payment.providerSubscriptionId === subId && payment.status === "captured")),
      hasFailedPayment: Boolean(subId && [...this.razorpayPayments.values()].some((payment) => payment.providerSubscriptionId === subId && payment.status === "failed")),
    } : null;
    const manualAccess = [...this.manualPlanAccesses.values()].filter((access) => access.userId === userId).map((access) => ({ planId: access.planId, startsAt: access.startsAt, expiresAt: access.expiresAt }));
    const promotionalGrants = [...this.promotionalAccessGrants.values()].filter((grant) => grant.userId === userId).map((grant) => ({ planId: grant.planId, startsAt: grant.startsAt ?? new Date(NaN), expiresAt: grant.expiresAt ?? new Date(NaN), status: grant.status, activationPolicy: grant.activationPolicy, activatedAt: grant.activatedAt, revokedAt: grant.revokedAt }));
    const legacyPlanId = sub ? null : this.plans.get(userId);
    return resolveEffectiveEntitlement({ now: at, subscription, manualAccess, promotionalGrants, legacyPlanId, deferredAccessState: resolveDeferredAccessState({ now: at, subscription, manualAccess, legacyPlanId }) }).planId;
  }
  async getPlanIdForUser(userId: string, at = new Date()): Promise<PlanId> {
    await tick();
    await this.activateNextPromotionalAccessGrant(userId, at);
    return this.resolvePlanIdForUser(userId, at);
  }
  async reserveManualPaymentIntent(input: { id: string; userId: string; idempotencyKey: string; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number; now: Date }): Promise<{ status: "created" | "existing" | "conflict"; intent?: ManualPaymentIntentRecord }> {
    await tick(); const old = [...this.manualPaymentIntents.values()].find((i) => i.userId === input.userId && i.idempotencyKey === input.idempotencyKey);
    if (old) return old.planId === input.planId && old.interval === input.interval && old.amountPaise === input.amountPaise ? { status: "existing", intent: clone(old) } : { status: "conflict" };
    if (input.planId === "free" || getPlan(input.planId).pricePaise[input.interval] !== input.amountPaise) return { status: "conflict" };
    const activeManual = [...this.manualPlanAccesses.values()].some((a) => a.userId === input.userId && a.expiresAt > input.now);
    const activeSub = [...this.razorpaySubscriptions.values()].some((s) => s.userId === input.userId && (["active", "pending", "authenticated", "created", "halted"].includes(s.status) || (s.cancelAtPeriodEnd === true && s.status === "cancelled")) && (!s.currentPeriodEnd || s.currentPeriodEnd > input.now));
    if (activeManual || activeSub || [...this.manualPaymentIntents.values()].some((i) => i.userId === input.userId && ["creating", "created", "manual_review"].includes(i.status))) return { status: "conflict" };
    const intent: ManualPaymentIntentRecord = { id: input.id, userId: input.userId, idempotencyKey: input.idempotencyKey, providerPaymentLinkId: null, checkoutUrl: null, planId: input.planId, interval: input.interval, amountPaise: input.amountPaise, currency: "INR", status: "creating", accessStartsAt: null, accessEndsAt: null, errorCategory: null, createdAt: input.now, updatedAt: input.now };
    this.manualPaymentIntents.set(intent.id, intent); return { status: "created", intent: clone(intent) };
  }
  async reserveDiscountedManualPaymentIntent(input: ReserveDiscountedManualPaymentIntentInput): Promise<ReserveDiscountedManualPaymentIntentResult> {
    const code = normalizePromotionCode(input.couponCode);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) ||
      !/^[A-Z0-9_-]{3,64}$/.test(code) || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick();
      if (!this.userRoles.has(input.userId)) return { status: "conflict" };
      const oldIntent = [...this.manualPaymentIntents.values()].find((intent) => intent.userId === input.userId && intent.idempotencyKey === input.idempotencyKey);
      if (oldIntent) {
        const oldRedemption = [...this.promotionRedemptions.values()].find((row) => row.manualPaymentIntentId === oldIntent.id && row.manualPaymentIntentUserId === input.userId);
        const oldPromotion = oldRedemption ? this.promotions.get(oldRedemption.promotionId) : null;
        if (!oldRedemption || !oldPromotion || oldPromotion.code !== code || oldPromotion.type !== "discount_coupon") return { status: "conflict" };
        return this.withPromotionLock(`promotion:${oldPromotion.id}`, async () => {
          const promotion = this.promotions.get(oldPromotion.id);
          if (!promotion || promotion.code !== code) return { status: "conflict" };
          const reservationEvent = this.promotionLifecycleEvents.get(`redemption:${oldRedemption.id}:reserved`);
          if (reservationEvent?.metadata?.["discountType"] !== promotion.discountType || reservationEvent?.metadata?.["discountValue"] !== promotion.discountValue) return { status: "conflict" };
          const amounts = calculateDiscountAmounts(promotion, input);
          if (!amounts) return { status: "conflict" };
          const exact = oldIntent.planId === input.planId && oldIntent.interval === input.interval && oldIntent.amountPaise === amounts.payablePaise && oldRedemption.promotionId === promotion.id &&
            oldRedemption.userId === input.userId && oldRedemption.idempotencyKey === input.idempotencyKey && oldRedemption.planId === input.planId && oldRedemption.interval === input.interval &&
            oldRedemption.listPricePaise === amounts.listPricePaise && oldRedemption.discountPaise === amounts.discountPaise && oldRedemption.payablePaise === amounts.payablePaise &&
            oldRedemption.manualPaymentIntentId === oldIntent.id && oldRedemption.manualPaymentIntentUserId === input.userId;
          return exact ? { status: "existing", intent: clone(oldIntent), redemption: clone(oldRedemption) } : { status: "conflict" };
        });
      }
      const initial = [...this.promotions.values()].find((promotion) => promotion.code === code);
      if (!initial) return { status: "unavailable" };
      return this.withPromotionLock(`promotion:${initial.id}`, async () => {
        await tick();
        const promotion = this.promotions.get(initial.id);
        if (!promotion || promotion.code !== code || promotion.type !== "discount_coupon") return { status: "unavailable" };
        const amounts = calculateDiscountAmounts(promotion, input);
        if (!amounts) return { status: "unavailable" };

        if (this.manualPaymentIntents.has(input.id) || !validPromotionRecord(promotion) || promotion.status !== "active" || promotion.startsAt > input.now ||
          (promotion.expiresAt !== null && promotion.expiresAt <= input.now) || (promotion.targetUserId !== null && promotion.targetUserId !== input.userId) || !promotion.eligiblePlanIds.includes(input.planId) ||
          !validDiscountSnapshot(promotion, { userId: input.userId, planId: input.planId, interval: input.interval, ...amounts, now: input.now })) return { status: "unavailable" };
        if ([...this.promotionRedemptions.values()].some((row) => row.promotionId === promotion.id && row.userId === input.userId)) return { status: "conflict" };
        const usage = [...this.promotionRedemptions.values()].filter((row) => row.promotionId === promotion.id && ["reserved", "redeemed", "manual_review"].includes(row.status)).length;
        if (promotion.usageLimit !== null && usage >= promotion.usageLimit) return { status: "unavailable" };
        const activeManual = [...this.manualPlanAccesses.values()].some((access) => access.userId === input.userId && access.expiresAt > input.now);
        const activeSub = [...this.razorpaySubscriptions.values()].some((sub) => sub.userId === input.userId && (["active", "pending", "authenticated", "created", "halted"].includes(sub.status) || (sub.cancelAtPeriodEnd === true && sub.status === "cancelled")) && (!sub.currentPeriodEnd || sub.currentPeriodEnd > input.now));
        if (activeManual || activeSub || [...this.manualPaymentIntents.values()].some((intent) => intent.userId === input.userId && ["creating", "created", "manual_review"].includes(intent.status))) return { status: "conflict" };

        const intent: ManualPaymentIntentRecord = { id: input.id, userId: input.userId, idempotencyKey: input.idempotencyKey, providerPaymentLinkId: null, checkoutUrl: null,
          planId: input.planId, interval: input.interval, amountPaise: amounts.payablePaise, currency: "INR", status: "creating", accessStartsAt: null, accessEndsAt: null, errorCategory: null,
          createdAt: clone(input.now), updatedAt: clone(input.now) };
        const redemption: PromotionRedemptionRecord = { id: `redemption-${input.id}`, promotionId: promotion.id, userId: input.userId, status: "reserved", idempotencyKey: input.idempotencyKey,
          planId: input.planId, interval: input.interval, listPricePaise: amounts.listPricePaise, discountPaise: amounts.discountPaise, payablePaise: amounts.payablePaise, currency: "INR",
          manualPaymentIntentId: intent.id, manualPaymentIntentUserId: input.userId, reservedAt: clone(input.now), redeemedAt: null, releasedAt: null, createdAt: clone(input.now), updatedAt: clone(input.now) };
        if (this.promotionRedemptions.has(redemption.id)) return { status: "conflict" };
        const eventKey = `redemption:${redemption.id}:reserved`;
        const auditLength = this.audit.length;
        try {
          if (this.beforeDiscountedIntentInsert && !this.beforeDiscountedIntentInsert(clone(intent))) throw new Error("manual intent insert failed");
          this.manualPaymentIntents.set(intent.id, intent);
          if (this.beforeDiscountRedemptionInsert && !this.beforeDiscountRedemptionInsert(clone(redemption))) throw new Error("redemption insert failed");
          this.promotionRedemptions.set(redemption.id, redemption);
          const logged = await this.insertPromotionEvent({ id: `event-${redemption.id}-reserved`, eventKey, eventType: "coupon_reserved", promotionId: promotion.id, subjectUserId: input.userId,
            redemptionId: redemption.id, occurredAt: input.now, metadata: { status: redemption.status, planId: redemption.planId, discountType: promotion.discountType, discountValue: promotion.discountValue, discountPaise: redemption.discountPaise, payablePaise: redemption.payablePaise } });
          if (!logged) throw new Error("reservation event insert failed");
          return { status: "created", intent: clone(intent), redemption: clone(redemption) };
        } catch {
          this.manualPaymentIntents.delete(intent.id); this.promotionRedemptions.delete(redemption.id); this.promotionLifecycleEvents.delete(eventKey); this.audit.length = auditLength;
          return { status: "conflict" };
        }
      });
    });
  }
  async finishManualPaymentIntent(input: { id: string; userId: string; status: ManualIntentStatus; providerPaymentLinkId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean> {
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick(); const old = this.manualPaymentIntents.get(input.id); if (!old || old.userId !== input.userId || old.status !== "creating") return false;
      if (input.providerPaymentLinkId && [...this.manualPaymentIntents.values()].some((i) => i.id !== old.id && i.providerPaymentLinkId === input.providerPaymentLinkId)) return false;
      this.manualPaymentIntents.set(old.id, { ...old, status: input.status, providerPaymentLinkId: input.providerPaymentLinkId ?? null, checkoutUrl: input.checkoutUrl ?? null, errorCategory: input.errorCategory ?? null, updatedAt: input.now }); return true;
    });
  }
  async getManualPaymentIntent(userId: string, intentId: string): Promise<ManualPaymentIntentRecord | null> { await tick(); const row = this.manualPaymentIntents.get(intentId); return row?.userId === userId ? clone(row) : null; }
  async getManualPaymentIntentForWebhook(intentId: string): Promise<ManualPaymentIntentRecord | null> { await tick(); const row = this.manualPaymentIntents.get(intentId); return row ? clone(row) : null; }
  async settleManualPayment(input: SettleManualPaymentInput): Promise<"applied" | "duplicate" | "invalid" | "conflict"> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.intentId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerPaymentLinkId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerPaymentId) || !Number.isSafeInteger(input.amountPaise) || input.amountPaise < 1 || !Number.isFinite(input.paidAt.getTime()) || !Number.isFinite(input.now.getTime())) return "invalid";
    return this.withPromotionLock("user:" + input.userId, async () => {
      await tick();
      const intentAtLock = this.manualPaymentIntents.get(input.intentId);
      const redemptionAtLock = intentAtLock?.userId === input.userId ? [...this.promotionRedemptions.values()].find((row) => row.manualPaymentIntentId === input.intentId && row.manualPaymentIntentUserId === input.userId) ?? null : null;
      const settle = async (lockedPromotionId: string | null): Promise<"applied" | "duplicate" | "invalid" | "conflict"> => {
        const intent = this.manualPaymentIntents.get(input.intentId);
        const existingPayment = this.manualPayments.get(input.providerPaymentId) ?? null;
        if (!intent || intent.userId !== input.userId) return existingPayment ? "conflict" : "invalid";
        const redemption = [...this.promotionRedemptions.values()].find((row) => row.manualPaymentIntentId === intent.id && row.manualPaymentIntentUserId === input.userId) ?? null;
        if ((redemption?.promotionId ?? null) !== lockedPromotionId) return "conflict";
        const promotion = redemption ? this.promotions.get(redemption.promotionId) ?? null : null;
        if (redemption && (!promotion || promotion.id !== lockedPromotionId)) return "conflict";
        const access = this.manualPlanAccesses.get(intent.id) ?? null;
        const paymentForIntent = [...this.manualPayments.entries()].find(([, payment]) => payment.intentId === intent.id) ?? null;
        const hasSettlement = intent.status === "paid" || access !== null || paymentForIntent !== null;
        let periodEnd: Date | null = null;
        try { periodEnd = accessPeriodEnd(input.paidAt, intent.interval); } catch { /* malformed stored billing period fails closed */ }

        if (existingPayment || hasSettlement) {
          const paymentMatches = Boolean(existingPayment && paymentForIntent?.[0] === input.providerPaymentId && existingPayment.userId === input.userId && existingPayment.intentId === intent.id && existingPayment.paymentLinkId === input.providerPaymentLinkId && existingPayment.amountPaise === input.amountPaise && input.currency === "INR" && input.status === "captured" && existingPayment.currency === input.currency && existingPayment.status === input.status);
          const accessMatches = Boolean(access && periodEnd && intent.status === "paid" && intent.providerPaymentLinkId === input.providerPaymentLinkId && intent.amountPaise === input.amountPaise && intent.accessStartsAt?.getTime() === input.paidAt.getTime() && intent.accessEndsAt?.getTime() === periodEnd.getTime() && access.userId === input.userId && access.intentId === intent.id && access.providerPaymentId === input.providerPaymentId && access.planId === intent.planId && access.startsAt.getTime() === input.paidAt.getTime() && access.expiresAt.getTime() === periodEnd.getTime());
          let redemptionMatches = redemption === null;
          if (!redemption) {
            try { redemptionMatches = intent.amountPaise === getPlan(intent.planId).pricePaise[intent.interval]; } catch { redemptionMatches = false; }
          }
          if (redemption && promotion) {
            const reserved = this.promotionLifecycleEvents.get("redemption:" + redemption.id + ":reserved");
            const redeemed = this.promotionLifecycleEvents.get("redemption:" + redemption.id + ":redeemed");
            const amounts = calculateDiscountAmounts(promotion, { planId: intent.planId, interval: intent.interval });
            const metadata = reserved?.metadata;
            const auditExists = this.audit.some((entry) => entry.action === "promotion.coupon_redeemed" && entry.entityType === "PromotionRedemption" && entry.entityId === redemption.id && entry.metadata?.["eventKey"] === "redemption:" + redemption.id + ":redeemed");
            redemptionMatches = Boolean(redemption.status === "redeemed" && redemption.promotionId === promotion.id && redemption.userId === input.userId && redemption.idempotencyKey === intent.idempotencyKey && redemption.planId === intent.planId && redemption.interval === intent.interval && redemption.currency === "INR" && redemption.manualPaymentIntentId === intent.id && redemption.manualPaymentIntentUserId === input.userId && amounts && redemption.listPricePaise === amounts.listPricePaise && redemption.discountPaise === amounts.discountPaise && redemption.payablePaise === amounts.payablePaise && intent.amountPaise === amounts.payablePaise && metadata?.["discountType"] === promotion.discountType && metadata?.["discountValue"] === promotion.discountValue && redeemed?.promotionId === promotion.id && redeemed.eventType === "coupon_redeemed" && redeemed.subjectUserId === input.userId && redeemed.redemptionId === redemption.id && auditExists);
          }
          return paymentMatches && accessMatches && redemptionMatches ? "duplicate" : "conflict";
        }

        if (intent.status !== "created" || intent.providerPaymentLinkId !== input.providerPaymentLinkId || intent.amountPaise !== input.amountPaise || input.currency !== "INR" || input.status !== "captured") return "invalid";
        if (redemption && (!promotion || promotion.type !== "discount_coupon" || redemption.status !== "reserved" || redemption.userId !== input.userId || redemption.idempotencyKey !== intent.idempotencyKey || redemption.planId !== intent.planId || redemption.interval !== intent.interval || redemption.currency !== "INR" || redemption.manualPaymentIntentId !== intent.id || redemption.manualPaymentIntentUserId !== input.userId)) return "conflict";
        let amounts: ReturnType<typeof calculateDiscountAmounts> = null;
        if (redemption && promotion) {
          amounts = calculateDiscountAmounts(promotion, { planId: intent.planId, interval: intent.interval });
          const reserved = this.promotionLifecycleEvents.get("redemption:" + redemption.id + ":reserved");
          const metadata = reserved?.metadata;
          if (!amounts || redemption.listPricePaise !== amounts.listPricePaise || redemption.discountPaise !== amounts.discountPaise || redemption.payablePaise !== amounts.payablePaise || intent.amountPaise !== amounts.payablePaise || reserved?.promotionId !== promotion.id || reserved.eventType !== "coupon_reserved" || reserved.subjectUserId !== input.userId || reserved.redemptionId !== redemption.id || metadata?.["status"] !== "reserved" || metadata?.["planId"] !== intent.planId || metadata?.["discountType"] !== promotion.discountType || metadata?.["discountValue"] !== promotion.discountValue || metadata?.["discountPaise"] !== amounts.discountPaise || metadata?.["payablePaise"] !== amounts.payablePaise) return "conflict";
        } else if (!redemption) {
          try { if (getPlan(intent.planId).pricePaise[intent.interval] !== intent.amountPaise) return "conflict"; } catch { return "conflict"; }
        }
        const activeSub = [...this.razorpaySubscriptions.values()].some((sub) => sub.userId === input.userId && (["active", "pending", "authenticated", "created", "halted"].includes(sub.status) || (sub.cancelAtPeriodEnd === true && sub.status === "cancelled")) && (!sub.currentPeriodEnd || sub.currentPeriodEnd > input.now));
        const activeManual = [...this.manualPlanAccesses.values()].some((item) => item.userId === input.userId && item.expiresAt > input.now);
        if (activeSub || activeManual || !periodEnd) return "conflict";

        const paymentsBefore = clone([...this.manualPayments.entries()]);
        const accessBefore = clone([...this.manualPlanAccesses.entries()]);
        const intentsBefore = clone([...this.manualPaymentIntents.entries()]);
        const redemptionsBefore = clone([...this.promotionRedemptions.entries()]);
        const eventsBefore = clone([...this.promotionLifecycleEvents.entries()]);
        const auditBefore = clone(this.audit);
        const restore = <K, V>(map: Map<K, V>, entries: [K, V][]) => { map.clear(); for (const [key, value] of entries) map.set(key, value); };
        try {
          const fail = (stage: "payment_record" | "manual_access" | "intent_paid" | "redemption_redeemed") => { if (this.beforeManualPaymentSettlementWrite && !this.beforeManualPaymentSettlementWrite(stage)) throw new Error("injected settlement write failure"); };
          fail("payment_record");
          this.manualPayments.set(input.providerPaymentId, { userId: input.userId, intentId: intent.id, paymentLinkId: input.providerPaymentLinkId, amountPaise: input.amountPaise, currency: "INR", status: "captured" });
          fail("manual_access");
          this.manualPlanAccesses.set(intent.id, { id: randomUUID(), userId: input.userId, intentId: intent.id, providerPaymentId: input.providerPaymentId, planId: intent.planId, startsAt: clone(input.paidAt), expiresAt: periodEnd });
          fail("intent_paid");
          this.manualPaymentIntents.set(intent.id, { ...intent, status: "paid", accessStartsAt: clone(input.paidAt), accessEndsAt: periodEnd, updatedAt: clone(input.now) });
          if (redemption && promotion && amounts) {
            fail("redemption_redeemed");
            this.promotionRedemptions.set(redemption.id, { ...redemption, status: "redeemed", redeemedAt: clone(input.now), releasedAt: null, updatedAt: clone(input.now) });
            const logged = await this.insertPromotionEvent({ id: "event-" + redemption.id + "-redeemed", eventKey: "redemption:" + redemption.id + ":redeemed", eventType: "coupon_redeemed", promotionId: promotion.id, subjectUserId: input.userId, redemptionId: redemption.id, occurredAt: input.now, metadata: { status: "redeemed", planId: intent.planId, discountType: promotion.discountType, discountValue: promotion.discountValue, discountPaise: amounts.discountPaise, payablePaise: amounts.payablePaise } });
            if (!logged) throw new Error("coupon settlement lifecycle/audit write failed");
          }
          return "applied";
        } catch {
          restore(this.manualPayments, paymentsBefore); restore(this.manualPlanAccesses, accessBefore); restore(this.manualPaymentIntents, intentsBefore); restore(this.promotionRedemptions, redemptionsBefore); restore(this.promotionLifecycleEvents, eventsBefore); this.audit = auditBefore;
          return "conflict";
        }
      };
      const runWithPaymentLock = (promotionId: string | null) => this.withPromotionLock("payment:" + input.providerPaymentId, () => settle(promotionId));
      if (redemptionAtLock) {
        const promotionId = redemptionAtLock.promotionId;
        if (!this.promotions.has(promotionId)) return "conflict";
        return this.withPromotionLock("promotion:" + promotionId, async () => runWithPaymentLock(promotionId));
      }
      if (intentAtLock?.userId === input.userId && [...this.promotionRedemptions.values()].some((row) => row.manualPaymentIntentId === input.intentId)) return "conflict";
      return runWithPaymentLock(null);
    });
  }
  async reserveRazorpaySubscriptionIntent(input: ReserveRazorpaySubscriptionIntentInput): Promise<{ status: "created" | "existing" | "conflict"; intent?: RazorpaySubscriptionIntentRecord }> {
    if (!(input.autoRenewConsentAt instanceof Date) || !input.autoRenewConsentVersion || input.planId === "free" || getPlan(input.planId).pricePaise[input.interval] !== input.amountPaise) return { status: "conflict" };
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick();
      const old = [...this.razorpaySubscriptionIntents.values()].find((i) => i.userId === input.userId && i.idempotencyKey === input.idempotencyKey);
      if (old) return old.planId === input.planId && old.interval === input.interval && old.amountPaise === input.amountPaise ? { status: "existing", intent: clone(old) } : { status: "conflict" };
      if ([...this.razorpaySubscriptionIntents.values()].some((i) => i.userId === input.userId && ["creating", "created", "active", "manual_review"].includes(i.status)) || [...this.razorpaySubscriptions.values()].some((s) => s.userId === input.userId && ["active", "pending", "authenticated", "created", "halted"].includes(s.status))) return { status: "conflict" };
      const intent: RazorpaySubscriptionIntentRecord = { id: input.id, userId: input.userId, idempotencyKey: input.idempotencyKey, autoRenewConsentAt: input.autoRenewConsentAt, autoRenewConsentVersion: input.autoRenewConsentVersion, providerSubscriptionId: null, providerPlanId: input.providerPlanId, checkoutUrl: null, planId: input.planId, interval: input.interval, amountPaise: input.amountPaise, currency: "INR", status: "creating", errorCategory: null, createdAt: input.now, updatedAt: input.now };
      this.razorpaySubscriptionIntents.set(intent.id, intent); return { status: "created", intent: clone(intent) };
    });
  }
  async finishRazorpaySubscriptionIntent(input: { id: string; userId: string; status: RazorpayIntentStatus; providerSubscriptionId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean> {
    return this.withPromotionLock(`user:${input.userId}`, async () => {
      await tick(); const old = this.razorpaySubscriptionIntents.get(input.id);
      if (!old || old.userId !== input.userId || old.status !== "creating") return false;
      if (input.providerSubscriptionId && [...this.razorpaySubscriptionIntents.values()].some((i) => i.id !== old.id && i.providerSubscriptionId === input.providerSubscriptionId)) return false;
      const next = { ...old, status: input.status, providerSubscriptionId: input.providerSubscriptionId ?? null, checkoutUrl: input.checkoutUrl ?? null, errorCategory: input.errorCategory ?? null, updatedAt: input.now };
      if (input.providerSubscriptionId && input.status === "created") {
        this.razorpaySubscriptions.set(input.providerSubscriptionId, { userId: old.userId, planId: old.planId, interval: old.interval, status: "created", lastEventAt: 0, currentPeriodEnd: null, cancelAtPeriodEnd: false });
      }
      this.razorpaySubscriptionIntents.set(old.id, next); return true;
    });
  }
  async getRazorpaySubscriptionIntent(userId: string, idempotencyKey: string): Promise<RazorpaySubscriptionIntentRecord | null> { await tick(); const row = [...this.razorpaySubscriptionIntents.values()].find((i) => i.userId === userId && i.idempotencyKey === idempotencyKey); return row ? clone(row) : null; }
  async getRazorpaySubscriptionIntentByProviderId(userId: string, providerSubscriptionId: string): Promise<RazorpaySubscriptionIntentRecord | null> { await tick(); const row = [...this.razorpaySubscriptionIntents.values()].find((i) => i.userId === userId && i.providerSubscriptionId === providerSubscriptionId); return row ? clone(row) : null; }
  async getRazorpaySubscriptionForOwner(userId: string): Promise<{ id: string; planId: PlanId; interval: "weekly" | "monthly"; status: SubscriptionStatus; razorpaySubscriptionId: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean } | null> {
    await tick(); const row = [...this.razorpaySubscriptions.entries()].find(([, s]) => s.userId === userId); return row ? { id: row[0], planId: row[1].planId, interval: row[1].interval, status: row[1].status, razorpaySubscriptionId: row[0], currentPeriodEnd: row[1].currentPeriodEnd ?? null, cancelAtPeriodEnd: row[1].cancelAtPeriodEnd ?? false } : null;
  }
  async recordRazorpayCancellation(userId: string, providerSubscriptionId: string, cancelAtPeriodEnd: boolean, providerStatus: SubscriptionStatus, currentPeriodEnd: Date | null, _now: Date): Promise<boolean> {
    return this.withPromotionLock(`user:${userId}`, async () => {
      await tick(); const row = this.razorpaySubscriptions.get(providerSubscriptionId); if (!row || row.userId !== userId) return false;
      this.razorpaySubscriptions.set(providerSubscriptionId, { ...row, status: providerStatus, cancelAtPeriodEnd, ...(currentPeriodEnd ? { currentPeriodEnd } : {}) });
      if (!cancelAtPeriodEnd || providerStatus === "cancelled") this.plans.set(userId, cancelAtPeriodEnd && currentPeriodEnd && currentPeriodEnd.getTime() > Date.now() ? row.planId : "free");
      return true;
    });
  }
  async requestRazorpayCancellation(userId: string, providerSubscriptionId: string, now: Date): Promise<boolean> {
    return this.withPromotionLock(`user:${userId}`, async () => {
      await tick(); const row = this.razorpaySubscriptions.get(providerSubscriptionId); if (!row || row.userId !== userId) return false;
      this.razorpaySubscriptions.set(providerSubscriptionId, { ...row, cancellationRequestedAt: row.cancellationRequestedAt ?? now }); return true;
    });
  }
  async listSubscriptionContinuationCandidates(now: Date): Promise<import("./repository.ts").SubscriptionContinuationCandidate[]> {
    await tick(); return [...this.razorpaySubscriptions.entries()].filter(([, s]) => s.status === "active" && !s.cancelAtPeriodEnd && !s.cancellationRequestedAt && s.currentPeriodEnd && s.currentPeriodEnd > now).map(([providerSubscriptionId, s]) => ({ id: providerSubscriptionId, userId: s.userId, planId: s.planId, interval: s.interval, providerSubscriptionId, currentPeriodEnd: s.currentPeriodEnd! }));
  }
  async reserveSubscriptionContinuation(input: import("./repository.ts").SubscriptionContinuationInput): Promise<"reserved" | "existing" | "cancelled" | "not_due"> {
    const owner = this.razorpaySubscriptions.get(input.providerSubscriptionId)?.userId;
    if (!owner) return "not_due";
    return this.withPromotionLock(`user:${owner}`, async () => {
      await tick(); const row = this.razorpaySubscriptions.get(input.providerSubscriptionId);
      if (!row || row.userId !== owner || row.currentPeriodEnd?.getTime() !== input.cycleEnd.getTime()) return "not_due";
      if (row.cancellationRequestedAt || row.cancelAtPeriodEnd || row.status !== "active") return "cancelled";
      const key = `${input.subscriptionId}:${input.cycleEnd.toISOString()}`; if ([...this.subscriptionContinuations.values()].some((c) => `${c.subscriptionId}:${c.cycleEnd.toISOString()}` === key)) return "existing";
      this.subscriptionContinuations.set(input.id, { id: input.id, subscriptionId: input.subscriptionId, providerSubscriptionId: input.providerSubscriptionId, cycleEnd: input.cycleEnd, status: "reserved" }); return "reserved";
    });
  }
  async finishSubscriptionContinuation(input: { id: string; status: "applied" | "manual_review" | "skipped"; errorCategory?: string; now: Date }): Promise<boolean> {
    await tick(); const row = this.subscriptionContinuations.get(input.id); if (!row || row.status !== "reserved") return false;
    this.subscriptionContinuations.set(input.id, { ...row, status: input.status, errorCategory: input.errorCategory }); return true;
  }
  async processRazorpaySubscriptionEvent(input: import("./repository.ts").RazorpaySubscriptionEventInput): Promise<import("./repository.ts").RazorpaySubscriptionEventResult> {
    await tick();
    if (this.razorpayWebhookEvents.has(input.providerEventId)) return "duplicate";
    if (!input.newStatus || input.createdAt === undefined || !input.subscriptionId) {
      this.razorpayWebhookEvents.set(input.providerEventId, { eventType: input.eventType, status: "ignored" });
      return "ignored";
    }
    const subscriptionId = input.subscriptionId;
    const newStatus = input.newStatus;
    const eventCreatedAt = input.createdAt;
    const owner = this.razorpaySubscriptions.get(subscriptionId)?.userId;
    if (!owner) return "unknown_subscription";
    return this.withPromotionLock(`user:${owner}`, async () => {
      await tick();
      if (this.razorpayWebhookEvents.has(input.providerEventId)) return "duplicate";
      const row = this.razorpaySubscriptions.get(subscriptionId);
      if (!row || row.userId !== owner) return "unknown_subscription";
      const intent = [...this.razorpaySubscriptionIntents.values()].find((i) => i.providerSubscriptionId === subscriptionId);
      if (newStatus === "active" && (!intent || intent.status === "manual_review" || intent.amountPaise === null || !input.payment || input.payment.status !== "captured" || input.payment.currency !== "INR" || input.payment.amount !== intent.amountPaise)) return "invalid_transition";
      const validPlanPayment = Boolean(intent && intent.amountPaise !== null && input.payment && input.payment.currency === "INR" && input.payment.amount === intent.amountPaise && (input.payment.status === "captured" || input.payment.status === "failed"));
      if (validPlanPayment && input.payment && this.razorpayPayments.has(input.payment.id)) { this.razorpayWebhookEvents.set(input.providerEventId, { eventType: input.eventType, status: "ignored" }); return "duplicate"; }
      const outcome = applySubscriptionEvent({ planId: row.planId, interval: row.interval, status: row.status, lastEventAt: row.lastEventAt, processedEventIds: [] }, { eventId: input.providerEventId, createdAt: eventCreatedAt, newStatus });
      if (!outcome.applied) {
        if (outcome.reason === "stale") this.razorpayWebhookEvents.set(input.providerEventId, { eventType: input.eventType, status: "ignored" });
        return outcome.reason;
      }
      this.razorpaySubscriptions.set(subscriptionId, { ...row, status: outcome.state.status, lastEventAt: outcome.state.lastEventAt, ...(input.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: new Date(input.currentPeriodEnd * 1000) }) });
      if (intent && input.payment && validPlanPayment) {
        this.razorpayPayments.set(input.payment.id, { userId: row.userId, intentId: intent.id, amountPaise: input.payment.amount, currency: input.payment.currency, status: input.payment.status, providerSubscriptionId: subscriptionId });
      }
      if (intent && outcome.state.status === "active") this.razorpaySubscriptionIntents.set(intent.id, { ...intent, status: "active", updatedAt: new Date() });
      if (intent && !(intent.status === "manual_review" && intent.amountPaise === null) && outcome.state.status === "cancelled") this.razorpaySubscriptionIntents.set(intent.id, { ...intent, status: "cancelled", updatedAt: new Date() });
      this.razorpayWebhookEvents.set(input.providerEventId, { eventType: input.eventType, status: "processed" });
      this.plans.set(row.userId, hasPaidEntitlements(outcome.state) ? row.planId : "free");
      return "applied";
    });
  }

  async getCycle(cycleId: string): Promise<CycleRecord | null> { await tick(); const c = this.cycles.get(cycleId); return c ? clone(c) : null; }
  async countActiveCycles(userId: string): Promise<number> {
    await tick();
    return [...this.cycles.values()].filter((c) => c.ownerId === userId && (c.status === "draft" || c.status === "running" || c.status === "paused")).length;
  }
  async createCycle(cycle: CycleRecord): Promise<void> { await tick(); this.cycles.set(cycle.id, clone(cycle)); }
  async createCycleWithinLimit(cycle: CycleRecord, activeCycleLimit: number): Promise<boolean> {
    return this.withPromotionLock(`user:${cycle.ownerId}`, async () => {
      await tick();
      if (!Number.isInteger(activeCycleLimit) || activeCycleLimit < 1 || this.cycles.has(cycle.id)) return false;
      const active = [...this.cycles.values()].filter((entry) => entry.ownerId === cycle.ownerId && (entry.status === "draft" || entry.status === "running" || entry.status === "paused")).length;
      if (active >= activeCycleLimit) return false;
      this.cycles.set(cycle.id, clone(cycle));
      return true;
    });
  }
  async listRunningCyclesForSettlement(afterCycleId: string | null, limit: number): Promise<CycleRecord[]> {
    await tick();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return [];
    return [...this.cycles.values()].filter((cycle) => cycle.status === "running" && (afterCycleId === null || cycle.id > afterCycleId))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map(clone);
  }
  async completeSettledCycle(input: { cycleId: string; ownerId: string; now: Date; activeCycleLimit: number; newId: () => string }): Promise<import("./repository.ts").CompleteSettledCycleResult> {
    return this.withPromotionLock(`user:${input.ownerId}`, () => this.withPromotionLock(`cycle:${input.cycleId}`, async () => {
      await tick();
      const cycle = this.cycles.get(input.cycleId);
      if (!cycle || cycle.ownerId !== input.ownerId) return "not_found";
      if (cycle.status === "completed") return "already_completed";
      if (cycle.status !== "running") return "not_ready";
      const items = [...this.items.values()].filter((item) => item.cycleId === cycle.id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      if (!isCycleFinished(items)) return "not_ready";

      const decision = decideSettledCycle(cycle, items, cycle.repeatBehavior ?? "never");
      const eligible = decision === "repeat_without_published_items" ? itemsEligibleForRepeat(items) : [];
      const activeElsewhere = [...this.cycles.values()].filter((entry) => entry.id !== cycle.id && entry.ownerId === cycle.ownerId && (entry.status === "draft" || entry.status === "running" || entry.status === "paused")).length;
      const canQueue = eligible.length > 0 && activeElsewhere < input.activeCycleLimit;
      const nextCycle = canQueue ? {
        ...clone(cycle), id: input.newId(), status: "draft" as const, finalReviewConfirmed: false, createdAt: input.now,
      } : null;
      const nextItems = nextCycle ? eligible.map((item) => ({
        ...clone(item), id: input.newId(), cycleId: nextCycle.id, cycleOwnerId: cycle.ownerId, status: "upcoming" as const,
        version: 1, scheduledFor: null, lockedBy: null, lockExpiresAt: null, reviewReason: null, externalPostId: null, publishedAt: null,
      })) : [];

      // No await after the first write: state and audit move together in the in-memory model.
      this.cycles.set(cycle.id, { ...cycle, status: "completed" });
      if (nextCycle) {
        this.cycles.set(nextCycle.id, nextCycle);
        for (const item of nextItems) this.items.set(item.id, item);
      }
      this.audit.push({ actorId: null, action: "cycle.completed", entityType: "PublishingCycle", entityId: cycle.id, metadata: { items: items.length } });
      if (nextCycle) this.audit.push({ actorId: null, action: "cycle.repeat_queued", entityType: "PublishingCycle", entityId: cycle.id, metadata: { nextCycleId: nextCycle.id, items: nextItems.length } });
      else if (eligible.length > 0 && decision === "repeat_without_published_items") this.audit.push({ actorId: null, action: "cycle.repeat_skipped", entityType: "PublishingCycle", entityId: cycle.id, metadata: { reason: "active_cycle_limit" } });
      return nextCycle ? "repeat_queued" : eligible.length > 0 && decision === "repeat_without_published_items" ? "repeat_skipped_limit" : "completed";
    }));
  }
  async transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean> {
    return this.withPromotionLock(`cycle:${cycleId}`, async () => {
      await tick();
      const cycle = this.cycles.get(cycleId);
      if (!cycle || cycle.status !== from) return false; // someone else already changed it
      this.cycles.set(cycleId, { ...cycle, status: to, finalReviewConfirmed });
      return true;
    });
  }
  async stopCycle(cycleId: string, ownerId: string, from: CycleStatus, finalReviewConfirmed: boolean, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean> {
    return this.withPromotionLock(`cycle:${cycleId}`, async () => {
      await tick();
      const cycle = this.cycles.get(cycleId);
      if (!cycle || cycle.ownerId !== ownerId || cycle.status !== from) return false;
      for (const { item, expectedVersion } of updates) {
        const stored = this.items.get(item.id);
        if (!stored || stored.cycleId !== cycleId || stored.cycleOwnerId !== ownerId || stored.version !== expectedVersion || (stored.status !== "upcoming" && stored.status !== "scheduled")) return false;
      }
      this.cycles.set(cycleId, { ...cycle, status: "stopped", finalReviewConfirmed });
      for (const { item } of updates) this.items.set(item.id, clone(item));
      return true;
    });
  }
  async updateCycleRepeat(cycleId: string, ownerId: string, repeatBehavior: "never" | "ask" | "automatic"): Promise<boolean> {
    await tick();
    const cycle = this.cycles.get(cycleId);
    if (!cycle || cycle.ownerId !== ownerId) return false;
    this.cycles.set(cycleId, { ...cycle, repeatBehavior });
    return true;
  }

  async getCycleItems(cycleId: string): Promise<CycleItem[]> {
    await tick(); // queue order, like ORDER BY position, id
    return [...this.items.values()].filter((i) => i.cycleId === cycleId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map(clone);
  }
  async addCycleItems(items: CycleItem[]): Promise<boolean> {
    if (items.length === 0) return true;
    const cycleId = items[0]!.cycleId;
    const ownerId = items[0]!.cycleOwnerId;
    if (items.some((item) => item.cycleId !== cycleId || item.cycleOwnerId !== ownerId) || new Set(items.map((item) => item.id)).size !== items.length) return false;
    return this.withPromotionLock(`cycle:${cycleId}`, async () => {
      await tick();
      const cycle = this.cycles.get(cycleId);
      if (!cycle || cycle.ownerId !== ownerId || cycle.status === "completed" || cycle.status === "stopped" || items.some((item) => this.items.has(item.id))) return false;
      for (const item of items) this.items.set(item.id, clone(item));
      return true;
    });
  }
  async saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]> {
    await tick();
    this.beforeItemSave?.();
    // No `await` below: the check-and-write of each item is atomic, like a single SQL UPDATE ... WHERE version = ?.
    return updates.map(({ item, expectedVersion }) => {
      const stored = this.items.get(item.id);
      if (!stored || stored.version !== expectedVersion) return { itemId: item.id, saved: false };
      const merged = { ...stored } as Record<string, unknown>;
      for (const field of MUTABLE_ITEM_FIELDS) merged[field] = clone(item[field]);
      this.items.set(item.id, merged as unknown as CycleItem);
      return { itemId: item.id, saved: true };
    });
  }
  async selectCycleItemRenderOutput(input: SelectCycleItemRenderOutputInput): Promise<boolean> {
    await tick();
    const cycle = this.cycles.get(input.cycleId);
    const item = this.items.get(input.itemId);
    if (!cycle || cycle.ownerId !== input.ownerId || cycle.status !== "draft" || !item || item.cycleId !== input.cycleId || item.cycleOwnerId !== input.ownerId || item.version !== input.expectedVersion || (item.status !== "upcoming" && item.status !== "scheduled")) return false;
    if (input.renderOutputId !== null) {
      const output = this.renders.get(input.renderOutputId);
      if (!output || output.ownerId !== input.ownerId || output.sourceMediaId !== item.mediaAssetId) return false;
    }
    this.items.set(item.id, { ...item, selectedRenderOutputId: input.renderOutputId, version: item.version + 1 });
    return true;
  }

  async saveCycleSchedule(cycleId: string, ownerId: string, scheduleSettings: PersistedCycleSchedule, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean> {
    await tick();
    const cycle = this.cycles.get(cycleId);
    if (!cycle || cycle.ownerId !== ownerId || cycle.status !== "draft") return false;
    const seen = new Set<string>();
    for (const { item, expectedVersion } of updates) {
      const stored = this.items.get(item.id);
      if (seen.has(item.id) || !stored || stored.cycleId !== cycleId || stored.cycleOwnerId !== ownerId || stored.version !== expectedVersion || (stored.status !== "upcoming" && stored.status !== "scheduled")) return false;
      seen.add(item.id);
    }
    // No await between validation and writes: settings and assignments change as one operation.
    for (const { item } of updates) {
      const stored = this.items.get(item.id) as CycleItem;
      const merged = { ...stored } as Record<string, unknown>;
      for (const field of MUTABLE_ITEM_FIELDS) merged[field] = clone(item[field]);
      this.items.set(item.id, merged as unknown as CycleItem);
    }
    this.cycles.set(cycleId, { ...cycle, scheduleSettings: clone(scheduleSettings), timezone: scheduleSettings.timeZone });
    return true;
  }

  private view(m: MediaAsset): MediaAsset { const copy = clone(m); if (this.thumbnailKeys.has(m.id)) copy.hasThumbnail = this.thumbnailKeys.get(m.id) != null; return copy; }
  async getMedia(mediaId: string): Promise<MediaAsset | null> { await tick(); const m = this.media.get(mediaId); return m ? this.view(m) : null; }
  async getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]> {
    await tick();
    return mediaIds.flatMap((id) => { const m = this.media.get(id); return m ? [this.view(m)] : []; });
  }
  async listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image"; search?: string; sort?: MediaSort }): Promise<{ items: MediaAsset[]; total: number }> {
    await tick();
    const sort = page.sort ?? "newest";
    const mine = [...this.media.values()].filter((m) => m.ownerId === userId && m.status !== "deleted" && (page.kind === undefined || (m.kind ?? "video") === page.kind) && (page.search === undefined || page.search === "" || mediaMatchesSearch(m, page.search)))
      .sort((a, b) => compareMedia(sort, a, b));
    return { items: mine.slice(page.offset, page.offset + page.limit).map((m) => this.view(m)), total: mine.length };
  }
  async addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean> {
    await tick();
    // No `await` between the check and the write: atomic, like one SQL transaction.
    const used = [...this.media.values()].filter((m) => m.ownerId === media.ownerId && m.status !== "deleted").reduce((sum, m) => sum + m.sizeBytes, 0);
    if (used + media.sizeBytes > limitBytes) return false;
    this.media.set(media.id, clone(media)); this.storageKeys.set(media.id, keys.storageKey); this.thumbnailKeys.set(media.id, keys.thumbnailKey);
    return true;
  }
  async getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null> {
    await tick();
    const key = this.storageKeys.get(mediaId);
    return key ? { storageKey: key, thumbnailKey: this.thumbnailKeys.get(mediaId) ?? null, mimeType: this.media.get(mediaId)?.mimeType ?? null } : null;
  }
  async createOrGetMediaImportJob(input: MediaImportRequestInput) {
    const initialMedia = this.media.get(input.sourceMediaId);
    if (!initialMedia) return { status: "not_found" as const };
    return this.withSharingLocks([input.importerId, initialMedia.ownerId], input.sourceCollectionId, () => this.withPromotionLock(`media:${input.sourceMediaId}`, () => this.withPromotionLock(`import-key:${input.importerId}:${input.sourceMediaId}`, async () => {
    await tick();
    const idempotencyKey = `import:${input.importerId}:${input.sourceMediaId}`;
    if (input.idempotencyKey !== idempotencyKey) return { status: "conflict" as const };
    const media = this.media.get(input.sourceMediaId); const collection = this.collections.get(input.sourceCollectionId);
    if (!media || !collection || !collection.mediaIds.includes(input.sourceMediaId)) return { status: "not_found" as const };
    if (collection.ownerId !== media.ownerId || media.kind === "image") return { status: "unauthorized" as const };
    if (!canImportVideo(input.importerId, media, collection, this.grants, input.now).allowed) return { status: "unauthorized" as const };
    const existing = [...this.mediaImportJobs.values()].find((job) => job.idempotencyKey === idempotencyKey);
    if (existing) return existing.importerId === input.importerId && existing.sourceMediaId === input.sourceMediaId && existing.sourceCollectionId === input.sourceCollectionId
      ? { status: "existing" as const, job: clone(existing) } : { status: "conflict" as const };
    if ([...this.media.values()].some((item) => item.id === input.resultMediaAssetId) || [...this.mediaImportJobs.values()].some((job) => job.resultMediaAssetId === input.resultMediaAssetId)) return { status: "conflict" as const };
    const used = [...this.media.values()].filter((item) => item.ownerId === input.importerId && item.status !== "deleted").reduce((sum, item) => sum + item.sizeBytes, 0) + [...this.renders.values()].filter((item) => item.ownerId === input.importerId).reduce((sum, item) => sum + item.sizeBytes, 0);
    const storageLimitBytes = getPlan(this.resolvePlanIdForUser(input.importerId, input.now)).limits.storageBytes;
    if (used + media.sizeBytes > storageLimitBytes) return { status: "quota" as const };
    const job: MediaImportJobRecord = { id: input.id, importerId: input.importerId, sourceMediaId: input.sourceMediaId, sourceCollectionId: input.sourceCollectionId, status: "pending", idempotencyKey, newObjectKey: mediaKeyFor(input.importerId, input.resultMediaAssetId), stagingObjectKey: null, attemptStorageKeys: [], resultMediaAssetId: input.resultMediaAssetId, failureReason: null, attempts: 0, lockedBy: null, lockToken: null, leaseExpiresAt: null, createdAt: input.now, updatedAt: input.now };
    const audit: AuditEntry = { actorId: input.importerId, action: "media.import_requested", entityType: "MediaImportJob", entityId: job.id, metadata: { sourceMediaId: media.id, sourceCollectionId: collection.id } };
    if (this.beforeMediaImportWrite?.("job_create") === false || this.beforeMediaImportAuditInsert?.(audit) === false) throw new Error("Import request could not be recorded atomically.");
    this.mediaImportJobs.set(job.id, clone(job));
    this.audit.push(audit);
    return { status: "created" as const, job: clone(job) };
    })));
  }
  async getMediaImportJobForOwner(importerId: string, jobId: string) { await tick(); const job = this.mediaImportJobs.get(jobId); return job?.importerId === importerId ? clone(job) : null; }
  async listMediaImportJobsForOwner(importerId: string) { await tick(); return [...this.mediaImportJobs.values()].filter((job) => job.importerId === importerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone); }
  async retryMediaImportJob(importerId: string, jobId: string, now: Date) {
    const initial = this.mediaImportJobs.get(jobId); const sourceInitial = initial ? this.media.get(initial.sourceMediaId) : null;
    if (!initial || initial.importerId !== importerId || !initial.sourceCollectionId || !sourceInitial) return false;
    return this.withSharingLocks([importerId, sourceInitial.ownerId], initial.sourceCollectionId, () => this.withPromotionLock(`media:${sourceInitial.id}`, () => this.withPromotionLock(`import-job:${jobId}`, async () => {
      await tick(); const job = this.mediaImportJobs.get(jobId); const source = job ? this.media.get(job.sourceMediaId) : null; const collection = job?.sourceCollectionId ? this.collections.get(job.sourceCollectionId) : null;
      if (!job || job.importerId !== importerId || job.status !== "failed" || !source || !collection || !collection.mediaIds.includes(source.id) || collection.ownerId !== source.ownerId || source.kind === "image" || !canImportVideo(importerId, source, collection, this.grants, now).allowed) return false;
      const audit: AuditEntry = { actorId: importerId, action: "media.import_retried", entityType: "MediaImportJob", entityId: jobId };
      if (this.beforeMediaImportAuditInsert?.(audit) === false) return false;
      job.status = "pending"; job.failureReason = null; job.lockedBy = null; job.lockToken = null; job.leaseExpiresAt = null; job.stagingObjectKey = null; job.updatedAt = now;
      this.audit.push(audit); return true;
    })));
  }
  async claimNextMediaImportJob(input: MediaImportClaim) {
    await tick(); const candidate = [...this.mediaImportJobs.values()].filter((job) => input.jobId ? job.id === input.jobId : true).filter((job) => job.status === "pending" || ((job.status === "copying" || job.status === "verifying") && job.leaseExpiresAt !== null && job.leaseExpiresAt <= input.now)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0];
    if (!candidate) return null;
    candidate.status = "copying"; candidate.lockedBy = input.workerId; candidate.lockToken = randomUUID(); candidate.leaseExpiresAt = new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000); candidate.attempts += 1; candidate.updatedAt = input.now;
    candidate.stagingObjectKey = stagingKeyFor(`import-${candidate.id}-${candidate.attempts}`); candidate.attemptStorageKeys.push(candidate.stagingObjectKey);
    return clone(candidate);
  }
  async heartbeatMediaImportJob(input: { jobId: string; lockToken: string; now: Date; leaseSeconds: number }) {
    await tick(); const job = this.mediaImportJobs.get(input.jobId); if (!job || job.lockToken !== input.lockToken || !job.leaseExpiresAt || job.leaseExpiresAt <= input.now || !["copying", "verifying"].includes(job.status)) return false;
    job.leaseExpiresAt = new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000); job.updatedAt = input.now; return true;
  }
  async markMediaImportVerifying(input: MediaImportVerificationInput) { await tick(); const job = this.mediaImportJobs.get(input.jobId); if (!job || job.status !== "copying" || job.lockToken !== input.lockToken || !job.leaseExpiresAt || job.leaseExpiresAt <= input.now) return false; job.status = "verifying"; job.updatedAt = input.now; return true; }
  async finalizeMediaImportJob(input: MediaImportFinalizationInput) {
    const initialJob = this.mediaImportJobs.get(input.jobId); const initialSource = initialJob ? this.media.get(initialJob.sourceMediaId) : null;
    if (!initialJob || !initialSource) return "stale" as const;
    return this.withSharingLocks([input.importerId, initialSource.ownerId], initialJob.sourceCollectionId, () => this.withPromotionLock(`media:${initialSource.id}`, () => this.withPromotionLock(`import-job:${input.jobId}`, async () => {
    await tick(); const job = this.mediaImportJobs.get(input.jobId); if (!job || job.importerId !== input.importerId || job.status !== "verifying" || job.lockToken !== input.lockToken || !job.leaseExpiresAt || job.leaseExpiresAt <= input.now) return "stale" as const;
    const source = this.media.get(job.sourceMediaId); const collection = this.collections.get(job.sourceCollectionId); if (!source || !collection || !collection.mediaIds.includes(source.id)) return "unauthorized" as const;
    if (collection.ownerId !== source.ownerId || source.kind === "image") return "unauthorized" as const;
    if (!canImportVideo(job.importerId, source, collection, this.grants, input.now).allowed) return "unauthorized" as const;
    if (input.media.ownerId !== job.importerId || input.media.id !== job.resultMediaAssetId || input.media.importedFromId !== source.id || input.storageKey !== job.newObjectKey || input.media.sizeBytes !== source.sizeBytes) return "unauthorized" as const;
    if (this.media.has(input.media.id) && input.media.id !== source.id) return "unauthorized" as const;
    const used = [...this.media.values()].filter((item) => item.ownerId === job.importerId && item.status !== "deleted").reduce((sum, item) => sum + item.sizeBytes, 0) + [...this.renders.values()].filter((item) => item.ownerId === job.importerId).reduce((sum, item) => sum + item.sizeBytes, 0);
    const storageLimitBytes = getPlan(this.resolvePlanIdForUser(job.importerId, input.now)).limits.storageBytes;
    if (used + input.media.sizeBytes > storageLimitBytes) return "quota" as const;
    const snapshot = { media: this.media.has(input.media.id) ? clone(this.media.get(input.media.id)!) : null, storage: this.storageKeys.get(input.media.id), thumbnail: this.thumbnailKeys.get(input.media.id), job: clone(job), auditLength: this.audit.length };
    try {
      await input.commitStagedObject();
      if (this.beforeMediaImportWrite?.("asset_create") === false) throw new Error("Imported media could not be recorded.");
      this.media.set(input.media.id, clone(input.media)); this.storageKeys.set(input.media.id, input.storageKey); this.thumbnailKeys.set(input.media.id, null);
      if (this.beforeMediaImportWrite?.("job_transition") === false) throw new Error("Import status could not be recorded.");
      const audit: AuditEntry = { actorId: job.importerId, action: "media.import_completed", entityType: "MediaImportJob", entityId: job.id, metadata: { sourceMediaId: source.id, importedMediaId: input.media.id, sizeBytes: input.media.sizeBytes } };
      if (this.beforeMediaImportAuditInsert?.(audit) === false) throw new Error("Import audit insertion failed.");
      job.status = "succeeded"; job.failureReason = null; job.lockedBy = null; job.lockToken = null; job.leaseExpiresAt = null; job.updatedAt = input.now;
      this.audit.push(audit);
      return "applied" as const;
    } catch (error) {
      if (snapshot.media) this.media.set(input.media.id, snapshot.media); else this.media.delete(input.media.id);
      if (snapshot.storage) this.storageKeys.set(input.media.id, snapshot.storage); else this.storageKeys.delete(input.media.id);
      if (snapshot.thumbnail !== undefined) this.thumbnailKeys.set(input.media.id, snapshot.thumbnail); else this.thumbnailKeys.delete(input.media.id);
      this.mediaImportJobs.set(job.id, snapshot.job); this.audit.length = snapshot.auditLength; throw error;
    }
    })));
  }
  async failMediaImportJob(input: { jobId: string; lockToken: string; now: Date; reason: string }) {
    const initial = this.mediaImportJobs.get(input.jobId); if (!initial) return false;
    return this.withPromotionLock(`user:${initial.importerId}`, () => this.withPromotionLock(`import-job:${input.jobId}`, async () => {
      await tick(); const job = this.mediaImportJobs.get(input.jobId); if (!job || job.lockToken !== input.lockToken || job.status === "succeeded" || !job.leaseExpiresAt || job.leaseExpiresAt <= input.now) return false;
      const safeReason = input.reason.slice(0, 300); const entry: AuditEntry = { actorId: job.importerId, action: "media.import_failed", entityType: "MediaImportJob", entityId: job.id, metadata: { reason: safeReason } };
      if (this.beforeMediaImportAuditInsert?.(entry) === false) return false;
      job.status = "failed"; job.failureReason = safeReason; job.lockedBy = null; job.lockToken = null; job.leaseExpiresAt = null; job.updatedAt = input.now; this.audit.push(entry); return true;
    }));
  }
  async scheduleMediaDeletion(input: { mediaId: string; ownerId: string; now: Date; graceDays: number }) {
    return this.withPromotionLock(`user:${input.ownerId}`, () => this.withPromotionLock(`media:${input.mediaId}`, async () => {
      await tick(); const media = this.media.get(input.mediaId); if (!media || media.ownerId !== input.ownerId) return "missing" as const; if (media.status === "pending_deletion") return "already_pending" as const;
      if ([...this.mediaImportJobs.values()].some((job) => job.sourceMediaId === media.id && ["pending", "copying", "verifying"].includes(job.status))) return "import_pending" as const;
      const deleteAfter = new Date(input.now.getTime() + Math.max(1, Math.min(input.graceDays, 30)) * 86_400_000); const entry: AuditEntry = { actorId: input.ownerId, action: "media.deletion_scheduled", entityType: "MediaAsset", entityId: media.id, metadata: { deleteAfter: deleteAfter.toISOString() } };
      if (this.beforeMediaImportAuditInsert?.(entry) === false) throw new Error("Media deletion audit insertion failed.");
      media.status = "pending_deletion"; media.deleteAfter = deleteAfter; this.audit.push(entry); return "scheduled" as const;
    }));
  }
  async listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]> { await tick(); return [...this.collections.values()].filter((c) => c.mediaIds.includes(mediaId)).map(clone); }
  async listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]> { await tick(); return [...this.socialAccounts.values()].filter((a) => a.userId === userId).map(clone); }
  async listCollectionsForOwner(userId: string): Promise<VideoCollection[]> { await tick(); return [...this.collections.values()].filter((c) => c.ownerId === userId).map(clone); }
  async listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]> {
    await tick();
    const validIds = new Set(this.grants.filter((g) => g.granteeId === userId && g.status === "active" && (g.expiresAt === null || g.expiresAt > now)).map((g) => g.collectionId));
    return [...this.collections.values()].filter((c) => validIds.has(c.id) && c.ownerId !== userId).map(clone);
  }
  async listCyclesForOwner(userId: string): Promise<CycleRecord[]> { await tick(); return [...this.cycles.values()].filter((c) => c.ownerId === userId).map(clone); }
  async getStorageUsedBytes(userId: string): Promise<number> {
    await tick();
    const mediaBytes = [...this.media.values()].filter((m) => m.ownerId === userId && m.status !== "deleted").reduce((sum, m) => sum + m.sizeBytes, 0);
    const renderBytes = [...this.renders.values()].filter((r) => r.ownerId === userId).reduce((sum, r) => sum + r.sizeBytes, 0);
    return mediaBytes + renderBytes;
  }
  async getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }> {
    await tick(); const u = this.usageByMonth.get(`${userId}|${monthStart.toISOString()}`);
    return { processingSeconds: u?.processingSeconds ?? 0, exports: u?.exports ?? 0 };
  }

  async getCollection(collectionId: string): Promise<VideoCollection | null> { await tick(); const c = this.collections.get(collectionId); return c ? clone(c) : null; }
  async createCollection(collection: VideoCollection): Promise<boolean> {
    await tick();
    if (this.collections.has(collection.id)) return false;
    if (new Set(collection.mediaIds).size !== collection.mediaIds.length) return false;
    if (collection.mediaIds.some((id) => !this.media.has(id))) return false;
    this.collections.set(collection.id, clone(collection));
    return true;
  }
  async deleteCollection(collectionId: string): Promise<boolean> {
    return this.withPromotionLock(`collection:${collectionId}`, async () => {
      await tick();
      if ([...this.mediaImportJobs.values()].some((job) => job.sourceCollectionId === collectionId && ["pending", "copying", "verifying"].includes(job.status))) return false;
      return this.collections.delete(collectionId);
    });
  }
  async updateCollection(collectionId: string, details: { name: string; description: string | null; visibility: VideoCollection["visibility"]; archived: boolean }): Promise<boolean> {
    await tick();
    const current = this.collections.get(collectionId);
    if (!current) return false;
    this.collections.set(collectionId, { ...current, name: details.name, ...(details.description ? { description: details.description } : {}), visibility: details.visibility, archived: details.archived });
    if (!details.description) delete this.collections.get(collectionId)!.description;
    return true;
  }
  async replaceCollectionMedia(collectionId: string, mediaIds: string[]): Promise<boolean> {
    return this.withPromotionLock(`collection:${collectionId}`, async () => {
      await tick();
      const current = this.collections.get(collectionId);
      if (!current || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((id) => !this.media.has(id))) return false;
      const removed = current.mediaIds.filter((id) => !mediaIds.includes(id));
      if ([...this.mediaImportJobs.values()].some((job) => job.sourceCollectionId === collectionId && removed.includes(job.sourceMediaId) && ["pending", "copying", "verifying"].includes(job.status))) return false;
      this.collections.set(collectionId, { ...current, mediaIds: [...mediaIds] });
      return true;
    });
  }
  async getGrants(collectionId: string): Promise<CollectionPermissionGrant[]> { await tick(); return this.grants.filter((g) => g.collectionId === collectionId).map(clone); }
  private shareLinkSummary(link: CollectionShareLinkRecord): CollectionShareLinkSummary {
    const { tokenHash: _tokenHash, ...summary } = link;
    return clone(summary);
  }
  async createCollectionShareLink(input: CreateCollectionShareLinkInput) {
    const initial = this.collections.get(input.collectionId);
    if (!initial || initial.ownerId !== input.ownerId) return { status: "not_found" as const };
    await this.getPlanIdForUser(input.ownerId, input.now);
    return this.withSharingLocks([input.ownerId], input.collectionId, async () => {
      await tick();
      const collection = this.collections.get(input.collectionId);
      if (!collection || collection.ownerId !== input.ownerId) return { status: "not_found" as const };
      if (collection.visibility !== "link" || collection.archived) return { status: "invalid" as const, reason: "Only active collections set to link visibility can receive a share link." };
      const plan = getPlan(this.resolvePlanIdForUser(input.ownerId, input.now));
      const decision = validateShareLinkSettings({ capabilities: input.capabilities, expiresAt: input.expiresAt, now: input.now, collectionSharing: plan.features.collectionSharing, expiringGrants: plan.sharing.expiringGrants });
      if (!decision.allowed) return { status: plan.features.collectionSharing === "none" || (input.expiresAt !== null && !plan.sharing.expiringGrants) ? "plan_limit" as const : "invalid" as const, reason: decision.reason };
      if (this.collectionShareLinks.has(input.id) || [...this.collectionShareLinks.values()].some((link) => link.tokenHash === input.tokenHash)) return { status: "conflict" as const };
      const record: CollectionShareLinkRecord = { id: input.id, collectionId: input.collectionId, tokenHash: input.tokenHash, capabilities: [...new Set(input.capabilities)], expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, revokedAt: null, createdById: input.ownerId, createdAt: new Date(input.now) };
      const audit: AuditEntry = { actorId: input.ownerId, action: "sharing.share_link_created", entityType: "CollectionShareLink", entityId: record.id, metadata: { collectionId: record.collectionId, capabilities: record.capabilities, expiresAt: record.expiresAt?.toISOString() ?? null } };
      try {
        this.collectionShareLinks.set(record.id, clone(record));
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(audit))) throw new Error("Sharing audit insert failed.");
        this.audit.push(clone(audit));
      } catch (error) { this.collectionShareLinks.delete(record.id); throw error; }
      return { status: "created" as const, link: this.shareLinkSummary(record) };
    });
  }
  async updateCollectionShareLink(input: UpdateCollectionShareLinkInput) {
    const initial = this.collectionShareLinks.get(input.id);
    const collection = this.collections.get(input.collectionId);
    if (!initial || !collection || initial.collectionId !== input.collectionId || collection.ownerId !== input.ownerId || initial.createdById !== input.ownerId) return { status: "not_found" as const };
    await this.getPlanIdForUser(input.ownerId, input.now);
    return this.withSharingLocks([input.ownerId], input.collectionId, async () => {
      await tick();
      const current = this.collectionShareLinks.get(input.id);
      const latestCollection = this.collections.get(input.collectionId);
      if (!current || !latestCollection || latestCollection.ownerId !== input.ownerId || current.collectionId !== latestCollection.id || current.createdById !== input.ownerId) return { status: "not_found" as const };
      if (current.revokedAt !== null) return { status: "revoked" as const };
      if (latestCollection.visibility !== "link" || latestCollection.archived) return { status: "invalid" as const, reason: "The collection is not available for link sharing." };
      const plan = getPlan(this.resolvePlanIdForUser(input.ownerId, input.now));
      const decision = validateShareLinkSettings({ capabilities: input.capabilities, expiresAt: input.expiresAt, now: input.now, collectionSharing: plan.features.collectionSharing, expiringGrants: plan.sharing.expiringGrants });
      if (!decision.allowed) return { status: plan.features.collectionSharing === "none" || (input.expiresAt !== null && !plan.sharing.expiringGrants) ? "plan_limit" as const : "invalid" as const, reason: decision.reason };
      const next: CollectionShareLinkRecord = { ...current, capabilities: [...new Set(input.capabilities)], expiresAt: input.expiresAt ? new Date(input.expiresAt) : null };
      if (JSON.stringify(current.capabilities) === JSON.stringify(next.capabilities) && current.expiresAt?.getTime() === next.expiresAt?.getTime()) return { status: "unchanged" as const, link: this.shareLinkSummary(current) };
      const audit: AuditEntry = { actorId: input.ownerId, action: "sharing.share_link_updated", entityType: "CollectionShareLink", entityId: current.id, metadata: { collectionId: current.collectionId, capabilities: next.capabilities, expiresAt: next.expiresAt?.toISOString() ?? null } };
      try {
        this.collectionShareLinks.set(current.id, clone(next));
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(audit))) throw new Error("Sharing audit insert failed.");
        this.audit.push(clone(audit));
      } catch (error) { this.collectionShareLinks.set(current.id, clone(current)); throw error; }
      return { status: "updated" as const, link: this.shareLinkSummary(next) };
    });
  }
  async revokeCollectionShareLink(input: { id: string; collectionId: string; ownerId: string; now: Date }) {
    const initial = this.collectionShareLinks.get(input.id);
    const collection = this.collections.get(input.collectionId);
    if (!initial || !collection || initial.collectionId !== input.collectionId || collection.ownerId !== input.ownerId || initial.createdById !== input.ownerId) return "not_found" as const;
    return this.withSharingLocks([input.ownerId], input.collectionId, async () => {
      await tick();
      const current = this.collectionShareLinks.get(input.id);
      const latestCollection = this.collections.get(input.collectionId);
      if (!current || !latestCollection || latestCollection.ownerId !== input.ownerId || current.collectionId !== latestCollection.id || current.createdById !== input.ownerId) return "not_found" as const;
      if (current.revokedAt !== null) return "already_revoked" as const;
      const next = { ...current, revokedAt: new Date(input.now) };
      const audit: AuditEntry = { actorId: input.ownerId, action: "sharing.share_link_revoked", entityType: "CollectionShareLink", entityId: current.id, metadata: { collectionId: current.collectionId } };
      try {
        this.collectionShareLinks.set(current.id, clone(next));
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(audit))) throw new Error("Sharing audit insert failed.");
        this.audit.push(clone(audit));
      } catch (error) { this.collectionShareLinks.set(current.id, clone(current)); throw error; }
      return "revoked" as const;
    });
  }
  async listCollectionShareLinksForOwner(collectionId: string, ownerId: string): Promise<CollectionShareLinkSummary[]> {
    await tick();
    if (this.collections.get(collectionId)?.ownerId !== ownerId) return [];
    return [...this.collectionShareLinks.values()].filter((link) => link.collectionId === collectionId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map((link) => this.shareLinkSummary(link));
  }
  async getCollectionShareLinkByTokenHash(tokenHash: string): Promise<CollectionShareLinkRecord | null> {
    await tick();
    const link = [...this.collectionShareLinks.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return link ? clone(link) : null;
  }
  async createCollectionAccessRequest(input: CreateCollectionAccessRequestInput) {
    const initial = this.collections.get(input.collectionId);
    if (!initial || initial.ownerId === input.requesterId) return { status: "not_found" as const };
    return this.withSharingLocks([initial.ownerId, input.requesterId], input.collectionId, async () => {
      await tick();
      const collection = this.collections.get(input.collectionId);
      if (!collection || collection.ownerId !== initial.ownerId) return { status: "not_found" as const };
      if (!input.requestedCapabilities.length || input.requestedCapabilities.includes("manage") || input.requestedCapabilities.some((cap) => !["view", "use_in_cycle", "import_copy", "download"].includes(cap))) return { status: "invalid" as const, reason: "Choose one or more supported collection permissions." };
      const grants = this.grants.filter((grant) => grant.collectionId === collection.id);
      if (getCollectionCapabilities(input.requesterId, collection, grants, input.now).has("view")) return { status: "already_has_access" as const };
      const requests = [...this.collectionAccessRequests.values()].filter((request) => request.collectionId === collection.id);
      const decision = canCreateAccessRequest(input.requesterId, collection, requests);
      if (!decision.allowed) {
        const existing = requests.find((request) => request.requesterId === input.requesterId && request.status === "pending");
        if (existing) return { status: "existing" as const, request: clone(existing) };
        return { status: "invalid" as const, reason: decision.reason };
      }
      const record: CollectionAccessRequestRecord = { id: input.id, collectionId: collection.id, requesterId: input.requesterId, requestedCapabilities: [...new Set(input.requestedCapabilities)], status: "pending", decidedById: null, decidedAt: null, createdAt: new Date(input.now) };
      const auditRow: AuditEntry = { actorId: input.requesterId, action: "sharing.access_request_created", entityType: "CollectionAccessRequest", entityId: record.id, metadata: { collectionId: collection.id, requestedCapabilities: record.requestedCapabilities } };
      try {
        this.collectionAccessRequests.set(record.id, clone(record));
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(auditRow))) throw new Error("Sharing audit insert failed.");
        this.audit.push(clone(auditRow));
      } catch (error) { this.collectionAccessRequests.delete(record.id); throw error; }
      return { status: "created" as const, request: clone(record) };
    });
  }
  async listPendingCollectionAccessRequests(collectionId: string, ownerId: string): Promise<CollectionAccessRequestRecord[]> {
    await tick();
    if (this.collections.get(collectionId)?.ownerId !== ownerId) return [];
    return [...this.collectionAccessRequests.values()].filter((request) => request.collectionId === collectionId && request.status === "pending").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }
  async listCollectionAccessRequestsForRequester(requesterId: string): Promise<CollectionAccessRequestRecord[]> {
    await tick();
    return [...this.collectionAccessRequests.values()].filter((request) => request.requesterId === requesterId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }
  async decideCollectionAccessRequest(input: DecideCollectionAccessRequestInput) {
    const initialRequest = this.collectionAccessRequests.get(input.requestId);
    const initialCollection = this.collections.get(input.collectionId);
    if (!initialRequest || !initialCollection || initialCollection.ownerId !== input.ownerId || initialRequest.collectionId !== input.collectionId) return { status: "not_found" as const };
    await this.getPlanIdForUser(initialCollection.ownerId, input.now);
    return this.withSharingLocks([initialCollection.ownerId, initialRequest.requesterId], input.collectionId, async () => {
      await tick();
      const collection = this.collections.get(input.collectionId);
      const current = this.collectionAccessRequests.get(input.requestId);
      if (!collection || collection.ownerId !== input.ownerId || !current || current.collectionId !== collection.id) return { status: "not_found" as const };
      if (current.status !== "pending") return { status: "already_decided" as const };
      const domainRequest = { collectionId: current.collectionId, requesterId: current.requesterId, requestedCapabilities: current.requestedCapabilities, status: current.status };
      const decided = decideAccessRequest(input.ownerId, collection, domainRequest, input.decision);
      if (!decided.ok) return { status: "forbidden" as const, reason: decided.reason };
      let newGrant: CollectionPermissionGrant | null = null;
      const previousGrantIndex = this.grants.findIndex((grant) => grant.collectionId === collection.id && grant.granteeId === current.requesterId);
      const previousGrant = previousGrantIndex >= 0 ? clone(this.grants[previousGrantIndex]!) : null;
      if (input.decision === "approved") {
        const policy = getPlan(this.resolvePlanIdForUser(collection.ownerId, input.now)).sharing;
        const planned = planGrantCreation({ actorId: input.ownerId, granteeId: current.requesterId, collection, existingGrants: this.grants.filter((grant) => grant.collectionId === collection.id), capabilities: current.requestedCapabilities, expiresAt: null, policy, now: input.now });
        if (!planned.ok) return { status: planned.code === "plan_limit" ? "plan_limit" as const : planned.code === "invalid" ? "invalid" as const : "forbidden" as const, reason: planned.reason };
        newGrant = planned.grant;
      }
      const updated: CollectionAccessRequestRecord = { ...current, status: input.decision, decidedById: input.ownerId, decidedAt: new Date(input.now) };
      const auditRow: AuditEntry = { actorId: input.ownerId, action: `sharing.access_request_${input.decision}`, entityType: "CollectionAccessRequest", entityId: current.id, metadata: { collectionId: collection.id, requesterId: current.requesterId, ...(newGrant ? { grantedCapabilities: newGrant.capabilities } : {}) } };
      let auditInserted = false;
      try {
        this.collectionAccessRequests.set(current.id, clone(updated));
        if (newGrant) { if (previousGrantIndex >= 0) this.grants[previousGrantIndex] = clone(newGrant); else this.grants.push(clone(newGrant)); }
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(auditRow))) throw new Error("Sharing audit insert failed.");
        this.audit.push(clone(auditRow)); auditInserted = true;
      } catch (error) {
        this.collectionAccessRequests.set(current.id, clone(current));
        if (previousGrant) this.grants[previousGrantIndex] = previousGrant;
        else if (newGrant) { const index = this.grants.findIndex((grant) => grant.collectionId === collection.id && grant.granteeId === current.requesterId); if (index >= 0) this.grants.splice(index, 1); }
        if (auditInserted) { const index = this.audit.indexOf(auditRow); if (index >= 0) this.audit.splice(index, 1); }
        throw error;
      }
      return { status: "applied" as const, request: clone(updated), grant: newGrant ? clone(newGrant) : null };
    });
  }
  async createOrUpdateCollectionGrant(input: CreateCollectionGrantInput): Promise<CollectionGrantMutationResult> {
    const initial = this.collections.get(input.collectionId);
    if (!initial) return { status: "not_found" };
    // Resolve/activate a due queued entitlement before entering the shared owner lock; resolve
    // again under that lock so a concurrent billing/promotion change cannot leave a stale cap.
    await this.getPlanIdForUser(initial.ownerId, input.now);
    return this.withPromotionLock(`user:${initial.ownerId}`, () => this.withPromotionLock(`collection:${input.collectionId}`, async () => {
      await tick();
      const collection = this.collections.get(input.collectionId);
      if (!collection || collection.ownerId !== initial.ownerId) return { status: "not_found" };
      const grants = this.grants.filter((grant) => grant.collectionId === collection.id);
      if (!getCollectionCapabilities(input.actorId, collection, grants, input.now).has("view")) return { status: "not_found" };
      const policy = getPlan(this.resolvePlanIdForUser(collection.ownerId, input.now)).sharing;
      const decision = planGrantCreation({ actorId: input.actorId, granteeId: input.granteeId, collection, existingGrants: grants, capabilities: input.capabilities, expiresAt: input.expiresAt, policy, now: input.now });
      if (!decision.ok) return { status: decision.code === "plan_limit" ? "plan_limit" : decision.code === "invalid" ? "invalid" : "forbidden", reason: decision.reason };
      const index = this.grants.findIndex((grant) => grant.collectionId === collection.id && grant.granteeId === input.granteeId);
      const oldGrant = index >= 0 ? clone(this.grants[index]!) : null;
      const sameCapabilities = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((value, position) => value === [...right].sort()[position]);
      if (oldGrant?.status === "active" && oldGrant.grantedById === decision.grant.grantedById && oldGrant.expiresAt?.getTime() === decision.grant.expiresAt?.getTime() && sameCapabilities(oldGrant.capabilities, decision.grant.capabilities)) return { status: "existing", grant: oldGrant };
      const entry: AuditEntry = { actorId: input.actorId, action: "sharing.grant_created", entityType: "VideoCollection", entityId: collection.id, metadata: { granteeId: input.granteeId, capabilities: decision.grant.capabilities, expiresAt: input.expiresAt?.toISOString() ?? null } };
      const auditRow = clone(entry);
      let auditInserted = false;
      try {
        if (index >= 0) this.grants[index] = clone(decision.grant); else this.grants.push(clone(decision.grant));
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(entry))) throw new Error("Sharing audit insert failed.");
        this.audit.push(auditRow);
        auditInserted = true;
        return { status: "applied", grant: clone(decision.grant) };
      } catch (error) {
        if (oldGrant) this.grants[index] = oldGrant;
        else { const inserted = this.grants.findIndex((grant) => grant.collectionId === collection.id && grant.granteeId === input.granteeId); if (inserted >= 0) this.grants.splice(inserted, 1); }
        if (auditInserted) { const auditIndex = this.audit.indexOf(auditRow); if (auditIndex >= 0) this.audit.splice(auditIndex, 1); }
        throw error;
      }
    }));
  }
  async revokeCollectionGrant(input: RevokeCollectionGrantInput): Promise<CollectionGrantMutationResult> {
    const initial = this.collections.get(input.collectionId);
    if (!initial) return { status: "not_found" };
    await this.getPlanIdForUser(initial.ownerId, input.now);
    return this.withPromotionLock(`user:${initial.ownerId}`, () => this.withPromotionLock(`collection:${input.collectionId}`, async () => {
      await tick();
      const collection = this.collections.get(input.collectionId);
      if (!collection || collection.ownerId !== initial.ownerId) return { status: "not_found" };
      const grants = this.grants.filter((grant) => grant.collectionId === collection.id);
      if (!getCollectionCapabilities(input.actorId, collection, grants, input.now).has("view")) return { status: "not_found" };
      const grant = grants.find((candidate) => candidate.granteeId === input.granteeId && candidate.status === "active");
      if (!grant) return { status: "not_found" };
      const policy = getPlan(this.resolvePlanIdForUser(collection.ownerId, input.now)).sharing;
      const decision = planGrantRevocation({ actorId: input.actorId, collection, grant, allGrants: grants, policy, now: input.now });
      if (!decision.ok) return { status: "forbidden", reason: decision.reason };
      const index = this.grants.findIndex((candidate) => candidate.collectionId === collection.id && candidate.granteeId === input.granteeId);
      const oldGrant = clone(this.grants[index]!);
      const entry: AuditEntry = { actorId: input.actorId, action: "sharing.grant_revoked", entityType: "VideoCollection", entityId: collection.id, metadata: { granteeId: input.granteeId } };
      const auditRow = clone(entry);
      let auditInserted = false;
      try {
        this.grants[index] = clone(decision.grant);
        if (this.beforeSharingAuditInsert && !this.beforeSharingAuditInsert(clone(entry))) throw new Error("Sharing audit insert failed.");
        this.audit.push(auditRow);
        auditInserted = true;
        return { status: "applied", grant: clone(decision.grant) };
      } catch (error) {
        this.grants[index] = oldGrant;
        if (auditInserted) { const auditIndex = this.audit.indexOf(auditRow); if (auditIndex >= 0) this.audit.splice(auditIndex, 1); }
        throw error;
      }
    }));
  }
  async upsertGrant(grant: CollectionPermissionGrant): Promise<void> {
    await tick();
    const index = this.grants.findIndex((g) => g.collectionId === grant.collectionId && g.granteeId === grant.granteeId);
    if (index === -1) this.grants.push(clone(grant)); else this.grants[index] = clone(grant); // unique (collection, grantee)
  }

  async getSocialAccount(accountId: string): Promise<SocialAccountRecord | null> { await tick(); const a = this.socialAccounts.get(accountId); return a ? clone(a) : null; }
  async saveInstagramConnection(connection: InstagramConnectionWrite): Promise<string> {
    await tick();
    const existing = [...this.socialAccounts.values()].find((account) => account.userId === connection.userId && account.externalAccountId === connection.externalAccountId);
    const id = existing?.id ?? connection.id;
    this.socialAccounts.set(id, {
      id, userId: connection.userId, platform: "instagram", status: "connected", username: connection.username ?? undefined, externalAccountId: connection.externalAccountId,
      accountType: connection.accountType, grantedScopes: [...connection.grantedScopes], tokenExpiresAt: connection.tokenExpiresAt, hasToken: true,
    });
    if (!this.socialAccounts.get(id)!.username) delete this.socialAccounts.get(id)!.username;
    this.instagramTokens.set(id, connection.encryptedAccessToken);
    return id;
  }
  async saveInstagramConnectionWithinLimit(connection: InstagramConnectionWrite, now: Date): Promise<{ status: "saved"; accountId: string } | { status: "limit" }> {
    return this.withPromotionLock(`user:${connection.userId}`, async () => {
      await tick();
      const limit = getPlan(this.resolvePlanIdForUser(connection.userId, now)).limits.connectedAccounts;
      const existing = [...this.socialAccounts.values()].find((account) => account.userId === connection.userId && account.platform === "instagram" && account.externalAccountId === connection.externalAccountId);
      const connectedCount = [...this.socialAccounts.values()].filter((account) => account.userId === connection.userId && account.platform === "instagram" && account.status === "connected").length;
      if (existing?.status !== "connected" && connectedCount >= limit) return { status: "limit" as const };
      const accountId = await this.saveInstagramConnection(connection);
      return { status: "saved" as const, accountId };
    });
  }

  async getInstagramTokenCiphertext(userId: string, accountId: string): Promise<import("./repository.ts").InstagramTokenCiphertext | null> {
    await tick();
    const account = this.socialAccounts.get(accountId);
    const encryptedAccessToken = this.instagramTokens.get(accountId);
    if (!account || account.userId !== userId || account.platform !== "instagram" || !encryptedAccessToken) return null;
    return { encryptedAccessToken, tokenExpiresAt: account.tokenExpiresAt ?? null, status: account.status };
  }
  async updateInstagramTokenCiphertext(userId: string, accountId: string, expectedCiphertext: string, encryptedAccessToken: string, tokenExpiresAt: Date): Promise<boolean> {
    await tick();
    const account = this.socialAccounts.get(accountId);
    if (!account || account.userId !== userId || account.platform !== "instagram" || account.status !== "connected" || this.instagramTokens.get(accountId) !== expectedCiphertext) return false;
    this.instagramTokens.set(accountId, encryptedAccessToken);
    this.socialAccounts.set(accountId, { ...account, tokenExpiresAt });
    return true;
  }
  async disconnectSocialAccount(userId: string, accountId: string): Promise<boolean> {
    await tick();
    const account = this.socialAccounts.get(accountId);
    if (!account || account.userId !== userId) return false;
    this.instagramTokens.delete(accountId);
    const next: SocialAccountRecord = { id: account.id, userId: account.userId, platform: account.platform, status: "disconnected" };
    if (account.username) next.username = account.username;
    if (account.externalAccountId) next.externalAccountId = account.externalAccountId;
    if (account.accountType) next.accountType = account.accountType;
    this.socialAccounts.set(accountId, next);
    return true;
  }
  async listPublishingJobsForAccount(userId: string, socialAccountId: string): Promise<PublishingJobRecord[]> {
    await tick();
    const cycleIds = new Set([...this.cycles.values()].filter((cycle) => cycle.ownerId === userId && cycle.socialAccountId === socialAccountId).map((cycle) => cycle.id));
    const itemIds = new Set([...this.items.values()].filter((item) => cycleIds.has(item.cycleId)).map((item) => item.id));
    return [...this.publishingJobs.values()].filter((job) => itemIds.has(job.cycleItemId)).map((job) => clone(job));
  }
  async listDuePublishingCandidates(now: Date, limit: number): Promise<import("./repository.ts").DuePublishingCandidate[]> {
    await tick();
    return [...this.items.values()].filter((item) => item.status === "scheduled" && item.scheduledFor !== null && item.scheduledFor <= now)
      .sort((a, b) => a.scheduledFor!.getTime() - b.scheduledFor!.getTime() || a.position - b.position || a.id.localeCompare(b.id))
      .flatMap((item) => {
        const cycle = this.cycles.get(item.cycleId);
        if (!cycle || cycle.status !== "running") return [];
        const account = this.socialAccounts.get(cycle.socialAccountId) ?? null;
        return [{ cycle: clone(cycle), item: clone(item), account: account ? clone(account) : null }];
      }).slice(0, Math.max(0, limit));
  }
  async listPublishingAttemptsForItem(ownerId: string, cycleId: string, cycleItemId: string): Promise<PublishingAttemptRecord[]> {
    await tick();
    return [...this.publishingJobs.values()].filter((job) => job.ownerId === ownerId && job.cycleId === cycleId && job.cycleItemId === cycleItemId).sort((a, b) => a.attemptNumber - b.attemptNumber).map(clone);
  }
  async listActivePublishingAttemptsForWorker(workerId: string, now: Date, limit: number): Promise<PublishingAttemptRecord[]> {
    await tick();
    return [...this.publishingJobs.values()].filter((job) => job.workerId === workerId && isActivePublishingAttempt(job.stage) && job.leaseExpiresAt !== null && job.leaseExpiresAt > now).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).slice(0, Math.max(0, limit)).map(clone);
  }
  async listExpiredActivePublishingAttempts(now: Date, limit: number): Promise<{ jobId: string; ownerId: string }[]> {
    await tick();
    return [...this.publishingJobs.values()].filter((job) => isActivePublishingAttempt(job.stage) && job.leaseExpiresAt !== null && job.leaseExpiresAt <= now).sort((a, b) => a.leaseExpiresAt!.getTime() - b.leaseExpiresAt!.getTime()).slice(0, Math.max(0, limit)).map((job) => ({ jobId: job.id, ownerId: job.ownerId }));
  }
  async createOrGetPublishingAttempt(input: CreatePublishingAttemptInput): Promise<{ status: "created" | "existing" | "conflict"; job?: PublishingAttemptRecord }> {
    await tick();
    if (input.idempotencyKey !== buildPublishIdempotencyKey({ cycleId: input.cycleId, id: input.cycleItemId }, input.attemptNumber)) return { status: "conflict" };
    const existing = [...this.publishingJobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const sameIdentity = existing.ownerId === input.ownerId && existing.cycleId === input.cycleId && existing.cycleItemId === input.cycleItemId && existing.socialAccountId === input.socialAccountId;
      return sameIdentity ? { status: "existing", job: clone(existing) } : { status: "conflict" };
    }
    if (this.publishingJobs.has(input.id) || [...this.publishingJobs.values()].some((job) => job.cycleItemId === input.cycleItemId && job.attemptNumber === input.attemptNumber)) return { status: "conflict" };
    const cycle = this.cycles.get(input.cycleId), item = this.items.get(input.cycleItemId), account = this.socialAccounts.get(input.socialAccountId);
    if (!cycle || !item || !account || cycle.ownerId !== input.ownerId || cycle.socialAccountId !== input.socialAccountId || item.cycleId !== cycle.id || item.cycleOwnerId !== input.ownerId || account.userId !== input.ownerId || input.attemptNumber < 1) return { status: "conflict" };
    const job: PublishingAttemptRecord = { ...input, stage: "queued", outcome: "in_progress", workerId: null, lockToken: null, leaseExpiresAt: null, containerId: null, instagramMediaId: null, errorCategory: null, errorDetails: null, startedAt: input.now, createdAt: input.now, updatedAt: input.now, finishedAt: null };
    this.publishingJobs.set(job.id, clone(job)); return { status: "created", job: clone(job) };
  }
  async claimPublishingAttempt(input: ClaimPublishingAttemptInput): Promise<PublishingAttemptRecord | null> {
    await tick();
    const job = this.publishingJobs.get(input.attemptId), cycle = this.cycles.get(input.cycleId), item = this.items.get(input.cycleItemId), account = this.socialAccounts.get(input.socialAccountId);
    const accountEligibility = account ? evaluateInstagramEligibility({ platform: account.platform, status: account.status, accountType: account.accountType, grantedScopes: account.grantedScopes, hasToken: account.hasToken, tokenExpiresAt: account.tokenExpiresAt, now: input.now }) : null;
    if (!job || job.stage !== "queued" || !cycle || !item || !account || !accountEligibility?.eligible || cycle.ownerId !== input.ownerId || cycle.socialAccountId !== input.socialAccountId || cycle.status !== "running" || item.cycleId !== cycle.id || item.cycleOwnerId !== input.ownerId || item.version !== input.expectedItemVersion || (item.status !== "upcoming" && item.status !== "scheduled") || (item.scheduledFor && item.scheduledFor > input.now) || account.userId !== input.ownerId) return null;
    if (job.ownerId !== input.ownerId || job.cycleId !== cycle.id || job.cycleItemId !== item.id || job.socialAccountId !== account.id) return null;
    if ([...this.publishingJobs.values()].some((other) => other.socialAccountId === account.id && other.id !== job.id && isActivePublishingAttempt(other.stage))) return null;
    const lockToken = randomUUID(), leaseExpiresAt = new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000);
    const claimed = { ...job, stage: "claimed" as const, workerId: input.workerId, lockToken, leaseExpiresAt, startedAt: input.now, updatedAt: input.now };
    this.publishingJobs.set(job.id, claimed);
    this.items.set(item.id, { ...item, status: "publishing", lockedBy: input.workerId, lockExpiresAt: leaseExpiresAt, version: item.version + 1 });
    return clone(claimed);
  }
  async transitionPublishingAttempt(input: PublishingAttemptUpdate): Promise<boolean> {
    await tick(); const job = this.publishingJobs.get(input.jobId);
    if (!job || job.ownerId !== input.ownerId || job.workerId !== input.workerId || job.lockToken !== input.lockToken || job.stage !== input.expectedStage || !job.leaseExpiresAt || job.leaseExpiresAt <= input.now || !canTransitionPublishingAttempt(job.stage, input.nextStage)) return false;
    const terminal = ["published", "failed", "needs_manual_review"].includes(input.nextStage);
    const safeError = input.errorCategory !== undefined || input.errorDetails !== undefined ? safePublishingError(input.errorCategory) : null;
    if ((input.nextStage === "container_processing" && !input.containerId) || (["ready_to_publish", "publishing"].includes(input.nextStage) && !(input.containerId ?? job.containerId))) return false;
    if (input.nextStage === "published" && !input.instagramMediaId) return false;
    if (input.instagramMediaId && input.nextStage !== "published") return false;
    const next: PublishingAttemptRecord = { ...job, stage: input.nextStage, outcome: publishingOutcomeForStage(input.nextStage), updatedAt: input.now, finishedAt: terminal ? input.now : null, ...(input.leaseSeconds === undefined ? {} : { leaseExpiresAt: new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000) }), ...(input.containerId === undefined ? {} : { containerId: input.containerId }), ...(input.instagramMediaId === undefined ? {} : { instagramMediaId: input.instagramMediaId }), ...(safeError ? { errorCategory: safeError.category, errorDetails: safeError.details } : {}) };
    const item = this.items.get(job.cycleItemId);
    if (terminal) {
      if (!item || item.status !== "publishing" || item.lockedBy !== job.workerId) return false;
      const itemStatus = input.nextStage === "published" ? "published" : input.nextStage === "failed" ? "failed" : "needs_review";
      this.items.set(item.id, { ...item, status: itemStatus, externalPostId: input.nextStage === "published" ? input.instagramMediaId! : item.externalPostId, publishedAt: input.nextStage === "published" ? input.now : item.publishedAt, lockedBy: null, lockExpiresAt: null, reviewReason: input.nextStage === "needs_manual_review" ? "ambiguous_publish_result" : null, version: item.version + 1 });
      next.lockToken = null; next.leaseExpiresAt = null; next.workerId = null;
    }
    this.publishingJobs.set(job.id, next); return true;
  }
  async heartbeatPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean> {
    await tick(); const job = this.publishingJobs.get(jobId);
    if (!job || job.ownerId !== ownerId || job.workerId !== workerId || job.lockToken !== lockToken || !isActivePublishingAttempt(job.stage) || !job.leaseExpiresAt || job.leaseExpiresAt <= now) return false;
    this.publishingJobs.set(job.id, { ...job, leaseExpiresAt: new Date(now.getTime() + Math.max(1, leaseSeconds) * 1000), updatedAt: now }); return true;
  }
  async cancelPublishingAttempt(jobId: string, ownerId: string, now: Date): Promise<boolean> {
    await tick(); const job = this.publishingJobs.get(jobId);
    if (!job || job.ownerId !== ownerId || (job.stage !== "queued" && job.stage !== "claimed")) return false;
    const item = this.items.get(job.cycleItemId);
    if (job.stage === "claimed" && (!job.leaseExpiresAt || job.leaseExpiresAt > now || !item || item.status !== "publishing" || item.lockedBy !== job.workerId)) return false;
    if (item && item.status === "publishing") this.items.set(item.id, { ...item, status: "scheduled", lockedBy: null, lockExpiresAt: null, version: item.version + 1 });
    this.publishingJobs.set(job.id, { ...job, stage: "cancelled", workerId: null, lockToken: null, leaseExpiresAt: null, outcome: "in_progress", updatedAt: now, finishedAt: now }); return true;
  }
  async cancelClaimedPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date): Promise<boolean> {
    await tick(); const job = this.publishingJobs.get(jobId);
    if (!job || job.ownerId !== ownerId || job.workerId !== workerId || job.lockToken !== lockToken || job.stage !== "claimed" || !job.leaseExpiresAt || job.leaseExpiresAt <= now) return false;
    const item = this.items.get(job.cycleItemId), cycle = this.cycles.get(job.cycleId);
    if (!item || !cycle || cycle.ownerId !== ownerId || item.status !== "publishing" || item.lockedBy !== workerId) return false;
    const restoredStatus = cycle.status === "stopped" || cycle.status === "completed" ? "cancelled" : item.scheduledFor ? "scheduled" : "upcoming";
    this.items.set(item.id, { ...item, status: restoredStatus, lockedBy: null, lockExpiresAt: null, version: item.version + 1 });
    this.publishingJobs.set(job.id, { ...job, stage: "cancelled", outcome: "in_progress", workerId: null, lockToken: null, leaseExpiresAt: null, updatedAt: now, finishedAt: now });
    return true;
  }
  async markExpiredPublishingAttemptForReview(jobId: string, ownerId: string, now: Date): Promise<boolean> {
    await tick(); const job = this.publishingJobs.get(jobId);
    if (!job || job.ownerId !== ownerId || !isActivePublishingAttempt(job.stage) || !job.leaseExpiresAt || job.leaseExpiresAt > now) return false;
    const item = this.items.get(job.cycleItemId);
    if (!item || item.status !== "publishing" || item.lockedBy !== job.workerId) return false;
    this.items.set(item.id, { ...item, status: "needs_review", lockedBy: null, lockExpiresAt: null, reviewReason: "worker_lost_during_publish", version: item.version + 1 });
    this.publishingJobs.set(job.id, { ...job, stage: "needs_manual_review", outcome: "ambiguous", workerId: null, lockToken: null, leaseExpiresAt: null, errorCategory: "worker_lease_expired", errorDetails: "The worker lease expired; the external outcome was not verified.", updatedAt: now, finishedAt: now }); return true;
  }
  async getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number> { await tick(); return this.usageByMonth.get(`${userId}|${monthStart.toISOString()}`)?.scheduledItems ?? 0; }
  async getRecentPublishTimes(userId: string, since: Date): Promise<Date[]> {
    await tick();
    const ownCycleIds = new Set([...this.cycles.values()].filter((c) => c.ownerId === userId).map((c) => c.id));
    return [...this.items.values()].filter((i) => ownCycleIds.has(i.cycleId) && i.status === "published" && i.scheduledFor && i.scheduledFor >= since).map((i) => i.scheduledFor as Date);
  }

  async listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]> {
    await tick();
    return [...this.templates.values()].filter((t) => t.ownerId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }
  async createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean> {
    await tick(); // no await between the count and the write: atomic
    const named = [...this.templates.values()].filter((t) => t.ownerId === template.ownerId && !t.name.startsWith("v:")).length;
    if (named + 1 > limit) return false;
    this.templates.set(template.id, clone(template)); return true;
  }
  async saveVideoSettings(template: EditingTemplateRecord): Promise<void> {
    return this.withPromotionLock(`user:${template.ownerId}`, async () => {
      await tick();
      const existing = [...this.templates.values()].find((t) => t.ownerId === template.ownerId && t.name === template.name);
      if (existing) { existing.settings = clone(template.settings); return; }
      this.templates.set(template.id, clone(template));
    });
  }
  async applyVideoSettingsBatch(input: ApplyVideoSettingsBatchInput): Promise<"applied" | "existing" | "not_owned" | "conflict"> {
    if (input.audit.actorId !== input.ownerId || input.audit.action !== "editor.bulk_applied" || input.audit.entityType !== "BulkEditDraft" || input.audit.entityId !== input.operationId || input.audit.metadata?.["operationFingerprint"] !== input.operationFingerprint || !/^[a-f0-9]{64}$/.test(input.operationFingerprint)) return "conflict";
    return this.withPromotionLock(`user:${input.ownerId}`, async () => {
      await tick();
      const prior = this.audit.find((entry) => entry.action === input.audit.action && entry.entityType === input.audit.entityType && entry.entityId === input.audit.entityId);
      if (prior) return prior.actorId === input.ownerId && prior.metadata?.["operationFingerprint"] === input.operationFingerprint ? "existing" : "conflict";
      const mediaIds = input.templates.map((template) => template.name.startsWith("v:") ? template.name.slice(2) : "");
      if (input.templates.length === 0 || new Set(mediaIds).size !== mediaIds.length || input.expectedSettings.length !== input.templates.length || input.templates.some((template, index) => template.ownerId !== input.ownerId || !/^[A-Za-z0-9_-]{1,64}$/.test(mediaIds[index] ?? "") || template.name !== `v:${mediaIds[index]}` || input.expectedSettings[index]?.name !== template.name)) return "conflict";
      for (const mediaId of mediaIds) {
        const media = this.media.get(mediaId!);
        if (!media || media.ownerId !== input.ownerId || media.status !== "active" || (media.kind ?? "video") !== "video") return "not_owned";
      }
      for (const imageId of input.requiredImageIds) {
        const image = this.media.get(imageId);
        if (!image || image.ownerId !== input.ownerId || image.status !== "active" || image.kind !== "image") return "not_owned";
      }
      for (let index = 0; index < input.templates.length; index++) {
        const template = input.templates[index]!; const expected = input.expectedSettings[index]!.settings;
        const current = [...this.templates.values()].find((row) => row.ownerId === input.ownerId && row.name === template.name);
        if (expected === null ? Boolean(current) : !current || (() => { const parsed = parseEditingSettings(current.settings); return !parsed.ok || stableJson(parsed.settings) !== stableJson(expected); })()) return "conflict";
      }
      const oldRows = input.templates.map((template) => {
        const existing = [...this.templates.values()].find((row) => row.ownerId === input.ownerId && row.name === template.name);
        return { id: existing?.id ?? null, row: existing ? clone(existing) : null };
      });
      const oldAuditLength = this.audit.length;
      try {
        for (let index = 0; index < input.templates.length; index++) {
          const template = input.templates[index]!;
          const old = oldRows[index]!.row;
          if (old) this.templates.set(old.id, { ...old, settings: clone(template.settings) });
          else this.templates.set(template.id, clone(template));
        }
        if (this.beforeBulkSettingsAuditInsert?.(clone(input.audit)) === false) throw new Error("bulk settings audit insert failed");
        await this.appendAudit(input.audit);
        return "applied";
      } catch (error) {
        for (let index = 0; index < input.templates.length; index++) {
          const template = input.templates[index]!; const old = oldRows[index]!;
          this.templates.delete(template.id);
          if (old.row && old.id) this.templates.set(old.id, old.row);
        }
        this.audit.length = oldAuditLength;
        throw error;
      }
    });
  }
  async listAuditsForEntities(entityType: string, entityIds: string[]): Promise<{ entityId: string; action: string; metadata: Record<string, unknown> | null }[]> {
    await tick();
    const wanted = new Set(entityIds);
    return this.audit.filter((entry) => entry.entityType === entityType && wanted.has(entry.entityId)).map((entry) => ({ entityId: entry.entityId, action: entry.action, metadata: entry.metadata ?? null }));
  }

  async findRenderOutput(ownerId: string, sourceMediaId: string, settingsHash: string): Promise<{ id: string; sizeBytes: number } | null> {
    await tick();
    const found = [...this.renders.values()].find((r) => r.ownerId === ownerId && r.sourceMediaId === sourceMediaId && r.settingsHash === settingsHash);
    return found ? { id: found.id, sizeBytes: found.sizeBytes } : null;
  }
  async countRenderOutputsSince(ownerId: string, since: Date): Promise<number> {
    await tick();
    return [...this.renders.values()].filter((r) => r.ownerId === ownerId && r.createdAt >= since).length;
  }
  async saveRenderOutput(record: { id: string; sourceMediaId: string; ownerId: string; storageKey: string; sizeBytes: number; settingsHash: string; createdAt: Date }, limitBytes: number, fence?: import("./repository.ts").RenderJobFence): Promise<SaveRenderResult> {
    await tick();
    if (fence) {
      const job = this.renderJobs.get(fence.id);
      if (!job || job.ownerId !== fence.ownerId || job.status !== "running" || job.lockToken !== fence.lockToken) return { status: "stale_job" };
    }
    const existing = [...this.renders.values()].find((r) => r.ownerId === record.ownerId && r.sourceMediaId === record.sourceMediaId && r.settingsHash === record.settingsHash);
    if (existing) return { status: "duplicate", id: existing.id };
    const mediaBytes = [...this.media.values()].filter((m) => m.ownerId === record.ownerId && m.status !== "deleted").reduce((sum, m) => sum + m.sizeBytes, 0);
    const renderBytes = [...this.renders.values()].filter((r) => r.ownerId === record.ownerId).reduce((sum, r) => sum + r.sizeBytes, 0);
    if (mediaBytes + renderBytes + record.sizeBytes > limitBytes) return { status: "over_quota" };
    this.renders.set(record.id, clone(record));
    return { status: "saved", id: record.id };
  }
  async listRenderOutputsForOwner(ownerId: string): Promise<RenderOutputRecord[]> {
    await tick();
    return [...this.renders.values()].filter((r) => r.ownerId === ownerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, 20).map((row) => ({ id: row.id, sourceMediaId: row.sourceMediaId, ownerId: row.ownerId, sizeBytes: row.sizeBytes, createdAt: row.createdAt }));
  }
  async listRenderOutputsForOwnerAndSource(ownerId: string, sourceMediaId: string): Promise<RenderOutputRecord[]> {
    await tick();
    return [...this.renders.values()].filter((r) => r.ownerId === ownerId && r.sourceMediaId === sourceMediaId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .map(({ id, sourceMediaId: source, ownerId: owner, sizeBytes, createdAt }) => ({ id, sourceMediaId: source, ownerId: owner, sizeBytes, createdAt: clone(createdAt) }));
  }
  async createRenderJob(job: RenderJobRecord): Promise<CreateRenderJobResult> {
    await tick();
    if (this.renderJobs.has(job.id)) return { status: "conflict" };
    const duplicate = [...this.renderJobs.values()].find((stored) => stored.idempotencyKey === job.idempotencyKey);
    if (duplicate) {
      const samePayload = stableJson(duplicate.payload) === stableJson(job.payload);
      return duplicate.ownerId === job.ownerId && duplicate.kind === "render" && duplicate.mediaAssetId === job.mediaAssetId && duplicate.settingsHash === job.settingsHash && samePayload
        ? { status: "existing", job: clone(duplicate) } : { status: "conflict" };
    }
    this.renderJobs.set(job.id, clone(job));
    return { status: "created", job: clone(job) };
  }
  async getRenderJobForOwner(id: string, ownerId: string): Promise<RenderJobRecord | null> {
    await tick(); const job = this.renderJobs.get(id);
    return job?.ownerId === ownerId && job.kind === "render" ? clone(job) : null;
  }
  async getRenderJobByIdempotencyKey(idempotencyKey: string, ownerId: string): Promise<RenderJobRecord | null> {
    await tick(); const job = [...this.renderJobs.values()].find((item) => item.idempotencyKey === idempotencyKey);
    return job?.ownerId === ownerId && job.kind === "render" ? clone(job) : null;
  }
  async listRenderJobsForOwner(ownerId: string): Promise<RenderJobRecord[]> {
    await tick();
    return [...this.renderJobs.values()].filter((job) => job.ownerId === ownerId && job.kind === "render")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).map(clone);
  }
  async claimNextRenderJob(claim: RenderJobClaim): Promise<RenderJobRecord | null> {
    await tick();
    if (!claim.workerId || !Number.isFinite(claim.leaseSeconds) || claim.leaseSeconds <= 0) return null;
    const queued = [...this.renderJobs.values()].filter((job) => job.kind === "render" && (job.status === "queued" || (job.status === "running" && job.lockExpiresAt !== null && job.lockExpiresAt <= claim.now)) && (!claim.jobId || job.id === claim.jobId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    for (const job of queued) {
      const planId = await this.getPlanIdForUser(job.ownerId, claim.now);
      const active = [...this.renderJobs.values()].filter((item) => item.ownerId === job.ownerId && item.kind === "render" && item.status === "running" && item.lockExpiresAt !== null && item.lockExpiresAt > claim.now).length;
      if (active >= getPlan(planId).limits.concurrentJobs) continue;
      const claimed: RenderJobRecord = { ...job, status: "running", lockedBy: claim.workerId, lockToken: randomUUID(), lockExpiresAt: new Date(claim.now.getTime() + claim.leaseSeconds * 1000), attempts: job.attempts + 1, pendingOutputId: randomUUID(), ffmpegPid: null, ffmpegStartedAt: null };
      this.renderJobs.set(job.id, claimed);
      return clone(claimed);
    }
    return null;
  }
  private async updateClaimedRenderJob(id: string, ownerId: string, lockToken: string, changes: Partial<RenderJobRecord>): Promise<boolean> {
    await tick(); const job = this.renderJobs.get(id);
    if (!job || job.kind !== "render" || job.ownerId !== ownerId || job.status !== "running" || !lockToken || job.lockToken !== lockToken) return false;
    this.renderJobs.set(id, { ...job, ...clone(changes) }); return true;
  }
  async heartbeatRenderJob(id: string, ownerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean> {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return false;
    return this.updateClaimedRenderJob(id, ownerId, lockToken, { lockExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) });
  }
  async updateRenderJobProgress(id: string, ownerId: string, lockToken: string, progressPercent: number): Promise<boolean> {
    if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) return false;
    return this.updateClaimedRenderJob(id, ownerId, lockToken, { progressPercent });
  }
  async completeRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, outputDerivativeId: string): Promise<boolean> {
    if (!outputDerivativeId) return false;
    return this.updateClaimedRenderJob(id, ownerId, lockToken, { status: "succeeded", progressPercent: 100, finishedAt, outputDerivativeId, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async failRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, errorMessage: string): Promise<boolean> {
    return this.updateClaimedRenderJob(id, ownerId, lockToken, { status: "failed", finishedAt, errorMessage, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async cancelRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date): Promise<boolean> {
    return this.updateClaimedRenderJob(id, ownerId, lockToken, { status: "cancelled", finishedAt, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async getRenderOutput(id: string): Promise<{ id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string } | null> {
    await tick();
    const row = this.renders.get(id);
    return row ? { id: row.id, ownerId: row.ownerId, sourceMediaId: row.sourceMediaId, sizeBytes: row.sizeBytes, storageKey: row.storageKey } : null;
  }
  async addUsageRecords(records: UsageRecordDraft[]): Promise<void> {
    await tick();
    for (const record of records) {
      if (this.usageKeys.has(record.idempotencyKey)) continue;
      this.usageKeys.add(record.idempotencyKey);
      const key = `${record.userId}|${record.periodStart.toISOString()}`;
      const current = this.usageByMonth.get(key) ?? { processingSeconds: 0, exports: 0, scheduledItems: 0 };
      if (record.kind === "processing_seconds") current.processingSeconds += record.amount;
      if (record.kind === "exports") current.exports += record.amount;
      if (record.kind === "scheduled_items") current.scheduledItems += record.amount;
      this.usageByMonth.set(key, current);
    }
  }
  async saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void> { await tick(); this.captionRevisions.push(...revisions.map(clone)); }
  async appendAudit(entry: AuditEntry): Promise<void> { await tick(); this.audit.push(clone(entry)); }
}
