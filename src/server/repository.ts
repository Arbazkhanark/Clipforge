// The database as the handlers see it.
// src/server/prisma/prisma-repository.ts is the PostgreSQL implementation.
// src/server/memory-repository.ts is the same contract in memory, used by tests and local demo mode.
//
// CONCURRENCY CONTRACT: saveCycleItemsIfVersionMatches must behave like
//   UPDATE "CycleItem" SET ... , version = :newVersion WHERE id = :id AND version = :expectedVersion
// for each item, and report whether a row changed. Two writers can never both win.
import type { PlanId } from "../lib/billing/catalog.ts";
import type { SubscriptionStatus } from "../lib/billing/subscription-state.ts";
import type { CaptionRevision } from "../lib/domain/caption-cover-updates.ts";
import type { EditingSettings } from "../lib/domain/editing-settings.ts";
import type { UsageRecordDraft } from "../lib/domain/usage-accounting.ts";
import type { MediaSort } from "../lib/domain/media-list.ts";
import type { ScheduleSettings } from "../lib/domain/schedule.ts";
import type { OrderMode } from "../lib/domain/ordering.ts";
import type { Capability, CollectionPermissionGrant, CollectionVisibility, CycleItem, CycleStatus, MediaAsset, PublishingCycle, VideoCollection } from "../lib/domain/types.ts";
import type { AccessRequestStatus } from "../lib/domain/sharing-permissions.ts";

export interface CollectionAccessRequestRecord { id: string; collectionId: string; requesterId: string; requestedCapabilities: Capability[]; status: AccessRequestStatus; decidedById: string | null; decidedAt: Date | null; createdAt: Date; }
export interface CreateCollectionAccessRequestInput { id: string; collectionId: string; requesterId: string; requestedCapabilities: Capability[]; now: Date; }
export type CreateCollectionAccessRequestResult = { status: "created" | "existing"; request: CollectionAccessRequestRecord } | { status: "not_found" | "already_has_access" | "invalid" | "conflict"; reason?: string };
export interface DecideCollectionAccessRequestInput { collectionId: string; requestId: string; ownerId: string; decision: "approved" | "rejected"; now: Date; }
export type DecideCollectionAccessRequestResult = { status: "applied"; request: CollectionAccessRequestRecord; grant: CollectionPermissionGrant | null } | { status: "not_found" | "already_decided" | "forbidden" | "plan_limit" | "invalid" | "conflict"; reason?: string };
export interface CollectionShareLinkRecord { id: string; collectionId: string; tokenHash: string; capabilities: Capability[]; expiresAt: Date | null; revokedAt: Date | null; createdById: string; createdAt: Date; }
export type CollectionShareLinkSummary = Omit<CollectionShareLinkRecord, "tokenHash">;
export interface CreateCollectionShareLinkInput { id: string; collectionId: string; ownerId: string; tokenHash: string; capabilities: Capability[]; expiresAt: Date | null; now: Date; }
export type CreateCollectionShareLinkResult = { status: "created"; link: CollectionShareLinkSummary } | { status: "not_found" | "invalid" | "plan_limit" | "conflict"; reason?: string };
export interface UpdateCollectionShareLinkInput { id: string; collectionId: string; ownerId: string; capabilities: Capability[]; expiresAt: Date | null; now: Date; }
export type UpdateCollectionShareLinkResult = { status: "updated" | "unchanged"; link: CollectionShareLinkSummary } | { status: "not_found" | "revoked" | "invalid" | "plan_limit" | "conflict"; reason?: string };
export type RevokeCollectionShareLinkResult = "revoked" | "already_revoked" | "not_found";

export interface PersistedCycleSchedule extends ScheduleSettings { startDate: string; orderMode?: OrderMode; shuffleSeed?: string | null; }
export interface CycleRecord extends PublishingCycle { name: string; socialAccountId: string; repeatBehavior?: "never" | "ask" | "automatic"; scheduleSettings?: PersistedCycleSchedule | null; timezone?: string; createdAt?: Date; }
export type CompleteSettledCycleResult = "completed" | "repeat_queued" | "repeat_skipped_limit" | "not_ready" | "already_completed" | "not_found";
export const INSTAGRAM_ACCOUNT_TYPES = ["BUSINESS", "MEDIA_CREATOR", "PERSONAL", "UNKNOWN"] as const;
export type InstagramAccountType = (typeof INSTAGRAM_ACCOUNT_TYPES)[number];
export interface PublishingJobRecord {
  id: string;
  cycleItemId: string;
  outcome: "in_progress" | "success" | "definite_failure" | "ambiguous";
  startedAt: Date;
}
export interface PublishingAttemptRecord extends PublishingJobRecord {
  ownerId: string;
  cycleId: string;
  socialAccountId: string;
  attemptNumber: number;
  idempotencyKey: string;
  stage: PublishingJobStage;
  workerId: string | null;
  lockToken: string | null;
  leaseExpiresAt: Date | null;
  containerId: string | null;
  instagramMediaId: string | null;
  errorCategory: string | null;
  errorDetails: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
export type PublishingJobStage = "queued" | "claimed" | "container_creation_pending" | "container_processing" | "ready_to_publish" | "publishing" | "published" | "failed" | "needs_manual_review" | "cancelled";
export interface CreatePublishingAttemptInput { id: string; ownerId: string; cycleId: string; cycleItemId: string; socialAccountId: string; attemptNumber: number; idempotencyKey: string; now: Date; }
export interface ClaimPublishingAttemptInput { attemptId: string; ownerId: string; cycleId: string; cycleItemId: string; socialAccountId: string; expectedItemVersion: number; workerId: string; now: Date; leaseSeconds: number; }
/** errorDetails is for a short, redacted diagnostic only; never pass tokens or raw provider response bodies. */
export interface PublishingAttemptUpdate { jobId: string; ownerId: string; workerId: string; lockToken: string; expectedStage: PublishingJobStage; nextStage: PublishingJobStage; now: Date; leaseSeconds?: number; containerId?: string | null; instagramMediaId?: string | null; errorCategory?: string | null; errorDetails?: string | null; }

export interface SocialAccountRecord {
  id: string;
  userId: string;
  platform?: "instagram" | "youtube_shorts" | "tiktok";
  status: "connected" | "token_expired" | "revoked" | "disconnected";
  username?: string;
  externalAccountId?: string;
  accountType?: InstagramAccountType;
  grantedScopes?: string[];
  tokenExpiresAt?: Date | null;
  /** True only when a ciphertext is stored. The token itself is never on this record. */
  hasToken?: boolean;
}
export interface DuePublishingCandidate { cycle: CycleRecord; item: CycleItem; account: SocialAccountRecord | null; }
export interface InstagramConnectionWrite {
  id: string;
  userId: string;
  externalAccountId: string;
  username: string | null;
  accountType: InstagramAccountType;
  grantedScopes: string[];
  tokenExpiresAt: Date;
  encryptedAccessToken: string;
}
export interface InstagramTokenCiphertext { encryptedAccessToken: string; tokenExpiresAt: Date | null; status: SocialAccountRecord["status"]; }
export interface EditingTemplateRecord { id: string; ownerId: string; name: string; settings: EditingSettings; createdAt: Date; }
export interface ApplyVideoSettingsBatchInput {
  ownerId: string;
  operationId: string;
  operationFingerprint: string;
  templates: EditingTemplateRecord[];
  expectedSettings: { name: string; settings: EditingSettings | null }[];
  requiredImageIds: string[];
  audit: AuditEntry;
}
export type ApplyVideoSettingsBatchResult = "applied" | "existing" | "not_owned" | "conflict";
export interface RenderOutputRecord { id: string; sourceMediaId: string; ownerId: string; sizeBytes: number; createdAt: Date; }
export interface RenderOutputPreviewRecord { id: string; sourceMediaId: string; settingsHash: string; }
export interface SelectCycleItemRenderOutputInput { cycleId: string; itemId: string; ownerId: string; renderOutputId: string | null; expectedVersion: number; }
export type SaveRenderResult = { status: "saved" | "duplicate"; id: string } | { status: "over_quota" } | { status: "stale_job" };
export type RenderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface RenderJobRecord {
  id: string; ownerId: string; kind: "render"; status: RenderJobStatus; cycleItemId: string | null; mediaAssetId: string | null;
  progressPercent: number; attempts: number; idempotencyKey: string; lockedBy: string | null; lockExpiresAt: Date | null;
  errorMessage: string | null; createdAt: Date; finishedAt: Date | null; settingsHash: string | null; payload: unknown;
  pendingOutputId: string | null; outputDerivativeId: string | null; lockToken: string | null; ffmpegPid: number | null; ffmpegStartedAt: Date | null;
}
export type CreateRenderJobResult = { status: "created" | "existing"; job: RenderJobRecord } | { status: "conflict" };
export interface RenderJobClaim { workerId: string; now: Date; leaseSeconds: number; jobId?: string; }
export type MediaVerificationStage = "queued" | "uploading" | "uploaded_to_storage" | "storage_verifying" | "storage_verified" | "media_probing" | "media_verified" | "thumbnail_generating" | "thumbnail_verifying" | "thumbnail_verified" | "thumbnail_skipped" | "completed";
export type MediaVerificationOutcome = "processing" | "verified" | "incomplete" | "failed";
export type MediaVerificationJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export interface MediaVerificationJobRecord {
  id: string; ownerId: string; mediaAssetId: string; status: MediaVerificationJobStatus; progressPercent: number;
  attempts: number; idempotencyKey: string; lockedBy: string | null; lockToken: string | null; lockExpiresAt: Date | null;
  errorMessage: string | null; createdAt: Date; finishedAt: Date | null; payload: unknown;
}
export interface MediaVerificationState {
  mediaId: string; status: MediaVerificationOutcome | "legacy_unverified"; stage: MediaVerificationStage;
  completedStages: MediaVerificationStage[]; errorCode: string | null; errorMessage: string | null;
  attempts: number; retryable: boolean; updatedAt: Date | null; thumbnailStatus: "pending" | "verified" | "failed" | "skipped";
}
export interface MediaCleanupJobRecord { id: string; ownerId: string; mediaAssetId: string; status: "queued" | "running" | "succeeded" | "failed"; attempts: number; lockToken: string | null; lockExpiresAt: Date | null; createdAt: Date; }
export type PermanentMediaDeletionResult = { status: "queued" | "existing"; job: MediaCleanupJobRecord; removedCollectionIds: string[] } | { status: "missing" | "already_deleted" | "collections_changed" | "in_use" | "cover_in_use" | "import_in_progress" | "conflict" };
export interface MediaVerificationClaim { workerId: string; now: Date; leaseSeconds: number; jobId?: string; }
export interface RenderJobFence { id: string; ownerId: string; lockToken: string; }
export interface AuditEntry { actorId: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown>; }
export type MediaImportStatus = "pending" | "copying" | "verifying" | "succeeded" | "failed";
export interface MediaImportJobRecord {
  id: string; importerId: string; sourceMediaId: string; sourceCollectionId: string; status: MediaImportStatus;
  idempotencyKey: string; newObjectKey: string; stagingObjectKey: string | null; attemptStorageKeys: string[];
  resultMediaAssetId: string; failureReason: string | null; attempts: number; lockedBy: string | null;
  lockToken: string | null; leaseExpiresAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface MediaImportRequestInput { id: string; importerId: string; sourceMediaId: string; sourceCollectionId: string; resultMediaAssetId: string; idempotencyKey: string; now: Date; }
export type MediaImportRequestResult = { status: "created" | "existing"; job: MediaImportJobRecord } | { status: "not_found" | "unauthorized" | "quota" | "conflict" };
export interface MediaImportClaim { workerId: string; now: Date; leaseSeconds: number; jobId?: string; }
export interface MediaImportFinalizationInput { jobId: string; lockToken: string; importerId: string; now: Date; media: MediaAsset; storageKey: string; commitStagedObject: () => Promise<void>; }
export interface MediaImportVerificationInput { jobId: string; lockToken: string; now: Date; }
export interface CreateCollectionGrantInput { collectionId: string; actorId: string; granteeId: string; capabilities: Capability[]; expiresAt: Date | null; now: Date; }
export interface RevokeCollectionGrantInput { collectionId: string; actorId: string; granteeId: string; now: Date; }
export type CollectionGrantMutationResult =
  | { status: "applied" | "existing"; grant: CollectionPermissionGrant }
  | { status: "not_found" | "forbidden" | "plan_limit" | "invalid" | "conflict"; reason?: string };
export interface RazorpaySubscriptionEventInput { providerEventId: string; eventType: string; subscriptionId?: string; newStatus?: SubscriptionStatus; createdAt?: number; currentPeriodEnd?: number; payment?: { id: string; amount: number; currency: string; status: string }; }
export type RazorpaySubscriptionEventResult = "applied" | "duplicate" | "ignored" | "stale" | "invalid_transition" | "unknown_subscription";
export type RazorpayIntentStatus = "creating" | "created" | "active" | "failed" | "manual_review" | "cancelled" | "expired";
export interface RazorpaySubscriptionIntentRecord { id: string; userId: string; idempotencyKey: string; autoRenewConsentAt?: Date | null; autoRenewConsentVersion?: string | null; providerSubscriptionId: string | null; providerPlanId: string; checkoutUrl: string | null; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number | null; currency: "INR"; status: RazorpayIntentStatus; errorCategory: string | null; createdAt: Date; updatedAt: Date; }
export interface ReserveRazorpaySubscriptionIntentInput { id: string; userId: string; idempotencyKey: string; autoRenewConsentAt: Date; autoRenewConsentVersion: string; providerPlanId: string; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number; now: Date; }
export interface SubscriptionContinuationCandidate { id: string; userId: string; planId: PlanId; interval: "weekly" | "monthly"; providerSubscriptionId: string; currentPeriodEnd: Date; }
export interface SubscriptionContinuationInput { id: string; subscriptionId: string; providerSubscriptionId: string; cycleEnd: Date; observedTotalCount: number; observedPaidCount: number; observedRemainingCount: number; targetRemainingCount: number; now: Date; }
export type SubscriptionContinuationStatus = "reserved" | "applied" | "manual_review" | "skipped";
export type ManualIntentStatus = "creating" | "created" | "paid" | "failed" | "expired" | "manual_review";
export interface ManualPaymentIntentRecord { id: string; userId: string; idempotencyKey: string; providerPaymentLinkId: string | null; checkoutUrl: string | null; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number; currency: "INR"; status: ManualIntentStatus; accessStartsAt: Date | null; accessEndsAt: Date | null; errorCategory: string | null; createdAt: Date; updatedAt: Date; }
export interface SettleManualPaymentInput { userId: string; intentId: string; providerPaymentLinkId: string; providerPaymentId: string; amountPaise: number; currency: string; status: string; paidAt: Date; now: Date; }

export type PromotionType = "bonus_days" | "tier_access" | "discount_coupon" | "free_access_coupon";
export type PromotionStatus = "draft" | "active" | "paused" | "expired" | "revoked";
export type PromotionDiscountType = "percentage" | "fixed_amount";
export type PromotionRedemptionStatus = "reserved" | "redeemed" | "released" | "manual_review";
export type PromotionalAccessStatus = "queued" | "active" | "expired" | "revoked";
export type PromotionalAccessKind = "bonus_days" | "tier_access" | "free_access_coupon";
export type PromotionActivationPolicy = "immediate" | "after_current_access";
export type PromotionLifecycleEventType = "promotion_created" | "promotion_updated" | "promotion_paused" | "promotion_revoked" | "grant_created" | "grant_queued" | "grant_activated" | "grant_expired" | "grant_revoked" | "coupon_reserved" | "coupon_redeemed" | "coupon_released" | "manual_review_required";

export interface PromotionRecord {
  id: string; type: PromotionType; status: PromotionStatus; code: string | null;
  discountType: PromotionDiscountType | null; discountValue: number | null; accessPlanId: PlanId | null;
  durationDays: number | null; eligiblePlanIds: PlanId[]; targetUserId: string | null;
  startsAt: Date; expiresAt: Date | null; usageLimit: number | null; createdByAdminId: string;
  reason: string | null; createdAt: Date; updatedAt: Date;
}
export interface PromotionRedemptionRecord {
  id: string; promotionId: string; userId: string; status: PromotionRedemptionStatus; idempotencyKey: string;
  planId: PlanId | null; interval: "weekly" | "monthly" | null; listPricePaise: number | null; discountPaise: number | null;
  payablePaise: number | null; currency: "INR" | null; manualPaymentIntentId: string | null;
  manualPaymentIntentUserId: string | null; reservedAt: Date; redeemedAt: Date | null; releasedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}
export interface PromotionalAccessGrantRecord {
  id: string; promotionId: string; userId: string; redemptionId: string | null; kind: PromotionalAccessKind;
  activationPolicy: PromotionActivationPolicy; status: PromotionalAccessStatus; planId: Exclude<PlanId, "free">;
  durationDays: number; queueSequence: bigint; startsAt: Date | null; expiresAt: Date | null;
  activatedAt: Date | null; revokedAt: Date | null; grantedByAdminId: string | null; reason: string | null;
  createdAt: Date; updatedAt: Date;
}
export interface PromotionLifecycleEventRecord {
  id: string; eventKey: string; eventType: PromotionLifecycleEventType; promotionId: string;
  subjectUserId: string | null; actorUserId: string | null; redemptionId: string | null; accessGrantId: string | null;
  occurredAt: Date; outcome: string | null; metadata: Record<string, string | number | boolean | null> | null;
}
export interface PromotionRedemptionHistoryRow {
  id: string; userId: string; status: PromotionRedemptionStatus; planId: PlanId | null; interval: "weekly" | "monthly" | null;
  listPricePaise: number | null; discountPaise: number | null; payablePaise: number | null; currency: string | null; createdAt: Date; updatedAt: Date;
}
export interface PromotionLifecycleHistoryRow {
  id: string; eventType: PromotionLifecycleEventType; subjectUserId: string | null; actorUserId: string | null;
  redemptionId: string | null; accessGrantId: string | null; occurredAt: Date; outcome: string | null; auditId: string | null;
}
export interface PromotionHistoryPage<T> { items: T[]; total: number; }
export interface PromotionUsageCounts { reserved: number; redeemed: number; released: number; manualReview: number; }
export interface PromotionHistoryQuery { skip: number; take: number; }
export interface UserPromotionRedemptionStatus {
  redemption: Pick<PromotionRedemptionRecord, "id" | "promotionId" | "userId" | "status" | "planId" | "interval" | "listPricePaise" | "discountPaise" | "payablePaise" | "currency" | "redeemedAt" | "createdAt" | "updatedAt">;
  coupon: Pick<PromotionRecord, "status" | "startsAt" | "expiresAt">;
  manualPayment: Pick<ManualPaymentIntentRecord, "id" | "status" | "accessStartsAt" | "accessEndsAt"> | null;
  grant: Pick<PromotionalAccessGrantRecord, "id" | "status" | "planId" | "startsAt" | "expiresAt"> | null;
}
export interface CreatePromotionRedemptionInput {
  id: string; promotionId: string; userId: string; idempotencyKey: string; planId?: PlanId | null;
  interval?: "weekly" | "monthly" | null; listPricePaise?: number | null; discountPaise?: number | null; payablePaise?: number | null;
  manualPaymentIntentId?: string | null; now: Date;
}
export interface ReserveDiscountedManualPaymentIntentInput {
  id: string; userId: string; idempotencyKey: string; planId: PlanId;
  interval: "weekly" | "monthly"; couponCode: string; now: Date;
}
export type ReserveDiscountedManualPaymentIntentResult =
  | { status: "created" | "existing"; intent: ManualPaymentIntentRecord; redemption: PromotionRedemptionRecord }
  | { status: "unavailable" | "conflict" };
export interface RedeemFreeAccessCouponInput { redemptionId: string; grantId: string; userId: string; code: string; idempotencyKey: string; now: Date; }
export type RedeemFreeAccessCouponResult =
  | { status: "created" | "existing"; redemption: PromotionRedemptionRecord; grant: PromotionalAccessGrantRecord }
  | { status: "unavailable" | "conflict" };
export interface CreatePromotionalAccessGrantInput {
  id: string; promotionId: string; userId: string; redemptionId?: string | null; kind: PromotionalAccessKind;
  activationPolicy: PromotionActivationPolicy; planId: Exclude<PlanId, "free">; durationDays: number;
  grantedByAdminId?: string | null; reason?: string | null; now: Date;
}
export interface PromotionLifecycleEventInput {
  id: string; eventKey: string; eventType: PromotionLifecycleEventType; promotionId: string;
  subjectUserId?: string | null; actorUserId?: string | null; redemptionId?: string | null; accessGrantId?: string | null;
  occurredAt: Date; outcome?: string | null; metadata?: Record<string, string | number | boolean | null> | null;
}
export interface PromotionListQuery {
  skip: number;
  take: number;
  search?: string;
  type?: Extract<PromotionType, "discount_coupon" | "free_access_coupon">;
  status?: PromotionStatus;
}
export interface PromotionListPage { items: PromotionRecord[]; total: number; }
export type UpdateDraftPromotionResult =
  | { status: "updated"; promotion: PromotionRecord }
  | { status: "missing" | "target_user_missing" | "not_draft" | "stale" | "history" | "duplicate_code" | "conflict" };
export type UpdatePromotionReasonResult =
  | { status: "updated"; promotion: PromotionRecord }
  | { status: "missing" | "stale" | "conflict" };
export type TransitionCouponStatusResult =
  | { status: "updated"; promotion: PromotionRecord }
  | { status: "missing" | "not_coupon" | "invalid_status" | "stale" | "conflict" };

export interface Repository {
  createPromotion(record: PromotionRecord): Promise<boolean>;
  updateDraftPromotion(input: { record: PromotionRecord; expectedUpdatedAt: Date; actorUserId: string }): Promise<UpdateDraftPromotionResult>;
  updatePromotionReason(input: { id: string; reason: string | null; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<UpdatePromotionReasonResult>;
  transitionCouponStatus(input: { id: string; expectedStatus: "draft" | "active"; nextStatus: "active" | "paused"; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<TransitionCouponStatusResult>;
  listPromotions(query: PromotionListQuery): Promise<PromotionListPage>;
  getPromotionUsageCounts(promotionIds: string[]): Promise<Record<string, PromotionUsageCounts>>;
  listPromotionRedemptionHistory(promotionId: string, query: PromotionHistoryQuery): Promise<PromotionHistoryPage<PromotionRedemptionHistoryRow>>;
  listPromotionLifecycleHistory(promotionId: string, query: PromotionHistoryQuery): Promise<PromotionHistoryPage<PromotionLifecycleHistoryRow>>;
  getUserPromotionRedemptionStatus(userId: string, redemptionId: string): Promise<UserPromotionRedemptionStatus | null>;
  getPromotion(id: string): Promise<PromotionRecord | null>;
  getPromotionByCode(code: string): Promise<PromotionRecord | null>;
  createOrGetPromotionRedemption(input: CreatePromotionRedemptionInput): Promise<{ status: "created" | "existing" | "conflict"; redemption?: PromotionRedemptionRecord }>;
  redeemFreeAccessCoupon(input: RedeemFreeAccessCouponInput): Promise<RedeemFreeAccessCouponResult>;
  transitionPromotionRedemption(input: { id: string; userId: string; expectedStatus: PromotionRedemptionStatus; nextStatus: PromotionRedemptionStatus; now: Date }): Promise<boolean>;
  createPromotionalAccessGrant(input: CreatePromotionalAccessGrantInput): Promise<{ status: "created" | "existing" | "conflict"; grant?: PromotionalAccessGrantRecord }>;
  activateNextPromotionalAccessGrant(userId: string, now: Date): Promise<PromotionalAccessGrantRecord | null>;
  transitionPromotionalAccessGrant(input: { id: string; userId: string; actorUserId?: string | null; expectedStatus: PromotionalAccessStatus; nextStatus: Extract<PromotionalAccessStatus, "expired" | "revoked">; now: Date }): Promise<boolean>;
  getPromotionalAccessGrant(userId: string, grantId: string): Promise<PromotionalAccessGrantRecord | null>;
  listPromotionalAccessGrantsForUser(userId: string): Promise<PromotionalAccessGrantRecord[]>;
  createPromotionLifecycleEvent(input: PromotionLifecycleEventInput): Promise<"created" | "duplicate" | "conflict">;
  listPromotionLifecycleEvents(promotionId: string): Promise<PromotionLifecycleEventRecord[]>;

  /** The plan whose limits apply to this user right now (free when there is no entitled subscription). */
  getPlanIdForUser(userId: string, now?: Date): Promise<PlanId>;
  /** Stores an authenticated provider event and applies its status transition atomically and idempotently. */
  processRazorpaySubscriptionEvent(input: RazorpaySubscriptionEventInput): Promise<RazorpaySubscriptionEventResult>;
  reserveRazorpaySubscriptionIntent(input: ReserveRazorpaySubscriptionIntentInput): Promise<{ status: "created" | "existing" | "conflict"; intent?: RazorpaySubscriptionIntentRecord }>;
  finishRazorpaySubscriptionIntent(input: { id: string; userId: string; status: RazorpayIntentStatus; providerSubscriptionId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean>;
  getRazorpaySubscriptionIntent(userId: string, idempotencyKey: string): Promise<RazorpaySubscriptionIntentRecord | null>;
  getRazorpaySubscriptionIntentByProviderId(userId: string, providerSubscriptionId: string): Promise<RazorpaySubscriptionIntentRecord | null>;
  getRazorpaySubscriptionForOwner(userId: string): Promise<{ id: string; planId: PlanId; interval: "weekly" | "monthly"; status: SubscriptionStatus; razorpaySubscriptionId: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; trialEndsAt: number | null } | null>;
  recordRazorpayCancellation(userId: string, providerSubscriptionId: string, cancelAtPeriodEnd: boolean, providerStatus: SubscriptionStatus, currentPeriodEnd: Date | null, now: Date): Promise<boolean>;
  requestRazorpayCancellation(userId: string, providerSubscriptionId: string, now: Date): Promise<boolean>;
  listSubscriptionContinuationCandidates(now: Date): Promise<SubscriptionContinuationCandidate[]>;
  reserveSubscriptionContinuation(input: SubscriptionContinuationInput): Promise<"reserved" | "existing" | "cancelled" | "not_due">;
  finishSubscriptionContinuation(input: { id: string; status: Exclude<SubscriptionContinuationStatus, "reserved">; errorCategory?: string; now: Date }): Promise<boolean>;

  reserveManualPaymentIntent(input: { id: string; userId: string; idempotencyKey: string; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number; now: Date }): Promise<{ status: "created" | "existing" | "conflict"; intent?: ManualPaymentIntentRecord }>;
  reserveDiscountedManualPaymentIntent(input: ReserveDiscountedManualPaymentIntentInput): Promise<ReserveDiscountedManualPaymentIntentResult>;
  finishManualPaymentIntent(input: { id: string; userId: string; status: ManualIntentStatus; providerPaymentLinkId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean>;
  getManualPaymentIntent(userId: string, intentId: string): Promise<ManualPaymentIntentRecord | null>;
  getManualPaymentIntentForWebhook(intentId: string): Promise<ManualPaymentIntentRecord | null>;
  settleManualPayment(input: SettleManualPaymentInput): Promise<"applied" | "duplicate" | "invalid" | "conflict">;
  getCycle(cycleId: string): Promise<CycleRecord | null>;
  countActiveCycles(userId: string): Promise<number>;
  createCycle(cycle: CycleRecord): Promise<void>;
  /** Creates a user-owned draft only while the caller's active-cycle limit still has room. */
  createCycleWithinLimit(cycle: CycleRecord, activeCycleLimit: number): Promise<boolean>;
  /** Bounded, stable scan used to recover a completion pass after worker interruption. */
  listRunningCyclesForSettlement(afterCycleId: string | null, limit: number): Promise<CycleRecord[]>;
  /** Atomically completes a settled cycle and, when enabled and within limits, queues its next draft round. */
  completeSettledCycle(input: { cycleId: string; ownerId: string; now: Date; activeCycleLimit: number; newId: () => string }): Promise<CompleteSettledCycleResult>;
  /** Moves a cycle from `from` to `to` only if it is still in `from`. Returns false if someone else changed it first. */
  transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean>;
  /** Atomically stops an owned cycle and cancels the version-checked editable items. */
  stopCycle(cycleId: string, ownerId: string, from: CycleStatus, finalReviewConfirmed: boolean, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean>;

  getCycleItems(cycleId: string): Promise<CycleItem[]>;
  /** Adds items only while the parent cycle is still editable; serializes against cycle completion. */
  addCycleItems(items: CycleItem[], expectedCollectionSettingsVersions?: Record<string, number>, orderUpdates?: { item: CycleItem; expectedVersion: number }[]): Promise<boolean>;
  saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]>;
  /** Explicit, owner/source-checked output selection for a versioned item in an owned draft cycle. */
  selectCycleItemRenderOutput(input: SelectCycleItemRenderOutputInput): Promise<boolean>;
  /** Saves draft schedule settings and their item assignments atomically, only for the cycle owner. */
  saveCycleSchedule(cycleId: string, ownerId: string, scheduleSettings: PersistedCycleSchedule, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean>;

  getMedia(mediaId: string): Promise<MediaAsset | null>;
  /** One query for many ids (avoids N+1). Missing ids are simply absent from the result. */
  getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]>;
  /** Pages of the user's OWN media. Default order is newest, then id. Never loads a whole library at once. */
  listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image"; search?: string; sort?: MediaSort }): Promise<{ items: MediaAsset[]; total: number }>;
  /**
   * Adds a media record ONLY if the owner's stored bytes plus this file stay within `limitBytes`.
   * Must be atomic (a transaction in PostgreSQL) so two simultaneous uploads cannot both squeeze past the quota.
   * `storageKey` stays inside the repository: it is never returned by queries.
   */
  addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean>;
  /** Atomically creates a not-yet-verified media row and its single idempotent verification job within quota. */
  addMediaWithVerificationJobIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, job: MediaVerificationJobRecord, audit: AuditEntry, limitBytes: number): Promise<boolean>;
  getMediaVerificationForOwner(ownerId: string, mediaId: string): Promise<MediaVerificationState | null>;
  listMediaVerificationsForOwner(ownerId: string, mediaIds: string[]): Promise<MediaVerificationState[]>;
  retryMediaVerification(ownerId: string, mediaId: string, now: Date): Promise<"queued" | "existing" | "missing" | "not_retryable">;
  claimNextMediaVerificationJob(claim: MediaVerificationClaim): Promise<MediaVerificationJobRecord | null>;
  updateMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; now: Date; leaseSeconds: number; payload: unknown }): Promise<boolean>;
  completeMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; finishedAt: Date; payload: unknown; width: number; height: number; durationMs: number | null }): Promise<boolean>;
  failMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; now: Date; payload: unknown; errorMessage: string; retryAt?: Date }): Promise<boolean>;
  /** For the serving routes ONLY. These keys never leave the server. */
  getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null>;
  createOrGetMediaImportJob(input: MediaImportRequestInput): Promise<MediaImportRequestResult>;
  getMediaImportJobForOwner(importerId: string, jobId: string): Promise<MediaImportJobRecord | null>;
  listMediaImportJobsForOwner(importerId: string): Promise<MediaImportJobRecord[]>;
  retryMediaImportJob(importerId: string, jobId: string, now: Date): Promise<boolean>;
  claimNextMediaImportJob(input: MediaImportClaim): Promise<MediaImportJobRecord | null>;
  heartbeatMediaImportJob(input: { jobId: string; lockToken: string; now: Date; leaseSeconds: number }): Promise<boolean>;
  markMediaImportVerifying(input: MediaImportVerificationInput): Promise<boolean>;
  finalizeMediaImportJob(input: MediaImportFinalizationInput): Promise<"applied" | "stale" | "unauthorized" | "quota">;
  failMediaImportJob(input: { jobId: string; lockToken: string; now: Date; reason: string }): Promise<boolean>;
  scheduleMediaDeletion(input: { mediaId: string; ownerId: string; now: Date; graceDays: number }): Promise<"scheduled" | "missing" | "already_pending" | "import_pending">;
  requestPermanentMediaDeletion(input: { id: string; mediaId: string; ownerId: string; expectedCollectionIds: string[]; now: Date }): Promise<PermanentMediaDeletionResult>;
  claimMediaCleanupJob(input: { workerId: string; now: Date; leaseSeconds: number }): Promise<MediaCleanupJobRecord | null>;
  finishMediaCleanupJob(input: { id: string; ownerId: string; lockToken: string; now: Date }): Promise<boolean>;
  failMediaCleanupJob(input: { id: string; ownerId: string; lockToken: string; now: Date; errorCode: string; retryAt: Date | null }): Promise<boolean>;
  canCleanupMediaAsset(mediaId: string): Promise<boolean>;
  /** Every collection (anyone's) that currently contains this media, for access checks. */
  listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]>;
  listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]>;
  listCollectionsForOwner(userId: string): Promise<VideoCollection[]>;
  /** Collections other people shared with this user through a currently valid grant. */
  listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]>;
  listCyclesForOwner(userId: string): Promise<CycleRecord[]>;
  getStorageUsedBytes(userId: string): Promise<number>;
  getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }>;
  getCollection(collectionId: string): Promise<VideoCollection | null>;
  /**
   * Creates the collection and its items in `mediaIds` order.
   * Returns false when the id already exists, the media list repeats an id, or a media row does not exist.
   * Nothing is written in those cases.
   */
  createCollection(collection: VideoCollection): Promise<boolean>;
  /** Atomically appends an owned active media item to an owned collection; idempotent for existing membership. */
  addOwnedMediaToCollection(input: { collectionId: string; mediaAssetId: string; ownerId: string; actorId: string; now: Date }): Promise<"added" | "existing" | "not_found" | "not_owned">;
  saveCollectionItemSettings(input: { collectionId: string; ownerId: string; mediaAssetId: string; captionText: string; coverMediaId: string | null; expectedVersion: number }): Promise<boolean>;
  saveCollectionSharedSettings(input: { collectionId: string; ownerId: string; actorId: string; affected: number; expectedVersion: number; captionMode?: "individual" | "shared"; sharedCaptionText?: string | null; coverMode?: "individual" | "shared"; sharedCoverMediaId?: string | null }): Promise<boolean>;
  /** Changes the name, description, visibility, and archived flag. Returns false when the collection does not exist. Items stay as they are. */
  updateCollection(collectionId: string, details: { name: string; description: string | null; visibility: CollectionVisibility; archived: boolean }): Promise<boolean>;
  /**
   * Replaces which media belong to the collection, in the given order.
   * Returns false, and writes nothing, when the collection is missing, an id is repeated, or a media row does not exist.
   * The same list sent twice leaves the same rows.
   */
  replaceCollectionMedia(collectionId: string, mediaIds: string[]): Promise<boolean>;
  /** Removes only one collection membership. Media, storage, derivatives, grants, and other memberships are untouched. */
  removeCollectionItem(input: { collectionId: string; mediaAssetId: string; actorId: string; now: Date }): Promise<"removed" | "already_absent" | "not_found" | "forbidden" | "conflict">;
  /**
   * Removes the collection and its membership rows.
   * Does not delete media files or remove those files from any other collection.
   * Returns false when the collection does not exist. Nothing else is written in that case.
   */
  deleteCollection(collectionId: string): Promise<boolean>;
  getGrants(collectionId: string): Promise<CollectionPermissionGrant[]>;
  createCollectionShareLink(input: CreateCollectionShareLinkInput): Promise<CreateCollectionShareLinkResult>;
  updateCollectionShareLink(input: UpdateCollectionShareLinkInput): Promise<UpdateCollectionShareLinkResult>;
  revokeCollectionShareLink(input: { id: string; collectionId: string; ownerId: string; now: Date }): Promise<RevokeCollectionShareLinkResult>;
  listCollectionShareLinksForOwner(collectionId: string, ownerId: string): Promise<CollectionShareLinkSummary[]>;
  getCollectionShareLinkByTokenHash(tokenHash: string): Promise<CollectionShareLinkRecord | null>;
  createCollectionAccessRequest(input: CreateCollectionAccessRequestInput): Promise<CreateCollectionAccessRequestResult>;
  listPendingCollectionAccessRequests(collectionId: string, ownerId: string): Promise<CollectionAccessRequestRecord[]>;
  listCollectionAccessRequestsForRequester(requesterId: string): Promise<CollectionAccessRequestRecord[]>;
  decideCollectionAccessRequest(input: DecideCollectionAccessRequestInput): Promise<DecideCollectionAccessRequestResult>;
  /** Revalidates owner policy and actor permissions under owner/collection locks; grant and audit commit together. */
  createOrUpdateCollectionGrant(input: CreateCollectionGrantInput): Promise<CollectionGrantMutationResult>;
  /** Revalidates current grant permissions under owner/collection locks; revoke and audit commit together. */
  revokeCollectionGrant(input: RevokeCollectionGrantInput): Promise<CollectionGrantMutationResult>;
  upsertGrant(grant: CollectionPermissionGrant): Promise<void>;

  getSocialAccount(accountId: string): Promise<SocialAccountRecord | null>;
  /** Changes repeat mode on a cycle this user owns. False when the cycle is missing or belongs to someone else. */
  updateCycleRepeat(cycleId: string, ownerId: string, repeatBehavior: "never" | "ask" | "automatic"): Promise<boolean>;
  /**
   * PublishingJob rows for cycles this user owns on this account, newest not guaranteed.
   * The token is not on these rows. A browser-supplied owner id is never accepted here.
   */
  listPublishingJobsForAccount(userId: string, socialAccountId: string): Promise<PublishingJobRecord[]>;
  listDuePublishingCandidates(now: Date, limit: number): Promise<DuePublishingCandidate[]>;
  listPublishingAttemptsForItem(ownerId: string, cycleId: string, cycleItemId: string): Promise<PublishingAttemptRecord[]>;
  listActivePublishingAttemptsForWorker(workerId: string, now: Date, limit: number): Promise<PublishingAttemptRecord[]>;
  listExpiredActivePublishingAttempts(now: Date, limit: number): Promise<{ jobId: string; ownerId: string }[]>;
  createOrGetPublishingAttempt(input: CreatePublishingAttemptInput): Promise<{ status: "created" | "existing" | "conflict"; job?: PublishingAttemptRecord }>;
  claimPublishingAttempt(input: ClaimPublishingAttemptInput): Promise<PublishingAttemptRecord | null>;
  heartbeatPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean>;
  transitionPublishingAttempt(input: PublishingAttemptUpdate): Promise<boolean>;
  markExpiredPublishingAttemptForReview(jobId: string, ownerId: string, now: Date): Promise<boolean>;
  cancelPublishingAttempt(jobId: string, ownerId: string, now: Date): Promise<boolean>;
  cancelClaimedPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date): Promise<boolean>;
  /**
   * Stores one Instagram connection for this user. The same external account is updated in place.
   * `encryptedAccessToken` is ciphertext. Callers must not pass a browser-supplied owner id.
   */
  saveInstagramConnection(connection: InstagramConnectionWrite): Promise<string>;
  /** Saves/reconnects an account while enforcing the user's current account cap under a per-user lock. */
  saveInstagramConnectionWithinLimit(connection: InstagramConnectionWrite, now: Date): Promise<{ status: "saved"; accountId: string } | { status: "limit" }>;
  /** Server-only token boundary. Ciphertext is never part of SocialAccountRecord or a client query. */
  getInstagramTokenCiphertext(userId: string, accountId: string): Promise<InstagramTokenCiphertext | null>;
  updateInstagramTokenCiphertext(userId: string, accountId: string, expectedCiphertext: string, encryptedAccessToken: string, tokenExpiresAt: Date): Promise<boolean>;
  /** Clears the token and marks the account disconnected. Does not delete cycles or media. False when it is not this user's account. */
  disconnectSocialAccount(userId: string, accountId: string): Promise<boolean>;
  getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number>;
  getRecentPublishTimes(userId: string, since: Date): Promise<Date[]>;

  /** Saved editing settings (never part of a media file). Newest first. Includes per-video rows; callers that show the template list must skip reserved names. */
  listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]>;
  /** Adds a template only if the owner would still have at most `limit` named templates. Per-video rows do not count. */
  createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean>;
  /** Inserts or replaces the one settings row for this owner and name. Not limited by the template cap. */
  saveVideoSettings(template: EditingTemplateRecord): Promise<void>;
  /** Atomically validates ownership, applies all per-video settings, and records one idempotent audit event. */
  applyVideoSettingsBatch(input: ApplyVideoSettingsBatchInput): Promise<ApplyVideoSettingsBatchResult>;
  listAuditsForEntities(entityType: string, entityIds: string[]): Promise<{ entityId: string; action: string; metadata: Record<string, unknown> | null }[]>;

  saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;

  /** A finished export. The storage key stays on the server. */
  findRenderOutput(ownerId: string, sourceMediaId: string, settingsHash: string): Promise<{ id: string; sizeBytes: number } | null>;
  countRenderOutputsSince(ownerId: string, since: Date): Promise<number>;
  /** Writes the export row only when it fits the storage quota. A matching hash returns the existing row. */
  saveRenderOutput(record: { id: string; sourceMediaId: string; ownerId: string; storageKey: string; sizeBytes: number; settingsHash: string; createdAt: Date }, limitBytes: number, fence?: RenderJobFence): Promise<SaveRenderResult>;
  listRenderOutputsForOwner(ownerId: string): Promise<RenderOutputRecord[]>;
  listRenderOutputsForOwnerAndSource(ownerId: string, sourceMediaId: string): Promise<RenderOutputRecord[]>;
  listRenderOutputPreviewsForOwner(ownerId: string, sourceMediaIds: string[]): Promise<RenderOutputPreviewRecord[]>;
  createRenderJob(job: RenderJobRecord): Promise<CreateRenderJobResult>;
  getRenderJobForOwner(id: string, ownerId: string): Promise<RenderJobRecord | null>;
  getRenderJobByIdempotencyKey(idempotencyKey: string, ownerId: string): Promise<RenderJobRecord | null>;
  listRenderJobsForOwner(ownerId: string): Promise<RenderJobRecord[]>;
  /** Atomically claims one queued or lease-expired render under the owner's concurrency limit. */
  claimNextRenderJob(claim: RenderJobClaim): Promise<RenderJobRecord | null>;
  heartbeatRenderJob(id: string, ownerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean>;
  updateRenderJobProgress(id: string, ownerId: string, lockToken: string, progressPercent: number): Promise<boolean>;
  completeRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, outputDerivativeId: string): Promise<boolean>;
  failRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, errorMessage: string): Promise<boolean>;
  cancelRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date): Promise<boolean>;
  /** Serving only. Includes the storage key, which must not be sent to a browser. */
  getRenderOutput(id: string): Promise<{ id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string } | null>;
  /** Inserts usage rows. A repeated idempotency key is ignored. */
  addUsageRecords(records: UsageRecordDraft[]): Promise<void>;
}
