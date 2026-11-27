// PostgreSQL persistence through Prisma. NOT RUN against a real database or the real Prisma Client (no network here):
// it passes the shared contract tests only against a fake that follows Prisma's documented behaviour.
// Security/concurrency rules it must keep:
//   - version-checked saves are ONE conditional UPDATE each (updateMany ... where id AND version) and report count === 1,
//   - cycle status moves are conditional updates (where status = from),
//   - the storage quota check and insert happen in one transaction that first locks the owner's user row,
//   - read methods select only what the screens need and page large lists.
// PROMOTION/BILLING LOCK ORDER: every transaction that can change a user's paid-period or promotional
// entitlement first locks that User row. Coupon reservation then locks Promotion; subscription and payment
// operations then touch Subscription/intent/payment rows; grant/redemption rows and lifecycle/audit rows
// are written afterward. Never acquire a User lock after locking one of these rows.
import { applySubscriptionEvent, effectivePlanId, type SubscriptionState, type SubscriptionStatus } from "../../lib/billing/subscription-state.ts";
import { getPlan, type PlanId } from "../../lib/billing/catalog.ts";
import { parseEditingSettings } from "../../lib/domain/editing-settings.ts";
import { randomUUID } from "node:crypto";
import type { CaptionRevision } from "../../lib/domain/caption-cover-updates.ts";
import type { MediaSort } from "../../lib/domain/media-list.ts";
import type { Capability, CollectionPermissionGrant, CycleItem, CycleStatus, MediaAsset, VideoCollection } from "../../lib/domain/types.ts";
import type { UsageRecordDraft } from "../../lib/domain/usage-accounting.ts";
import type { ApplyVideoSettingsBatchInput, AuditEntry, ClaimPublishingAttemptInput, CollectionAccessRequestRecord, CreateCollectionAccessRequestInput, CreatePublishingAttemptInput, CreateRenderJobResult, CycleRecord, DecideCollectionAccessRequestInput, EditingTemplateRecord, InstagramConnectionWrite, MediaCleanupJobRecord, PersistedCycleSchedule, PublishingAttemptRecord, PublishingJobRecord, PublishingAttemptUpdate, RazorpaySubscriptionEventInput, RazorpaySubscriptionEventResult, RenderJobClaim, RenderJobRecord, RenderOutputRecord, Repository, SaveRenderResult, SelectCycleItemRenderOutputInput, SocialAccountRecord, RazorpaySubscriptionIntentRecord, ReserveRazorpaySubscriptionIntentInput, RazorpayIntentStatus, ManualPaymentIntentRecord, ManualIntentStatus, SettleManualPaymentInput } from "../repository.ts";
import { cycleToRow, grantToRow, itemToMutableData, itemToRow, mediaToRow, rowToCollection, rowToCycle, rowToGrant, rowToItem, rowToMedia, rowToSocialAccount } from "./mappers.ts";
import { isUniqueViolation, type PrismaClientLike } from "./prisma-client-like.ts";
import { canTransitionPublishingAttempt, isActivePublishingAttempt, publishingOutcomeForStage, safePublishingError } from "../../lib/domain/publishing-attempt.ts";
import { buildPublishIdempotencyKey, isCycleFinished } from "../../lib/domain/cycle-state.ts";
import { decideSettledCycle, itemsEligibleForRepeat } from "../../lib/domain/publish-workflow.ts";
import { evaluateInstagramEligibility } from "../../lib/integrations/instagram-eligibility.ts";
import { accessPeriodEnd } from "../../lib/billing/access-period.ts";
import { resolveDeferredAccessState, resolveEffectiveEntitlement } from "../../lib/billing/entitlement-resolver.ts";
import { planGrantCreation, planGrantRevocation } from "../../lib/domain/sharing-management.ts";
import { mediaKeyFor, stagingKeyFor } from "../storage/media-storage.ts";
import { canAddVideoToCycle, canCreateAccessRequest, canImportVideo, decideAccessRequest, getCollectionCapabilities, validateShareLinkSettings } from "../../lib/domain/sharing-permissions.ts";
import { calculateDiscountAmounts, normalizePromotionCode, promotionRedemptionTransitionAllowed, samePromotionDefinition, validDiscountSnapshot, validPromotionEventMetadata, validPromotionRecord } from "../../lib/domain/promotions.ts";
import type { CreatePromotionRedemptionInput, CreatePromotionalAccessGrantInput, PromotionLifecycleEventInput, PromotionLifecycleEventRecord, PromotionRecord, PromotionRedemptionRecord, PromotionalAccessGrantRecord, RedeemFreeAccessCouponInput, RedeemFreeAccessCouponResult, ReserveDiscountedManualPaymentIntentInput, ReserveDiscountedManualPaymentIntentResult, UpdateDraftPromotionResult, TransitionCouponStatusResult } from "../repository.ts";
import type { ComplimentaryAccessAction, ComplimentaryAccessEventRecord, ComplimentaryAccessGrantRecord, ComplimentaryAccessState, ComplimentaryAccessTransitionResult } from "../repository.ts";
import type { CollectionGrantMutationResult, CollectionShareLinkRecord, CollectionShareLinkSummary, CreateCollectionGrantInput, CreateCollectionShareLinkInput, MediaImportClaim, MediaImportFinalizationInput, MediaImportJobRecord, MediaImportRequestInput, MediaImportVerificationInput, RevokeCollectionGrantInput, UpdateCollectionShareLinkInput } from "../repository.ts";
import type { EditedMediaReplacementRecord, EditedReplacementClaim, EditedReplacementCommitInput, EditedReplacementCommitResult, EditedReplacementFinalizeResult, EditedReplacementRequest, EditedReplacementMembership, MediaVerificationClaim, MediaVerificationJobRecord } from "../repository.ts";
import { mediaVerificationStateFromJob } from "../media-verification-state.ts";

function accessRequestFromRow(row: Record<string, unknown>): CollectionAccessRequestRecord {
  return { id: String(row["id"]), collectionId: String(row["collectionId"]), requesterId: String(row["requesterId"]), requestedCapabilities: Array.isArray(row["requestedCapabilities"]) ? row["requestedCapabilities"] as CollectionAccessRequestRecord["requestedCapabilities"] : [], status: row["status"] as CollectionAccessRequestRecord["status"], decidedById: row["decidedById"] as string | null ?? null, decidedAt: row["decidedAt"] as Date | null ?? null, createdAt: row["createdAt"] as Date };
}

function shareLinkFromRow(row: Record<string, unknown>): CollectionShareLinkRecord {
  return { id: String(row["id"]), collectionId: String(row["collectionId"]), tokenHash: String(row["tokenHash"]), capabilities: Array.isArray(row["capabilities"]) ? row["capabilities"] as Capability[] : [], expiresAt: row["expiresAt"] as Date | null ?? null, revokedAt: row["revokedAt"] as Date | null ?? null, createdById: String(row["createdById"]), createdAt: row["createdAt"] as Date };
}
function shareLinkSummary(link: CollectionShareLinkRecord): CollectionShareLinkSummary {
  const { tokenHash: _tokenHash, ...summary } = link;
  return summary;
}

function mediaVerificationJobFromRow(row: Record<string, unknown>): MediaVerificationJobRecord {
  return { id: String(row["id"]), ownerId: String(row["ownerId"]), mediaAssetId: String(row["mediaAssetId"]), status: row["status"] as MediaVerificationJobRecord["status"], progressPercent: Number(row["progressPercent"] ?? 0), attempts: Number(row["attempts"] ?? 0), idempotencyKey: String(row["idempotencyKey"]), lockedBy: row["lockedBy"] as string | null ?? null, lockToken: row["lockToken"] as string | null ?? null, lockExpiresAt: row["lockExpiresAt"] as Date | null ?? null, errorMessage: row["errorMessage"] as string | null ?? null, createdAt: row["createdAt"] as Date, finishedAt: row["finishedAt"] as Date | null ?? null, payload: row["payload"] ?? null };
}

function editedReplacementFromRow(row: Record<string, unknown>): EditedMediaReplacementRecord {
  const memberships = Array.isArray(row["membershipSnapshot"]) ? row["membershipSnapshot"] as Record<string, unknown>[] : [];
  return {
    id: String(row["id"]), ownerId: String(row["ownerId"]), sourceMediaAssetId: String(row["sourceMediaAssetId"]), sourceDerivativeId: String(row["sourceDerivativeId"]),
    plannedReplacementMediaAssetId: String(row["plannedReplacementMediaAssetId"]), replacementMediaAssetId: row["replacementMediaAssetId"] as string | null ?? null,
    stagingObjectKey: row["stagingObjectKey"] as string | null ?? null, status: row["status"] as EditedMediaReplacementRecord["status"], idempotencyKey: String(row["idempotencyKey"]),
    membershipSnapshot: memberships.map((item) => ({ id: String(item["id"]), collectionId: String(item["collectionId"]), version: Number(item["version"]) })),
    attempts: Number(row["attempts"] ?? 0), lockedBy: row["lockedBy"] as string | null ?? null, lockToken: row["lockToken"] as string | null ?? null,
    lockExpiresAt: row["lockExpiresAt"] as Date | null ?? null, errorCode: row["errorCode"] as string | null ?? null,
    createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date, completedAt: row["completedAt"] as Date | null ?? null,
  };
}

function mediaCleanupJobFromRow(row: Record<string, unknown>): MediaCleanupJobRecord {
  return { id: String(row["id"]), ownerId: String(row["ownerId"]), mediaAssetId: String(row["mediaAssetId"]), status: row["status"] as MediaCleanupJobRecord["status"], attempts: Number(row["attempts"] ?? 0), lockToken: row["lockToken"] as string | null ?? null, lockExpiresAt: row["lockExpiresAt"] as Date | null ?? null, createdAt: row["createdAt"] as Date };
}

function publishingAttemptFromRow(row: Record<string, unknown>): PublishingAttemptRecord {
  return { id: String(row["id"]), ownerId: String(row["ownerId"]), cycleId: String(row["cycleId"]), cycleItemId: String(row["cycleItemId"]), socialAccountId: String(row["socialAccountId"]), attemptNumber: Number(row["attemptNumber"]), idempotencyKey: String(row["idempotencyKey"]), stage: row["stage"] as PublishingAttemptRecord["stage"], outcome: row["outcome"] as PublishingAttemptRecord["outcome"], workerId: row["workerId"] as string | null, lockToken: row["lockToken"] as string | null, leaseExpiresAt: row["leaseExpiresAt"] as Date | null, containerId: row["containerId"] as string | null, instagramMediaId: row["instagramMediaId"] as string | null, errorCategory: row["errorCategory"] as string | null, errorDetails: row["errorDetails"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date, startedAt: row["startedAt"] as Date, finishedAt: row["finishedAt"] as Date | null };
}

function mediaImportJobFromRow(row: Record<string, unknown>): MediaImportJobRecord {
  return {
    id: String(row["id"]), importerId: String(row["importerId"]), sourceMediaId: String(row["sourceMediaId"]),
    sourceCollectionId: String(row["sourceCollectionId"]), status: row["status"] as MediaImportJobRecord["status"],
    idempotencyKey: String(row["idempotencyKey"]), newObjectKey: String(row["newObjectKey"]),
    stagingObjectKey: row["stagingObjectKey"] as string | null ?? null, attemptStorageKeys: Array.isArray(row["attemptStorageKeys"]) ? row["attemptStorageKeys"] as string[] : [],
    resultMediaAssetId: String(row["resultMediaAssetId"]), failureReason: row["failureReason"] as string | null ?? null,
    attempts: Number(row["attempts"] ?? 0), lockedBy: row["lockedBy"] as string | null ?? null,
    lockToken: row["lockToken"] as string | null ?? null, leaseExpiresAt: row["leaseExpiresAt"] as Date | null ?? null,
    createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date,
  };
}

const lockedUsers = async (tx: PrismaClientLike, ids: string[]): Promise<boolean> => {
  const unique = [...new Set(ids)].sort();
  // For two-user operations use individual locks in sorted order: PostgreSQL lock order is explicit and stable.
  if (unique.length > 0) {
    for (const id of unique) {
      const one = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
      if (!Array.isArray(one) || one.length !== 1) return false;
    }
  }
  return true;
};

/** Locks cover targets in a stable order and accepts only active media owned by the resource owner. */
const lockActiveOwnedMediaRows = async (tx: PrismaClientLike, ownerId: string, mediaIds: string[]): Promise<Set<string>> => {
  const lockedIds = new Set<string>();
  for (const mediaId of [...new Set(mediaIds)].sort()) {
    const locked = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${mediaId} AND "ownerId" = ${ownerId} AND "status" = 'active' FOR UPDATE`;
    if (Array.isArray(locked) && locked.length === 1) lockedIds.add(mediaId);
  }
  return lockedIds;
};

const ACTIVE_CYCLE_STATUSES = ["draft", "running", "paused"];
const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : typeof value === "object" && value !== null ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}` : JSON.stringify(value) ?? "undefined";

function renderJobFromRow(row: Record<string, unknown>): RenderJobRecord {
  return {
    id: row["id"] as string, ownerId: row["ownerId"] as string, kind: "render", status: row["status"] as RenderJobRecord["status"],
    cycleItemId: row["cycleItemId"] as string | null, mediaAssetId: row["mediaAssetId"] as string | null,
    progressPercent: row["progressPercent"] as number, attempts: row["attempts"] as number, idempotencyKey: row["idempotencyKey"] as string,
    lockedBy: row["lockedBy"] as string | null, lockExpiresAt: row["lockExpiresAt"] as Date | null, errorMessage: row["errorMessage"] as string | null,
    createdAt: row["createdAt"] as Date, finishedAt: row["finishedAt"] as Date | null, settingsHash: row["settingsHash"] as string | null,
    payload: row["payload"] ?? null, pendingOutputId: row["pendingOutputId"] as string | null, outputDerivativeId: row["outputDerivativeId"] as string | null,
    lockToken: row["lockToken"] as string | null, ffmpegPid: row["ffmpegPid"] as number | null, ffmpegStartedAt: row["ffmpegStartedAt"] as Date | null,
  };
}

function renderJobToRow(job: RenderJobRecord): Record<string, unknown> {
  return { ...job };
}

function promotionEventMatchesRow(row: Record<string, unknown>, input: PromotionLifecycleEventInput): boolean {
  const expectedMetadata = validPromotionEventMetadata(input.metadata);
  const occurredAt = row["occurredAt"] instanceof Date ? row["occurredAt"].getTime() : NaN;
  const actualMetadata = row["metadata"] && typeof row["metadata"] === "object" && !Array.isArray(row["metadata"]) ? row["metadata"] as Record<string, unknown> : null;
  const stable = (metadata: Record<string, unknown> | null): string => JSON.stringify(metadata ? Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))) : null);
  const redemptionId = input.redemptionId ?? null;
  const grantId = input.accessGrantId ?? null;
  const subjectUserId = input.subjectUserId ?? null;
  return row["eventKey"] === input.eventKey && row["promotionId"] === input.promotionId && row["eventType"] === input.eventType && row["subjectUserId"] === subjectUserId &&
    row["actorUserId"] === (input.actorUserId ?? null) && row["redemptionId"] === redemptionId && row["redemptionUserId"] === (redemptionId ? subjectUserId : null) && row["redemptionPromotionId"] === (redemptionId ? input.promotionId : null) &&
    row["accessGrantId"] === grantId && row["accessGrantUserId"] === (grantId ? subjectUserId : null) && row["accessGrantPromotionId"] === (grantId ? input.promotionId : null) &&
    row["outcome"] === (input.outcome ?? null) && occurredAt === input.occurredAt.getTime() && stable(actualMetadata) === stable(expectedMetadata);
}

/** Only a missing promotion table/column permits paid-only compatibility. All other failures fail closed. */
function isPromotionSchemaUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { table?: unknown; column?: unknown; modelName?: unknown } };
  if (candidate.code !== "P2021" && candidate.code !== "P2022") return false;
  const target = `${String(candidate.meta?.table ?? "")} ${String(candidate.meta?.column ?? "")} ${String(candidate.meta?.modelName ?? "")}`.toLowerCase();
  return target.includes("promotion") || target.includes("promotionalaccessgrant");
}

export class PrismaRepository implements Repository {
  private db: PrismaClientLike; private now: () => Date;
  constructor(db: PrismaClientLike, now: () => Date = () => new Date()) { this.db = db; this.now = now; }

  private promotionFromRow(row: Record<string, unknown>): PromotionRecord {
    return { id: String(row["id"]), type: row["type"] as PromotionRecord["type"], status: row["status"] as PromotionRecord["status"], code: row["code"] as string | null,
      discountType: row["discountType"] as PromotionRecord["discountType"], discountValue: row["discountValue"] as number | null, accessPlanId: row["accessPlanId"] as PlanId | null,
      durationDays: row["durationDays"] as number | null, eligiblePlanIds: Array.isArray(row["eligiblePlanIds"]) ? row["eligiblePlanIds"] as PlanId[] : [], targetUserId: row["targetUserId"] as string | null,
      startsAt: row["startsAt"] as Date, expiresAt: row["expiresAt"] as Date | null, usageLimit: row["usageLimit"] as number | null, createdByAdminId: String(row["createdByAdminId"]),
      reason: row["reason"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  private promotionRedemptionFromRow(row: Record<string, unknown>): PromotionRedemptionRecord {
    return { id: String(row["id"]), promotionId: String(row["promotionId"]), userId: String(row["userId"]), status: row["status"] as PromotionRedemptionRecord["status"], idempotencyKey: String(row["idempotencyKey"]),
      planId: row["planId"] as PlanId | null, interval: row["interval"] as PromotionRedemptionRecord["interval"], listPricePaise: row["listPricePaise"] as number | null, discountPaise: row["discountPaise"] as number | null,
      payablePaise: row["payablePaise"] as number | null, currency: row["currency"] as "INR" | null, manualPaymentIntentId: row["manualPaymentIntentId"] as string | null,
      manualPaymentIntentUserId: row["manualPaymentIntentUserId"] as string | null, reservedAt: row["reservedAt"] as Date, redeemedAt: row["redeemedAt"] as Date | null,
      releasedAt: row["releasedAt"] as Date | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  private promotionalGrantFromRow(row: Record<string, unknown>): PromotionalAccessGrantRecord {
    return { id: String(row["id"]), promotionId: String(row["promotionId"]), userId: String(row["userId"]), redemptionId: row["redemptionId"] as string | null,
      kind: row["kind"] as PromotionalAccessGrantRecord["kind"], activationPolicy: row["activationPolicy"] as PromotionalAccessGrantRecord["activationPolicy"], status: row["status"] as PromotionalAccessGrantRecord["status"],
      planId: row["planId"] as PromotionalAccessGrantRecord["planId"], durationDays: Number(row["durationDays"]), queueSequence: BigInt(row["queueSequence"] as bigint | number | string),
      startsAt: row["startsAt"] as Date | null, expiresAt: row["expiresAt"] as Date | null, activatedAt: row["activatedAt"] as Date | null, revokedAt: row["revokedAt"] as Date | null,
      grantedByAdminId: row["grantedByAdminId"] as string | null, reason: row["reason"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  private promotionEventFromRow(row: Record<string, unknown>): PromotionLifecycleEventRecord {
    const metadata = row["metadata"];
    return { id: String(row["id"]), eventKey: String(row["eventKey"]), eventType: row["eventType"] as PromotionLifecycleEventRecord["eventType"], promotionId: String(row["promotionId"]),
      subjectUserId: row["subjectUserId"] as string | null, actorUserId: row["actorUserId"] as string | null, redemptionId: row["redemptionId"] as string | null,
      accessGrantId: row["accessGrantId"] as string | null, occurredAt: row["occurredAt"] as Date, outcome: row["outcome"] as string | null,
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as PromotionLifecycleEventRecord["metadata"] : null };
  }
  private async insertPromotionEvent(tx: PrismaClientLike, input: PromotionLifecycleEventInput): Promise<void> {
    const metadata = validPromotionEventMetadata(input.metadata);
    if (input.metadata && !metadata) throw new Error("Invalid promotion event metadata");
    const redemption = input.redemptionId ? await tx.promotionRedemption.findUnique({ where: { id: input.redemptionId } }) : null;
    const grant = input.accessGrantId ? await tx.promotionalAccessGrant.findUnique({ where: { id: input.accessGrantId } }) : null;
    if (input.redemptionId && (!redemption || redemption["promotionId"] !== input.promotionId || redemption["userId"] !== input.subjectUserId)) throw new Error("Promotion event redemption relationship mismatch");
    if (input.accessGrantId && (!grant || grant["promotionId"] !== input.promotionId || grant["userId"] !== input.subjectUserId)) throw new Error("Promotion event grant relationship mismatch");
    if (input.actorUserId) {
      const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
      if (actor?.["role"] !== "admin") throw new Error("Promotion event actor is not an administrator");
    }
    if (input.subjectUserId && !await tx.user.findUnique({ where: { id: input.subjectUserId }, select: { id: true } })) throw new Error("Promotion event subject is missing");
    await tx.promotionLifecycleEvent.create({ data: { eventKey: input.eventKey, eventType: input.eventType, promotionId: input.promotionId, subjectUserId: input.subjectUserId ?? null,
      actorUserId: input.actorUserId ?? null, redemptionId: redemption ? input.redemptionId : null, redemptionUserId: redemption ? redemption["userId"] : null,
      redemptionPromotionId: redemption ? redemption["promotionId"] : null, accessGrantId: grant ? input.accessGrantId : null, accessGrantUserId: grant ? grant["userId"] : null,
      accessGrantPromotionId: grant ? grant["promotionId"] : null, occurredAt: input.occurredAt, outcome: input.outcome ?? null, metadata } });
    const entityType = input.accessGrantId ? "PromotionalAccessGrant" : input.redemptionId ? "PromotionRedemption" : "Promotion";
    const entityId = input.accessGrantId ?? input.redemptionId ?? input.promotionId;
    await tx.auditLog.create({ data: { actorId: input.actorUserId ?? null, action: `promotion.${input.eventType}`, entityType, entityId,
      metadata: { eventKey: input.eventKey, outcome: input.outcome ?? null, ...(metadata ?? {}) } } });
  }
  private async hasPaidAccessForPromotion(tx: PrismaClientLike, userId: string, now: Date): Promise<boolean> {
    const [manualRows, row] = await Promise.all([
      tx.manualPlanAccess.findMany({ where: { userId }, select: { planId: true, startsAt: true, expiresAt: true } }),
      tx.subscription.findUnique({ where: { userId }, select: { planId: true, status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, razorpaySubscriptionId: true } }),
    ]);
    const [capturedPayment, failedPayment] = row?.["razorpaySubscriptionId"] ? await Promise.all([
      tx.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "captured" }, select: { id: true } }),
      tx.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "failed" }, select: { id: true } }),
    ]) : [null, null];
    const hasCapturedPayment = Boolean(capturedPayment);
    const hasFailedPayment = Boolean(failedPayment);
    return resolveDeferredAccessState({
      now,
      subscription: row ? { planId: String(row["planId"]), status: row["status"] as SubscriptionStatus, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]), currentPeriodEnd: row["currentPeriodEnd"] instanceof Date ? row["currentPeriodEnd"] : null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, hasCapturedPayment, hasFailedPayment } : null,
      manualAccess: manualRows.map((access) => ({ planId: String(access["planId"]), startsAt: access["startsAt"] as Date, expiresAt: access["expiresAt"] as Date })),
    }) !== "ended";
  }

  async createPromotion(record: PromotionRecord): Promise<boolean> {
    if (!validPromotionRecord(record) || (record.code && normalizePromotionCode(record.code) !== record.code)) return false;
    try {
      return await this.db.$transaction(async (tx) => {
        const actor = await tx.user.findUnique({ where: { id: record.createdByAdminId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return false;
        if (record.targetUserId && !await tx.user.findUnique({ where: { id: record.targetUserId }, select: { id: true } })) return false;
        const existing = await tx.promotion.findUnique({ where: { id: record.id } });
        if (existing) return samePromotionDefinition(this.promotionFromRow(existing), record);
        await tx.promotion.create({ data: { ...record } });
        await this.insertPromotionEvent(tx, { id: `event-${record.id}`, eventKey: `promotion:${record.id}:created`, eventType: "promotion_created", promotionId: record.id, subjectUserId: record.targetUserId, actorUserId: record.createdByAdminId, occurredAt: record.createdAt, metadata: { reason: record.reason, status: record.status } });
        return true;
      });
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; }
  }
  async updateDraftPromotion(input: { record: PromotionRecord; expectedUpdatedAt: Date; actorUserId: string }): Promise<UpdateDraftPromotionResult> {
    const { record, expectedUpdatedAt, actorUserId } = input;
    if (!Number.isFinite(expectedUpdatedAt.getTime()) || !validPromotionRecord(record) || (record.code && normalizePromotionCode(record.code) !== record.code)) return { status: "conflict" };
    const auditWriteFailure = Symbol("promotion update audit write failed");
    try {
      return await this.db.$transaction(async (tx) => {
        const actorLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorUserId} FOR UPDATE`;
        if (!Array.isArray(actorLock) || actorLock.length === 0) return { status: "conflict" };
        const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return { status: "conflict" };
        const currentRow = await tx.promotion.findUnique({ where: { id: record.id } });
        if (!currentRow) return { status: "missing" };
        const current = this.promotionFromRow(currentRow);
        if (current.status !== "draft") return { status: "not_draft" };
        if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { status: "stale" };
        if ((current.type !== "discount_coupon" && current.type !== "free_access_coupon") || record.type !== current.type || record.id !== current.id || record.status !== "draft" || record.createdByAdminId !== current.createdByAdminId || record.createdAt.getTime() !== current.createdAt.getTime()) return { status: "conflict" };
        if (record.targetUserId !== null && !await tx.user.findUnique({ where: { id: record.targetUserId }, select: { id: true } })) return { status: "target_user_missing" };
        const [redemptionCount, grantCount] = await Promise.all([
          tx.promotionRedemption.count({ where: { promotionId: record.id } }),
          tx.promotionalAccessGrant.count({ where: { promotionId: record.id } }),
        ]);
        if (redemptionCount > 0 || grantCount > 0) return { status: "history" };
        if (record.code !== null) {
          const duplicateCode = await tx.promotion.findUnique({ where: { code: record.code }, select: { id: true } });
          if (duplicateCode && duplicateCode["id"] !== record.id) return { status: "duplicate_code" };
        }
        // updatedAt is a millisecond-precision compare-and-swap token. Force strict monotonicity
        // so rapid concurrent edits cannot reuse an ETag even when the wall clock has not ticked.
        const updatedAt = new Date(Math.max(record.updatedAt.getTime(), expectedUpdatedAt.getTime() + 1));
        const changed = await tx.promotion.updateMany({
          where: { id: record.id, status: "draft", updatedAt: expectedUpdatedAt },
          data: {
            type: record.type, code: record.code, discountType: record.discountType, discountValue: record.discountValue,
            accessPlanId: record.accessPlanId, durationDays: record.durationDays, eligiblePlanIds: record.eligiblePlanIds,
            targetUserId: record.targetUserId, startsAt: record.startsAt, expiresAt: record.expiresAt,
            usageLimit: record.usageLimit, reason: record.reason, updatedAt,
          },
        });
        if (changed.count !== 1) return { status: "stale" };
        try {
          await this.insertPromotionEvent(tx, {
            id: `event-${record.id}-updated-${updatedAt.getTime()}`, eventKey: `promotion:${record.id}:updated:${updatedAt.getTime()}`,
            eventType: "promotion_updated", promotionId: record.id, actorUserId, occurredAt: updatedAt,
            metadata: { status: "draft", source: "admin_draft_edit", reason: record.reason, reasonOld: current.reason, reasonNew: record.reason },
          });
        } catch { throw auditWriteFailure; }
        const updatedRow = await tx.promotion.findUnique({ where: { id: record.id } });
        return updatedRow ? { status: "updated", promotion: this.promotionFromRow(updatedRow) } : { status: "conflict" };
      });
    } catch (error) {
      if (error === auditWriteFailure) return { status: "conflict" };
      if (isUniqueViolation(error)) return { status: "duplicate_code" };
      throw error;
    }
  }
  async updatePromotionReason(input: { id: string; reason: string | null; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<import("../repository.ts").UpdatePromotionReasonResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.actorUserId) || !Number.isFinite(input.expectedUpdatedAt.getTime()) || !Number.isFinite(input.now.getTime()) || (input.reason !== null && (typeof input.reason !== "string" || input.reason.length > 500))) return { status: "conflict" };
    const auditWriteFailure = Symbol("promotion reason audit write failed");
    try {
      return await this.db.$transaction(async (tx) => {
        // All promotion mutations follow User first, Promotion second.
        const actorLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.actorUserId} FOR UPDATE`;
        if (!Array.isArray(actorLock) || actorLock.length === 0) return { status: "conflict" };
        const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return { status: "conflict" };
        const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${input.id} FOR UPDATE`;
        if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return { status: "missing" };
        const currentRow = await tx.promotion.findUnique({ where: { id: input.id } });
        if (!currentRow) return { status: "missing" };
        const current = this.promotionFromRow(currentRow);
        if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return { status: "stale" };
        const updatedAt = new Date(Math.max(input.now.getTime(), input.expectedUpdatedAt.getTime() + 1));
        const changed = await tx.promotion.updateMany({ where: { id: input.id, updatedAt: input.expectedUpdatedAt }, data: { reason: input.reason, updatedAt } });
        if (changed.count !== 1) return { status: "stale" };
        try {
          await this.insertPromotionEvent(tx, { id: `event-${input.id}-reason-${updatedAt.getTime()}`, eventKey: `promotion:${input.id}:reason:${updatedAt.getTime()}`, eventType: "promotion_updated", promotionId: input.id, actorUserId: input.actorUserId, occurredAt: updatedAt, metadata: { source: "admin_reason_update", status: current.status, reasonOld: current.reason, reasonNew: input.reason } });
        } catch { throw auditWriteFailure; }
        const updatedRow = await tx.promotion.findUnique({ where: { id: input.id } });
        return updatedRow ? { status: "updated", promotion: this.promotionFromRow(updatedRow) } : { status: "conflict" };
      });
    } catch (error) {
      if (error === auditWriteFailure) return { status: "conflict" };
      throw error;
    }
  }
  async transitionCouponStatus(input: { id: string; expectedStatus: "draft" | "active"; nextStatus: "active" | "paused"; expectedUpdatedAt: Date; actorUserId: string; now: Date }): Promise<TransitionCouponStatusResult> {
    if (!Number.isFinite(input.expectedUpdatedAt.getTime()) || !Number.isFinite(input.now.getTime()) || !((input.expectedStatus === "draft" && input.nextStatus === "active") || (input.expectedStatus === "active" && input.nextStatus === "paused"))) return { status: "conflict" };
    const auditWriteFailure = Symbol("coupon status audit write failed");
    try {
      return await this.db.$transaction(async (tx) => {
        const actorLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.actorUserId} FOR UPDATE`;
        if (!Array.isArray(actorLock) || actorLock.length === 0) return { status: "conflict" };
        const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return { status: "conflict" };
        const row = await tx.promotion.findUnique({ where: { id: input.id } });
        if (!row) return { status: "missing" };
        const current = this.promotionFromRow(row);
        if (current.type !== "discount_coupon" && current.type !== "free_access_coupon") return { status: "not_coupon" };
        if (current.status !== input.expectedStatus) return { status: "invalid_status" };
        if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) return { status: "stale" };
        const updatedAt = new Date(Math.max(input.now.getTime(), input.expectedUpdatedAt.getTime() + 1));
        const changed = await tx.promotion.updateMany({
          where: { id: input.id, status: input.expectedStatus, updatedAt: input.expectedUpdatedAt },
          data: { status: input.nextStatus, updatedAt },
        });
        if (changed.count !== 1) return { status: "stale" };
        const eventType = input.nextStatus === "paused" ? "promotion_paused" as const : "promotion_updated" as const;
        const action = input.nextStatus === "paused" ? "deactivated" : "activated";
        try {
          await this.insertPromotionEvent(tx, {
            id: `event-${input.id}-${action}-${updatedAt.getTime()}`, eventKey: `promotion:${input.id}:${action}:${updatedAt.getTime()}`,
            eventType, promotionId: input.id, actorUserId: input.actorUserId, occurredAt: updatedAt,
            metadata: { status: input.nextStatus, source: `admin_coupon_${action}` },
          });
        } catch { throw auditWriteFailure; }
        const updatedRow = await tx.promotion.findUnique({ where: { id: input.id } });
        return updatedRow ? { status: "updated", promotion: this.promotionFromRow(updatedRow) } : { status: "conflict" };
      });
    } catch (error) {
      if (error === auditWriteFailure) return { status: "conflict" };
      throw error;
    }
  }
  async listPromotions(query: { skip: number; take: number; search?: string; type?: "discount_coupon" | "free_access_coupon"; status?: PromotionRecord["status"] }): Promise<{ items: PromotionRecord[]; total: number }> {
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const select = { id: true, type: true, status: true, code: true, discountType: true, discountValue: true, accessPlanId: true, durationDays: true, eligiblePlanIds: true, targetUserId: true, startsAt: true, expiresAt: true, usageLimit: true, createdByAdminId: true, reason: true, createdAt: true, updatedAt: true };
    const where = {
      type: query.type ?? { in: ["discount_coupon", "free_access_coupon"] },
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { code: { contains: query.search, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.promotion.findMany({ where, select, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], skip: query.skip, take: query.take }),
      this.db.promotion.count({ where }),
    ]);
    return { items: rows.map((row) => this.promotionFromRow(row)), total };
  }
  async getPromotionUsageCounts(promotionIds: string[]) {
    const ids = [...new Set(promotionIds)].slice(0, 100);
    const result: Record<string, { reserved: number; redeemed: number; released: number; manualReview: number }> = {};
    for (const id of ids) result[id] = { reserved: 0, redeemed: 0, released: 0, manualReview: 0 };
    if (ids.length === 0) return result;
    const rows = await this.db.promotionRedemption.groupBy({ by: ["promotionId", "status"], where: { promotionId: { in: ids } }, _count: { _all: true } });
    for (const row of rows) {
      const counts = result[String(row["promotionId"])];
      if (!counts) continue;
      const count = Number((row["_count"] as Record<string, unknown> | undefined)?.["_all"]);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Admin promotion usage count was invalid.");
      if (row["status"] === "reserved") counts.reserved = count;
      else if (row["status"] === "redeemed") counts.redeemed = count;
      else if (row["status"] === "released") counts.released = count;
      else if (row["status"] === "manual_review") counts.manualReview = count;
    }
    return result;
  }
  async listPromotionRedemptionHistory(promotionId: string, query: { skip: number; take: number }) {
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const where = { promotionId };
    const select = { id: true, userId: true, status: true, planId: true, interval: true, listPricePaise: true, discountPaise: true, payablePaise: true, currency: true, createdAt: true, updatedAt: true };
    const [rows, total] = await Promise.all([
      this.db.promotionRedemption.findMany({ where, select, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: query.skip, take: query.take }),
      this.db.promotionRedemption.count({ where }),
    ]);
    return { items: rows.map((row) => ({ id: String(row["id"]), userId: String(row["userId"]), status: row["status"] as PromotionRedemptionRecord["status"], planId: row["planId"] as PlanId | null, interval: row["interval"] as PromotionRedemptionRecord["interval"], listPricePaise: row["listPricePaise"] as number | null, discountPaise: row["discountPaise"] as number | null, payablePaise: row["payablePaise"] as number | null, currency: row["currency"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date })), total };
  }
  async listPromotionLifecycleHistory(promotionId: string, query: { skip: number; take: number }) {
    if (!Number.isSafeInteger(query.skip) || query.skip < 0 || !Number.isSafeInteger(query.take) || query.take < 1 || query.take > 100) return { items: [], total: 0 };
    const where = { promotionId };
    const select = { id: true, eventKey: true, eventType: true, subjectUserId: true, actorUserId: true, redemptionId: true, accessGrantId: true, occurredAt: true, outcome: true };
    const [rows, total] = await Promise.all([
      this.db.promotionLifecycleEvent.findMany({ where, select, orderBy: [{ occurredAt: "desc" }, { id: "asc" }], skip: query.skip, take: query.take }),
      this.db.promotionLifecycleEvent.count({ where }),
    ]);
    const auditClauses = rows.map((row) => {
      const entityType = row["accessGrantId"] ? "PromotionalAccessGrant" : row["redemptionId"] ? "PromotionRedemption" : "Promotion";
      const entityId = row["accessGrantId"] ?? row["redemptionId"] ?? promotionId;
      return { entityType, entityId, action: `promotion.${String(row["eventType"])}`, metadata: { path: ["eventKey"], equals: String(row["eventKey"]) } };
    });
    const auditRows = auditClauses.length ? await this.db.auditLog.findMany({ where: { OR: auditClauses }, select: { id: true, metadata: true } }) : [];
    const auditIdByEventKey = new Map<string, string>();
    for (const audit of auditRows) {
      const metadata = audit["metadata"];
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof (metadata as Record<string, unknown>)["eventKey"] === "string") auditIdByEventKey.set(String((metadata as Record<string, unknown>)["eventKey"]), String(audit["id"]));
    }
    return { items: rows.map((row) => ({ id: String(row["id"]), eventType: row["eventType"] as PromotionLifecycleEventRecord["eventType"], subjectUserId: row["subjectUserId"] as string | null, actorUserId: row["actorUserId"] as string | null, redemptionId: row["redemptionId"] as string | null, accessGrantId: row["accessGrantId"] as string | null, occurredAt: row["occurredAt"] as Date, outcome: row["outcome"] as string | null, auditId: auditIdByEventKey.get(String(row["eventKey"])) ?? null })), total };
  }
  async getUserPromotionRedemptionStatus(userId: string, redemptionId: string) {
    const row = await this.db.promotionRedemption.findFirst({ where: { id: redemptionId, userId }, select: { id: true, promotionId: true, userId: true, status: true, planId: true, interval: true, listPricePaise: true, discountPaise: true, payablePaise: true, currency: true, manualPaymentIntentId: true, manualPaymentIntentUserId: true, redeemedAt: true, createdAt: true, updatedAt: true } });
    if (!row) return null;
    const [promotion, intent, grantRow] = await Promise.all([
      this.db.promotion.findUnique({ where: { id: row["promotionId"] }, select: { type: true, status: true, startsAt: true, expiresAt: true } }),
      typeof row["manualPaymentIntentId"] === "string" ? this.db.manualPaymentIntent.findFirst({ where: { id: row["manualPaymentIntentId"], userId }, select: { id: true, userId: true, status: true, accessStartsAt: true, accessEndsAt: true } }) : Promise.resolve(null),
      this.db.promotionalAccessGrant.findFirst({ where: { redemptionId }, select: { id: true, promotionId: true, userId: true, kind: true, status: true, planId: true, startsAt: true, expiresAt: true } }),
    ]);
    if (!promotion || (promotion["type"] !== "discount_coupon" && promotion["type"] !== "free_access_coupon")) return null;
    if (row["currency"] !== null && row["currency"] !== "INR") return null;
    const hasIntentLink = typeof row["manualPaymentIntentId"] === "string";
    if (hasIntentLink && (row["manualPaymentIntentUserId"] !== userId || !intent || intent["userId"] !== userId)) return null;
    if (!hasIntentLink && (row["manualPaymentIntentUserId"] !== null || promotion["type"] === "discount_coupon")) return null;
    if (grantRow && (grantRow["userId"] !== userId || grantRow["promotionId"] !== row["promotionId"] || grantRow["kind"] !== "free_access_coupon")) return null;
    if (promotion["type"] === "discount_coupon" && grantRow) return null;
    if (promotion["type"] === "free_access_coupon" && (!grantRow || row["status"] !== "redeemed")) return null;
    return {
      redemption: { id: String(row["id"]), promotionId: String(row["promotionId"]), userId: String(row["userId"]), status: row["status"] as PromotionRedemptionRecord["status"], planId: row["planId"] as PlanId | null, interval: row["interval"] as PromotionRedemptionRecord["interval"], listPricePaise: row["listPricePaise"] as number | null, discountPaise: row["discountPaise"] as number | null, payablePaise: row["payablePaise"] as number | null, currency: row["currency"] as "INR" | null, redeemedAt: row["redeemedAt"] as Date | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date },
      coupon: { status: promotion["status"] as PromotionRecord["status"], startsAt: promotion["startsAt"] as Date, expiresAt: promotion["expiresAt"] as Date | null },
      manualPayment: intent ? { id: String(intent["id"]), status: intent["status"] as ManualPaymentIntentRecord["status"], accessStartsAt: intent["accessStartsAt"] as Date | null, accessEndsAt: intent["accessEndsAt"] as Date | null } : null,
      grant: grantRow ? { id: String(grantRow["id"]), status: grantRow["status"] as PromotionalAccessGrantRecord["status"], planId: grantRow["planId"] as Exclude<PlanId, "free">, startsAt: grantRow["startsAt"] as Date | null, expiresAt: grantRow["expiresAt"] as Date | null } : null,
    };
  }
  async getPromotion(id: string): Promise<PromotionRecord | null> { const row = await this.db.promotion.findUnique({ where: { id } }); return row ? this.promotionFromRow(row) : null; }
  async getPromotionByCode(code: string): Promise<PromotionRecord | null> {
    const normalized = normalizePromotionCode(code);
    if (!/^[A-Z0-9_-]{3,64}$/.test(normalized)) return null;
    const row = await this.db.promotion.findUnique({ where: { code: normalized } }); return row ? this.promotionFromRow(row) : null;
  }
  async createOrGetPromotionRedemption(input: CreatePromotionRedemptionInput): Promise<{ status: "created" | "existing" | "conflict"; redemption?: PromotionRedemptionRecord }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !input.idempotencyKey || input.idempotencyKey.length > 128 || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    try {
      return await this.db.$transaction(async (tx) => {
        const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!Array.isArray(lockedUser) || lockedUser.length === 0) return { status: "conflict" as const };
        const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${input.promotionId} FOR UPDATE`;
        if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return { status: "conflict" as const };
        const promotionRow = await tx.promotion.findUnique({ where: { id: input.promotionId } });
        const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
        if (!promotionRow || !user) return { status: "conflict" as const };
        const promotion = this.promotionFromRow(promotionRow);
        if (promotion.type !== "discount_coupon") return { status: "conflict" as const };
        const existing = await tx.promotionRedemption.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
        if (existing) {
          const same = existing["promotionId"] === input.promotionId && existing["planId"] === (input.planId ?? null) && existing["interval"] === (input.interval ?? null) && existing["listPricePaise"] === (input.listPricePaise ?? null) && existing["discountPaise"] === (input.discountPaise ?? null) && existing["payablePaise"] === (input.payablePaise ?? null);
          return same ? { status: "existing" as const, redemption: this.promotionRedemptionFromRow(existing) } : { status: "conflict" as const };
        }
        const discounted = input.planId !== undefined && input.planId !== null && input.interval !== undefined && input.interval !== null && input.listPricePaise !== undefined && input.listPricePaise !== null && input.discountPaise !== undefined && input.discountPaise !== null && input.payablePaise !== undefined && input.payablePaise !== null && validDiscountSnapshot(promotion, { userId: input.userId, planId: input.planId, interval: input.interval, listPricePaise: input.listPricePaise, discountPaise: input.discountPaise, payablePaise: input.payablePaise, now: input.now });
        if (!discounted) return { status: "conflict" as const };
        const previousForUser = await tx.promotionRedemption.findFirst({ where: { promotionId: input.promotionId, userId: input.userId }, select: { id: true } });
        if (previousForUser) return { status: "conflict" as const };
        const counted = await tx.promotionRedemption.count({ where: { promotionId: input.promotionId, status: { in: ["reserved", "redeemed", "manual_review"] } } });
        if (promotion.usageLimit !== null && counted >= promotion.usageLimit) return { status: "conflict" as const };
        if (input.manualPaymentIntentId) {
          const intent = await tx.manualPaymentIntent.findFirst({ where: { id: input.manualPaymentIntentId, userId: input.userId } });
          if (!intent || !["creating", "created"].includes(String(intent["status"])) || !discounted || intent["planId"] !== input.planId || intent["interval"] !== input.interval || intent["amountPaise"] !== input.payablePaise) return { status: "conflict" as const };
        }
        const row = await tx.promotionRedemption.create({ data: { id: input.id, promotionId: input.promotionId, userId: input.userId, status: "reserved", idempotencyKey: input.idempotencyKey,
          planId: input.planId ?? null, interval: input.interval ?? null, listPricePaise: input.listPricePaise ?? null, discountPaise: input.discountPaise ?? null, payablePaise: input.payablePaise ?? null, currency: "INR",
          manualPaymentIntentId: input.manualPaymentIntentId ?? null, manualPaymentIntentUserId: input.manualPaymentIntentId ? input.userId : null, reservedAt: input.now, redeemedAt: null, releasedAt: null, createdAt: input.now, updatedAt: input.now } });
        await this.insertPromotionEvent(tx, { id: `event-${row["id"]}`, eventKey: `redemption:${String(row["id"])}:reserved`, eventType: "coupon_reserved", promotionId: input.promotionId, subjectUserId: input.userId, redemptionId: String(row["id"]), occurredAt: input.now, metadata: { status: String(row["status"]), planId: row["planId"] as string | null, discountPaise: row["discountPaise"] as number | null, payablePaise: row["payablePaise"] as number | null } });
        return { status: "created" as const, redemption: this.promotionRedemptionFromRow(row) };
      });
    } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" }; throw error; }
  }
  async redeemFreeAccessCoupon(input: RedeemFreeAccessCouponInput): Promise<RedeemFreeAccessCouponResult> {
    const code = normalizePromotionCode(input.code);
    if (!/^[A-Z0-9_-]{3,64}$/.test(code) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.redemptionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.grantId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    const eventWriteFailure = Symbol("free coupon redemption event write failed");
    try {
      return await this.db.$transaction(async (tx) => {
        // Shared entitlement lock order: User first, then Promotion, then redemption/grant/events.
        const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!Array.isArray(lockedUser) || lockedUser.length === 0) return { status: "conflict" as const };
        const initial = await tx.promotion.findUnique({ where: { code } });
        if (!initial) return { status: "unavailable" as const };
        const promotionId = String(initial["id"]);
        const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${promotionId} FOR UPDATE`;
        if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return { status: "unavailable" as const };
        const promotionRow = await tx.promotion.findUnique({ where: { id: promotionId } });
        if (!promotionRow || promotionRow["code"] !== code) return { status: "unavailable" as const };
        const promotion = this.promotionFromRow(promotionRow);

        const priorKey = await tx.promotionRedemption.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
        if (priorKey) {
          if (priorKey["promotionId"] !== promotion.id || priorKey["planId"] !== null || priorKey["interval"] !== null || priorKey["listPricePaise"] !== null || priorKey["discountPaise"] !== null || priorKey["payablePaise"] !== null || priorKey["manualPaymentIntentId"] !== null) return { status: "conflict" as const };
          const grantRow = await tx.promotionalAccessGrant.findUnique({ where: { redemptionId: priorKey["id"] } });
          if (!grantRow || grantRow["userId"] !== input.userId || grantRow["promotionId"] !== promotion.id || grantRow["kind"] !== "free_access_coupon") return { status: "conflict" as const };
          return { status: "existing" as const, redemption: this.promotionRedemptionFromRow(priorKey), grant: this.promotionalGrantFromRow(grantRow) };
        }

        if (!validPromotionRecord(promotion) || promotion.type !== "free_access_coupon" || promotion.status !== "active" || promotion.code !== code ||
          promotion.startsAt > input.now || (promotion.expiresAt !== null && promotion.expiresAt <= input.now) || (promotion.targetUserId !== null && promotion.targetUserId !== input.userId) ||
          !promotion.accessPlanId || !Number.isSafeInteger(promotion.durationDays) || promotion.durationDays === null || promotion.durationDays < 1 || promotion.durationDays > 30) return { status: "unavailable" as const };

        // Enforce the one-redemption-per-user rule against all statuses, including released history.
        const previousUse = await tx.promotionRedemption.findFirst({ where: { promotionId: promotion.id, userId: input.userId }, select: { id: true } });
        if (previousUse) return { status: "unavailable" as const };
        const usage = await tx.promotionRedemption.count({ where: { promotionId: promotion.id, status: { in: ["reserved", "redeemed", "manual_review"] } } });
        if (promotion.usageLimit !== null && usage >= promotion.usageLimit) return { status: "unavailable" as const };

        const redemption = await tx.promotionRedemption.create({ data: {
          id: input.redemptionId, promotionId: promotion.id, userId: input.userId, status: "redeemed", idempotencyKey: input.idempotencyKey,
          planId: null, interval: null, listPricePaise: null, discountPaise: null, payablePaise: null, currency: null,
          manualPaymentIntentId: null, manualPaymentIntentUserId: null, reservedAt: input.now, redeemedAt: input.now, releasedAt: null,
          createdAt: input.now, updatedAt: input.now,
        } });
        let grant: Record<string, unknown>;
        try {
          grant = await tx.promotionalAccessGrant.create({ data: {
            id: input.grantId, promotionId: promotion.id, userId: input.userId, redemptionId: String(redemption["id"]), redemptionUserId: input.userId, redemptionPromotionId: promotion.id,
            kind: "free_access_coupon", activationPolicy: "after_current_access", status: "queued", planId: promotion.accessPlanId, durationDays: promotion.durationDays,
            startsAt: null, expiresAt: null, activatedAt: null, revokedAt: null, grantedByAdminId: null, reason: null, createdAt: input.now, updatedAt: input.now,
          } });
        } catch { throw eventWriteFailure; }
        try {
          await this.insertPromotionEvent(tx, { id: `event-${input.redemptionId}-redeemed`, eventKey: `redemption:${input.redemptionId}:redeemed`, eventType: "coupon_redeemed", promotionId: promotion.id, subjectUserId: input.userId, redemptionId: input.redemptionId, occurredAt: input.now, metadata: { status: "redeemed", planId: promotion.accessPlanId, durationDays: promotion.durationDays, source: "free_access_coupon" } });
          await this.insertPromotionEvent(tx, { id: `event-${input.grantId}-created`, eventKey: `grant:${input.grantId}:created`, eventType: "grant_created", promotionId: promotion.id, subjectUserId: input.userId, accessGrantId: input.grantId, occurredAt: input.now, metadata: { status: "queued", planId: promotion.accessPlanId, durationDays: promotion.durationDays, source: "free_access_coupon" } });
        } catch { throw eventWriteFailure; }
        return { status: "created" as const, redemption: this.promotionRedemptionFromRow(redemption), grant: this.promotionalGrantFromRow(grant) };
      });
    } catch (error) {
      if (error === eventWriteFailure || isUniqueViolation(error)) return { status: "conflict" };
      throw error;
    }
  }
  async transitionPromotionRedemption(input: { id: string; userId: string; expectedStatus: PromotionRedemptionRecord["status"]; nextStatus: PromotionRedemptionRecord["status"]; now: Date }): Promise<boolean> {
    if (!promotionRedemptionTransitionAllowed(input.expectedStatus, input.nextStatus)) return false;
    const eventType = input.nextStatus === "redeemed" ? "coupon_redeemed" : input.nextStatus === "released" ? "coupon_released" : "manual_review_required";
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      const current = await tx.promotionRedemption.findFirst({ where: { id: input.id, userId: input.userId } });
      if (current?.["status"] === input.nextStatus) return Boolean(await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${input.id}:${input.nextStatus}` } }));
      const redemption = await tx.promotionRedemption.findFirst({ where: { id: input.id, userId: input.userId, status: input.expectedStatus } });
      if (!redemption) return false;
      if (input.nextStatus === "released" || input.nextStatus === "redeemed") {
        const requiredPaymentStatus = input.nextStatus === "released" ? ["failed", "expired"] : ["paid"];
        if (!redemption["manualPaymentIntentId"] || !await tx.manualPaymentIntent.findFirst({ where: { id: redemption["manualPaymentIntentId"], userId: input.userId, status: { in: requiredPaymentStatus } }, select: { id: true } })) return false;
      }
      const changed = await tx.promotionRedemption.updateMany({ where: { id: input.id, userId: input.userId, status: input.expectedStatus }, data: { status: input.nextStatus, redeemedAt: input.nextStatus === "redeemed" ? input.now : redemption["redeemedAt"], releasedAt: input.nextStatus === "released" ? input.now : null, updatedAt: input.now } });
      if (changed.count !== 1) return false;
      await this.insertPromotionEvent(tx, { id: `event-${input.id}-${input.nextStatus}`, eventKey: `redemption:${input.id}:${input.nextStatus}`, eventType, promotionId: String(redemption["promotionId"]), subjectUserId: input.userId, redemptionId: input.id, occurredAt: input.now, metadata: { status: input.nextStatus } });
      return true;
    });
  }
  async createPromotionalAccessGrant(input: CreatePromotionalAccessGrantInput): Promise<{ status: "created" | "existing" | "conflict"; grant?: PromotionalAccessGrantRecord }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !Number.isSafeInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 30 || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!Array.isArray(locked) || locked.length === 0) return { status: "conflict" as const };
        const promotionLock = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${input.promotionId} FOR UPDATE`;
        if (!Array.isArray(promotionLock) || promotionLock.length === 0) return { status: "conflict" as const };
        const promotionRow = await tx.promotion.findUnique({ where: { id: input.promotionId } });
        if (!promotionRow) return { status: "conflict" as const };
        const promotion = this.promotionFromRow(promotionRow);
        const couponGrant = input.kind === "free_access_coupon";
        const actor = input.grantedByAdminId ? await tx.user.findUnique({ where: { id: input.grantedByAdminId }, select: { role: true } }) : null;
        if (couponGrant ? (input.grantedByAdminId !== null && input.grantedByAdminId !== undefined) : (!actor || actor["role"] !== "admin" || !promotion.targetUserId || promotion.targetUserId !== input.userId || promotion.createdByAdminId !== input.grantedByAdminId || promotion.status !== "active" || promotion.startsAt > input.now || (promotion.expiresAt !== null && promotion.expiresAt <= input.now))) return { status: "conflict" as const };
        if ((input.kind === "bonus_days" && promotion.type !== "bonus_days") || (input.kind === "tier_access" && promotion.type !== "tier_access") || (input.kind === "free_access_coupon" && promotion.type !== "free_access_coupon") || promotion.accessPlanId !== input.planId || promotion.durationDays !== input.durationDays) return { status: "conflict" as const };
        let redemption: Record<string, unknown> | null = null;
        if (input.redemptionId) {
          redemption = await tx.promotionRedemption.findFirst({ where: { id: input.redemptionId, userId: input.userId, promotionId: input.promotionId, status: "redeemed" } });
          if (input.kind !== "free_access_coupon" || !redemption) return { status: "conflict" as const };
        } else if (input.kind === "free_access_coupon") return { status: "conflict" as const };
        const prior = await tx.promotionalAccessGrant.findUnique({ where: { id: input.id } });
        if (prior) {
          const same = prior["promotionId"] === input.promotionId && prior["userId"] === input.userId && prior["redemptionId"] === (input.redemptionId ?? null) && prior["kind"] === input.kind && prior["activationPolicy"] === input.activationPolicy && prior["planId"] === input.planId && prior["durationDays"] === input.durationDays && prior["grantedByAdminId"] === (input.grantedByAdminId ?? null);
          return same ? { status: "existing" as const, grant: this.promotionalGrantFromRow(prior) } : { status: "conflict" as const };
        }
        const data = { id: input.id, promotionId: input.promotionId, userId: input.userId, redemptionId: redemption ? input.redemptionId : null, redemptionUserId: redemption ? input.userId : null, redemptionPromotionId: redemption ? input.promotionId : null,
          kind: input.kind, activationPolicy: input.activationPolicy, status: "queued", planId: input.planId, durationDays: input.durationDays, startsAt: null, expiresAt: null, activatedAt: null, revokedAt: null,
          grantedByAdminId: input.grantedByAdminId ?? null, reason: input.reason ?? null, createdAt: input.now, updatedAt: input.now };
        const row = await tx.promotionalAccessGrant.create({ data });
        await this.insertPromotionEvent(tx, { id: `event-${input.id}`, eventKey: `grant:${input.id}:created`, eventType: "grant_created", promotionId: input.promotionId, subjectUserId: input.userId, actorUserId: input.grantedByAdminId, redemptionId: redemption ? input.redemptionId : null, accessGrantId: input.id, occurredAt: input.now, metadata: { status: "queued", planId: input.planId, durationDays: input.durationDays, reason: input.reason ?? null } });
        return { status: "created" as const, grant: this.promotionalGrantFromRow(row) };
      });
    } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" }; throw error; }
  }
  async activateNextPromotionalAccessGrant(userId: string, now: Date): Promise<PromotionalAccessGrantRecord | null> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length === 0) return null;
      const next = await tx.promotionalAccessGrant.findFirst({ where: { userId, status: "queued" }, orderBy: { queueSequence: "asc" } });
      const paidAccessBlocks = Boolean(next && next["activationPolicy"] === "after_current_access" && await this.hasPaidAccessForPromotion(tx, userId, now));
      const expired = await tx.promotionalAccessGrant.findMany({ where: { userId, status: "active", expiresAt: { lte: now } } });
      for (const row of expired) {
        const changed = await tx.promotionalAccessGrant.updateMany({ where: { id: row["id"], userId, status: "active", expiresAt: { lte: now } }, data: { status: "expired", updatedAt: now } });
        if (changed.count === 1) await this.insertPromotionEvent(tx, { id: `event-${String(row["id"])}-expired`, eventKey: `grant:${String(row["id"])}:expired`, eventType: "grant_expired", promotionId: String(row["promotionId"]), subjectUserId: userId, accessGrantId: String(row["id"]), occurredAt: now, metadata: { status: "expired" } });
      }
      const active = await tx.promotionalAccessGrant.findFirst({ where: { userId, status: "active", startsAt: { lte: now }, expiresAt: { gt: now } }, select: { id: true } });
      if (active) return null;
      if (!next || paidAccessBlocks) return null;
      const startsAt = now; const expiresAt = new Date(now.getTime() + Number(next["durationDays"]) * 86_400_000);
      const changed = await tx.promotionalAccessGrant.updateMany({ where: { id: next["id"], userId, status: "queued" }, data: { status: "active", startsAt, expiresAt, activatedAt: now, updatedAt: now } });
      if (changed.count !== 1) return null;
      await this.insertPromotionEvent(tx, { id: `event-${String(next["id"])}-activated`, eventKey: `grant:${String(next["id"])}:activated`, eventType: "grant_activated", promotionId: String(next["promotionId"]), subjectUserId: userId, accessGrantId: String(next["id"]), occurredAt: now, metadata: { status: "active", planId: String(next["planId"]), durationDays: Number(next["durationDays"]) } });
      const updated = await tx.promotionalAccessGrant.findUnique({ where: { id: next["id"] } });
      return updated ? this.promotionalGrantFromRow(updated) : null;
    });
  }
  async transitionPromotionalAccessGrant(input: { id: string; userId: string; actorUserId?: string | null; expectedStatus: PromotionalAccessGrantRecord["status"]; nextStatus: "expired" | "revoked"; now: Date }): Promise<boolean> {
    if (input.expectedStatus !== "queued" && input.expectedStatus !== "active") return false;
    if (input.nextStatus === "expired" && input.expectedStatus !== "active") return false;
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length === 0) return false;
      const current = await tx.promotionalAccessGrant.findFirst({ where: { id: input.id, userId: input.userId } });
      if (current?.["status"] === input.nextStatus) return Boolean(await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `grant:${input.id}:${input.nextStatus}` } }));
      const row = await tx.promotionalAccessGrant.findFirst({ where: { id: input.id, userId: input.userId, status: input.expectedStatus } });
      if (!row || (input.nextStatus === "expired" && (!(row["expiresAt"] instanceof Date) || row["expiresAt"] > input.now))) return false;
      if (input.actorUserId) {
        const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return false;
      } else if (input.nextStatus === "revoked") return false;
      const changed = await tx.promotionalAccessGrant.updateMany({ where: { id: input.id, userId: input.userId, status: input.expectedStatus }, data: { status: input.nextStatus, revokedAt: input.nextStatus === "revoked" ? input.now : null, updatedAt: input.now } });
      if (changed.count !== 1) return false;
      await this.insertPromotionEvent(tx, { id: `event-${input.id}-${input.nextStatus}`, eventKey: `grant:${input.id}:${input.nextStatus}`, eventType: input.nextStatus === "revoked" ? "grant_revoked" : "grant_expired", promotionId: String(row["promotionId"]), subjectUserId: input.userId, actorUserId: input.actorUserId ?? null, accessGrantId: input.id, occurredAt: input.now, metadata: { status: input.nextStatus } });
      return true;
    });
  }
  async getPromotionalAccessGrant(userId: string, grantId: string): Promise<PromotionalAccessGrantRecord | null> { const row = await this.db.promotionalAccessGrant.findFirst({ where: { id: grantId, userId } }); return row ? this.promotionalGrantFromRow(row) : null; }
  async listPromotionalAccessGrantsForUser(userId: string): Promise<PromotionalAccessGrantRecord[]> { const rows = await this.db.promotionalAccessGrant.findMany({ where: { userId }, orderBy: { queueSequence: "asc" } }); return rows.map((row) => this.promotionalGrantFromRow(row)); }
  async createPromotionLifecycleEvent(input: PromotionLifecycleEventInput): Promise<"created" | "duplicate" | "conflict"> {
    if (!input.eventKey || input.eventKey.length > 200 || !/^[A-Za-z0-9:_-]+$/.test(input.eventKey) || (input.metadata && !validPromotionEventMetadata(input.metadata))) return "conflict";
    try { return await this.db.$transaction(async (tx) => {
      if (!await tx.promotion.findUnique({ where: { id: input.promotionId } })) return "conflict" as const;
      if (input.actorUserId) {
        const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
        if (actor?.["role"] !== "admin") return "conflict" as const;
      }
      if (input.subjectUserId && !await tx.user.findUnique({ where: { id: input.subjectUserId }, select: { id: true } })) return "conflict" as const;
      if (input.redemptionId) {
        const redemption = await tx.promotionRedemption.findFirst({ where: { id: input.redemptionId, promotionId: input.promotionId, userId: input.subjectUserId } });
        if (!redemption) return "conflict" as const;
      }
      if (input.accessGrantId) {
        const grant = await tx.promotionalAccessGrant.findFirst({ where: { id: input.accessGrantId, promotionId: input.promotionId, userId: input.subjectUserId } });
        if (!grant) return "conflict" as const;
      }
      const existing = await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: input.eventKey } });
      if (existing) return promotionEventMatchesRow(existing, input) ? "duplicate" as const : "conflict" as const;
      await this.insertPromotionEvent(tx, input);
      return "created" as const;
    }); } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent transaction may have committed the same event key after our in-transaction read.
      // Revalidate the actor before treating that unique conflict as an idempotent success.
      return this.db.$transaction(async (tx) => {
        if (input.actorUserId) {
          const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { role: true } });
          if (actor?.["role"] !== "admin") return "conflict" as const;
        }
        const existing = await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: input.eventKey } });
        return existing && promotionEventMatchesRow(existing, input) ? "duplicate" as const : "conflict" as const;
      });
    }
  }
  async listPromotionLifecycleEvents(promotionId: string): Promise<PromotionLifecycleEventRecord[]> { const rows = await this.db.promotionLifecycleEvent.findMany({ where: { promotionId }, orderBy: { occurredAt: "asc" } }); return rows.map((row) => this.promotionEventFromRow(row)); }

  private complimentaryGrantFromRow(row: Record<string, unknown>): ComplimentaryAccessGrantRecord {
    return { id: String(row["id"]), userId: String(row["userId"]), planId: String(row["planId"]) as Exclude<PlanId, "free">, status: String(row["status"]) as ComplimentaryAccessState, grantedByAdminId: String(row["grantedByAdminId"]), reason: row["reason"] as string | null, version: Number(row["version"]), createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  private complimentaryEventFromRow(row: Record<string, unknown>): ComplimentaryAccessEventRecord {
    return { id: String(row["id"]), eventKey: String(row["eventKey"]), grantId: String(row["grantId"]), subjectUserId: String(row["subjectUserId"]), actorAdminId: String(row["actorAdminId"]), action: String(row["action"]) as ComplimentaryAccessAction, previousState: row["previousState"] as ComplimentaryAccessState | null, newState: String(row["newState"]) as ComplimentaryAccessState, note: row["note"] as string | null, occurredAt: row["occurredAt"] as Date };
  }
  private async verifiedAdmin(tx: PrismaClientLike, adminId: string): Promise<boolean> {
    const actor = await tx.user.findUnique({ where: { id: adminId }, select: { role: true, emailVerified: true } });
    return actor?.["role"] === "admin" && actor["emailVerified"] instanceof Date;
  }
  async grantComplimentaryAccess(input: { id: string; userId: string; planId: Exclude<PlanId, "free">; adminId: string; note: string | null; now: Date }): Promise<{ status: "created" | "existing" | "already_granted" | "missing_user" | "forbidden" | "conflict"; grant?: ComplimentaryAccessGrantRecord }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !["creator", "pro", "agency"].includes(input.planId) || (input.note !== null && input.note.length > 500) || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      if (!(await this.verifiedAdmin(tx, input.adminId))) return { status: "forbidden" as const };
      const target = await tx.user.findUnique({ where: { id: input.userId }, select: { role: true } });
      if (!target || target["role"] !== "user") return { status: "missing_user" as const };
      const existing = await tx.complimentaryAccessGrant.findUnique({ where: { id: input.id } });
      if (existing) {
        const event = await tx.complimentaryAccessEvent.findUnique({ where: { eventKey: `${input.id}:1` } });
        const same = existing["userId"] === input.userId && existing["planId"] === input.planId && existing["grantedByAdminId"] === input.adminId && existing["reason"] === input.note;
        return same && event?.["action"] === "GRANT" ? { status: "existing" as const, grant: this.complimentaryGrantFromRow(existing) } : { status: "conflict" as const };
      }
      const active = await tx.complimentaryAccessGrant.findFirst({ where: { userId: input.userId, status: { in: ["ACTIVE", "ON_HOLD"] } } });
      if (active) return { status: "already_granted" as const };
      const row = await tx.complimentaryAccessGrant.create({ data: { id: input.id, userId: input.userId, planId: input.planId, status: "ACTIVE", grantedByAdminId: input.adminId, reason: input.note, version: 1, createdAt: input.now, updatedAt: input.now } });
      await tx.complimentaryAccessEvent.create({ data: { id: `event-${input.id}-1`, eventKey: `${input.id}:1`, grantId: input.id, subjectUserId: input.userId, actorAdminId: input.adminId, action: "GRANT", previousState: null, newState: "ACTIVE", note: input.note, occurredAt: input.now } });
      return { status: "created" as const, grant: this.complimentaryGrantFromRow(row) };
    });
  }
  async transitionComplimentaryAccess(input: { grantId: string; userId: string; adminId: string; action: "HOLD" | "RESUME" | "REVOKE"; note: string | null; now: Date }): Promise<ComplimentaryAccessTransitionResult> {
    if (input.note !== null && input.note.length > 500 || !Number.isFinite(input.now.getTime())) return "invalid_transition";
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      if (!(await this.verifiedAdmin(tx, input.adminId))) return "forbidden";
      const grant = await tx.complimentaryAccessGrant.findUnique({ where: { id: input.grantId } });
      if (!grant || grant["userId"] !== input.userId) return "missing";
      const previous = String(grant["status"]) as ComplimentaryAccessState;
      const next: ComplimentaryAccessState = input.action === "HOLD" ? "ON_HOLD" : input.action === "RESUME" ? "ACTIVE" : "REVOKED";
      if (previous === next) return "existing";
      if ((input.action === "HOLD" && previous !== "ACTIVE") || (input.action === "RESUME" && previous !== "ON_HOLD") || (input.action === "REVOKE" && previous === "REVOKED")) return "invalid_transition";
      const version = Number(grant["version"]) + 1;
      const changed = await tx.complimentaryAccessGrant.updateMany({ where: { id: input.grantId, userId: input.userId, status: previous, version: Number(grant["version"]) }, data: { status: next, version, updatedAt: input.now } });
      if (changed.count !== 1) return "invalid_transition";
      await tx.complimentaryAccessEvent.create({ data: { id: `event-${input.grantId}-${version}`, eventKey: `${input.grantId}:${version}`, grantId: input.grantId, subjectUserId: input.userId, actorAdminId: input.adminId, action: input.action, previousState: previous, newState: next, note: input.note, occurredAt: input.now } });
      return "updated";
    });
  }
  async listComplimentaryAccessForUser(userId: string): Promise<{ grants: ComplimentaryAccessGrantRecord[]; events: ComplimentaryAccessEventRecord[] }> {
    const [grants, events] = await Promise.all([
      this.db.complimentaryAccessGrant.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      this.db.complimentaryAccessEvent.findMany({ where: { subjectUserId: userId }, orderBy: { occurredAt: "asc" } }),
    ]);
    return { grants: grants.map((row) => this.complimentaryGrantFromRow(row)), events: events.map((row) => this.complimentaryEventFromRow(row)) };
  }
  async getActiveComplimentaryAccessState(userId: string): Promise<ComplimentaryAccessState | null> { const row = await this.db.complimentaryAccessGrant.findFirst({ where: { userId, status: { in: ["ACTIVE", "ON_HOLD"] } }, select: { status: true } }); return row ? String(row["status"]) as ComplimentaryAccessState : null; }

  async getPlanIdForUser(userId: string, at = this.now()): Promise<PlanId> {
    let promotionsAvailable = true;
    try { await this.activateNextPromotionalAccessGrant(userId, at); }
    catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; promotionsAvailable = false; }
    const row = await this.db.subscription.findUnique({ where: { userId }, select: { planId: true, status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, razorpaySubscriptionId: true } });
    const [capturedPayment, failedPayment] = row?.["razorpaySubscriptionId"] ? await Promise.all([
      this.db.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "captured" }, select: { id: true } }),
      this.db.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "failed" }, select: { id: true } }),
    ]) : [null, null];
    const hasCapturedPayment = Boolean(capturedPayment);
    const hasFailedPayment = Boolean(failedPayment);
    const manualRows = await this.db.manualPlanAccess.findMany({ where: { userId }, select: { planId: true, startsAt: true, expiresAt: true } });
    let promotionalRows: Record<string, unknown>[] = [];
    if (promotionsAvailable) {
      try { promotionalRows = await this.db.promotionalAccessGrant.findMany({ where: { userId, status: "active", startsAt: { lte: at }, expiresAt: { gt: at } }, select: { planId: true, startsAt: true, expiresAt: true, status: true, activationPolicy: true, activatedAt: true, revokedAt: true } }); }
      catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; }
    }
    const complimentaryRow = await this.db.complimentaryAccessGrant.findFirst({ where: { userId, status: "ACTIVE" }, select: { planId: true, status: true } });
    return resolveEffectiveEntitlement({
      now: at,
      subscription: row ? { planId: String(row["planId"]), status: row["status"] as SubscriptionStatus, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]), currentPeriodEnd: row["currentPeriodEnd"] instanceof Date ? row["currentPeriodEnd"] : null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, hasCapturedPayment, hasFailedPayment } : null,
      manualAccess: manualRows.map((access) => ({ planId: String(access["planId"]), startsAt: access["startsAt"] as Date, expiresAt: access["expiresAt"] as Date })),
      promotionalGrants: promotionalRows.map((grant) => ({ planId: String(grant["planId"]), startsAt: grant["startsAt"] as Date, expiresAt: grant["expiresAt"] as Date, status: String(grant["status"]), activationPolicy: String(grant["activationPolicy"]), activatedAt: grant["activatedAt"] instanceof Date ? grant["activatedAt"] : null, revokedAt: grant["revokedAt"] === null ? null : grant["revokedAt"] instanceof Date ? grant["revokedAt"] : new Date(Number.NaN) })),
      complimentaryGrant: complimentaryRow ? { planId: String(complimentaryRow["planId"]), status: String(complimentaryRow["status"]) } : null,
      deferredAccessState: resolveDeferredAccessState({
        now: at,
        subscription: row ? { planId: String(row["planId"]), status: row["status"] as SubscriptionStatus, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]), currentPeriodEnd: row["currentPeriodEnd"] instanceof Date ? row["currentPeriodEnd"] : null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, hasCapturedPayment, hasFailedPayment } : null,
        manualAccess: manualRows.map((access) => ({ planId: String(access["planId"]), startsAt: access["startsAt"] as Date, expiresAt: access["expiresAt"] as Date })),
      }),
    }).planId;
  }

  private async effectivePlanIdInTransaction(tx: PrismaClientLike, userId: string, now: Date, includePromotions: boolean): Promise<PlanId> {
    const row = await tx.subscription.findUnique({ where: { userId }, select: { planId: true, status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, razorpaySubscriptionId: true } });
    const [capturedPayment, failedPayment] = row?.["razorpaySubscriptionId"] ? await Promise.all([
      tx.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "captured" }, select: { id: true } }),
      tx.paymentRecord.findFirst({ where: { userId, providerSubscriptionId: row["razorpaySubscriptionId"], status: "failed" }, select: { id: true } }),
    ]) : [null, null];
    const hasCapturedPayment = Boolean(capturedPayment);
    const hasFailedPayment = Boolean(failedPayment);
    const manualRows = await tx.manualPlanAccess.findMany({ where: { userId }, select: { planId: true, startsAt: true, expiresAt: true } });
    let promotionalRows: Record<string, unknown>[] = [];
    if (includePromotions) promotionalRows = await tx.promotionalAccessGrant.findMany({ where: { userId, status: "active", startsAt: { lte: now }, expiresAt: { gt: now } }, select: { planId: true, startsAt: true, expiresAt: true, status: true, activationPolicy: true, activatedAt: true, revokedAt: true } });
    const complimentaryRow = await tx.complimentaryAccessGrant.findFirst({ where: { userId, status: "ACTIVE" }, select: { planId: true, status: true } });
    return resolveEffectiveEntitlement({
      now,
      subscription: row ? { planId: String(row["planId"]), status: row["status"] as SubscriptionStatus, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]), currentPeriodEnd: row["currentPeriodEnd"] instanceof Date ? row["currentPeriodEnd"] : null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, hasCapturedPayment, hasFailedPayment } : null,
      manualAccess: manualRows.map((access) => ({ planId: String(access["planId"]), startsAt: access["startsAt"] as Date, expiresAt: access["expiresAt"] as Date })),
      promotionalGrants: promotionalRows.map((grant) => ({ planId: String(grant["planId"]), startsAt: grant["startsAt"] as Date, expiresAt: grant["expiresAt"] as Date, status: String(grant["status"]), activationPolicy: String(grant["activationPolicy"]), activatedAt: grant["activatedAt"] instanceof Date ? grant["activatedAt"] : null, revokedAt: grant["revokedAt"] === null ? null : grant["revokedAt"] instanceof Date ? grant["revokedAt"] : new Date(Number.NaN) })),
      complimentaryGrant: complimentaryRow ? { planId: String(complimentaryRow["planId"]), status: String(complimentaryRow["status"]) } : null,
      deferredAccessState: resolveDeferredAccessState({
        now,
        subscription: row ? { planId: String(row["planId"]), status: row["status"] as SubscriptionStatus, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]), currentPeriodEnd: row["currentPeriodEnd"] instanceof Date ? row["currentPeriodEnd"] : null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, hasCapturedPayment, hasFailedPayment } : null,
        manualAccess: manualRows.map((access) => ({ planId: String(access["planId"]), startsAt: access["startsAt"] as Date, expiresAt: access["expiresAt"] as Date })),
      }),
    }).planId;
  }

  private razorpayIntentFromRow(row: Record<string, unknown>): RazorpaySubscriptionIntentRecord {
    return { id: String(row["id"]), userId: String(row["userId"]), idempotencyKey: String(row["idempotencyKey"]), autoRenewConsentAt: row["autoRenewConsentAt"] as Date | null, autoRenewConsentVersion: row["autoRenewConsentVersion"] as string | null, providerSubscriptionId: row["providerSubscriptionId"] as string | null, providerPlanId: String(row["providerPlanId"]), checkoutUrl: row["checkoutUrl"] as string | null, planId: row["planId"] as PlanId, interval: row["interval"] as "weekly" | "monthly", amountPaise: row["amountPaise"] === null ? null : Number(row["amountPaise"]), currency: "INR", status: row["status"] as RazorpayIntentStatus, errorCategory: row["errorCategory"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  async reserveRazorpaySubscriptionIntent(input: ReserveRazorpaySubscriptionIntentInput): Promise<{ status: "created" | "existing" | "conflict"; intent?: RazorpaySubscriptionIntentRecord }> {
    if (input.planId === "free" || getPlan(input.planId).pricePaise[input.interval] !== input.amountPaise || !input.idempotencyKey || input.idempotencyKey.length > 128 || !(input.autoRenewConsentAt instanceof Date) || !input.autoRenewConsentVersion) return { status: "conflict" };
    try { return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      const old = await tx.razorpaySubscriptionIntent.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
      if (old) { const row = this.razorpayIntentFromRow(old); return row.planId === input.planId && row.interval === input.interval && row.amountPaise === input.amountPaise ? { status: "existing", intent: row } : { status: "conflict" }; }
      const other = await tx.razorpaySubscriptionIntent.findFirst({ where: { userId: input.userId, status: { in: ["creating", "created", "active", "manual_review"] } } });
      const manual = await tx.manualPaymentIntent.findFirst({ where: { userId: input.userId, status: { in: ["creating", "created", "manual_review"] } } });
      const grant = await tx.manualPlanAccess.findFirst({ where: { userId: input.userId, expiresAt: { gt: input.now } } });
      const current = await tx.subscription.findUnique({ where: { userId: input.userId } });
      if (other || manual || grant || (current && (["active", "pending", "authenticated", "created", "halted"].includes(String(current["status"])) || (current["status"] === "cancelled" && current["cancelAtPeriodEnd"] === true)) && (!current["currentPeriodEnd"] || current["currentPeriodEnd"] > input.now))) return { status: "conflict" };
      const row = await tx.razorpaySubscriptionIntent.create({ data: { ...input, currency: "INR", status: "creating", providerSubscriptionId: null, checkoutUrl: null, errorCategory: null, createdAt: input.now, updatedAt: input.now } });
      return { status: "created", intent: this.razorpayIntentFromRow(row) };
    }); } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" }; throw error; }
  }
  async finishRazorpaySubscriptionIntent(input: { id: string; userId: string; status: RazorpayIntentStatus; providerSubscriptionId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      const row = await tx.razorpaySubscriptionIntent.findUnique({ where: { id: input.id } });
      if (!row || row["userId"] !== input.userId || row["status"] !== "creating") return false;
      const updated = await tx.razorpaySubscriptionIntent.updateMany({ where: { id: input.id, userId: input.userId, status: "creating" }, data: { status: input.status, providerSubscriptionId: input.providerSubscriptionId ?? null, checkoutUrl: input.checkoutUrl ?? null, errorCategory: input.errorCategory ?? null, updatedAt: input.now } });
      if (updated.count !== 1) return false;
      if (input.status === "created" && input.providerSubscriptionId) await tx.subscription.upsert({ where: { userId: input.userId }, create: { userId: input.userId, planId: row["planId"], interval: row["interval"], status: "created", razorpaySubscriptionId: input.providerSubscriptionId, lastEventAt: 0n, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false }, update: { planId: row["planId"], interval: row["interval"], status: "created", razorpaySubscriptionId: input.providerSubscriptionId, lastEventAt: 0n, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false } });
      return true;
    });
  }
  async getRazorpaySubscriptionIntent(userId: string, idempotencyKey: string): Promise<RazorpaySubscriptionIntentRecord | null> { const row = await this.db.razorpaySubscriptionIntent.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } }); return row ? this.razorpayIntentFromRow(row) : null; }
  async getRazorpaySubscriptionIntentByProviderId(userId: string, providerSubscriptionId: string): Promise<RazorpaySubscriptionIntentRecord | null> { const row = await this.db.razorpaySubscriptionIntent.findFirst({ where: { userId, providerSubscriptionId } }); return row ? this.razorpayIntentFromRow(row) : null; }

  async getRazorpaySubscriptionForOwner(userId: string): Promise<{ id: string; planId: PlanId; interval: "weekly" | "monthly"; status: import("../../lib/billing/subscription-state.ts").SubscriptionStatus; razorpaySubscriptionId: string | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean; trialEndsAt: number | null } | null> {
    const row = await this.db.subscription.findUnique({ where: { userId } });
    return row ? { id: String(row["id"]), planId: row["planId"] as PlanId, interval: row["interval"] as "weekly" | "monthly", status: row["status"] as import("../../lib/billing/subscription-state.ts").SubscriptionStatus, razorpaySubscriptionId: row["razorpaySubscriptionId"] as string | null, currentPeriodEnd: row["currentPeriodEnd"] as Date | null, cancelAtPeriodEnd: row["cancelAtPeriodEnd"] === true, trialEndsAt: row["trialEndsAt"] == null ? null : Number(row["trialEndsAt"]) } : null;
  }

  async recordRazorpayCancellation(userId: string, providerSubscriptionId: string, cancelAtPeriodEnd: boolean, providerStatus: import("../../lib/billing/subscription-state.ts").SubscriptionStatus, currentPeriodEnd: Date | null, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const result = await tx.subscription.updateMany({ where: { userId, razorpaySubscriptionId: providerSubscriptionId }, data: { cancelAtPeriodEnd, status: providerStatus, ...(currentPeriodEnd ? { currentPeriodEnd } : {}), updatedAt: now } });
      return result.count === 1;
    });
  }

  async requestRazorpayCancellation(userId: string, providerSubscriptionId: string, now: Date): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "userId" = ${userId} AND "razorpaySubscriptionId" = ${providerSubscriptionId} FOR UPDATE`;
      const row = await tx.subscription.findFirst({ where: { userId, razorpaySubscriptionId: providerSubscriptionId } });
      if (!row) return false;
      await tx.subscription.update({ where: { id: row["id"] }, data: { cancellationRequestedAt: row["cancellationRequestedAt"] ?? now, updatedAt: now } });
      return true;
    });
  }

  async listSubscriptionContinuationCandidates(now: Date): Promise<import("../repository.ts").SubscriptionContinuationCandidate[]> {
    const rows = await this.db.subscription.findMany({ where: { status: "active", razorpaySubscriptionId: { not: null }, currentPeriodEnd: { gt: now }, cancelAtPeriodEnd: false, cancellationRequestedAt: null } });
    return rows.filter((r) => r["currentPeriodEnd"] instanceof Date && typeof r["razorpaySubscriptionId"] === "string").map((r) => ({ id: String(r["id"]), userId: String(r["userId"]), planId: r["planId"] as PlanId, interval: r["interval"] as "weekly" | "monthly", providerSubscriptionId: String(r["razorpaySubscriptionId"]), currentPeriodEnd: r["currentPeriodEnd"] as Date }));
  }

  async reserveSubscriptionContinuation(input: import("../repository.ts").SubscriptionContinuationInput): Promise<"reserved" | "existing" | "cancelled" | "not_due"> {
    try {
      return await this.db.$transaction(async (tx) => {
        const owner = await tx.subscription.findUnique({ where: { id: input.subscriptionId }, select: { userId: true } });
        if (!owner || typeof owner["userId"] !== "string") return "not_due" as const;
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${owner["userId"]} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Subscription" WHERE "id" = ${input.subscriptionId} FOR UPDATE`;
        const row = await tx.subscription.findUnique({ where: { id: input.subscriptionId } });
        if (!row || row["razorpaySubscriptionId"] !== input.providerSubscriptionId || row["currentPeriodEnd"]?.getTime?.() !== input.cycleEnd.getTime()) return "not_due";
        if (row["cancellationRequestedAt"] || row["cancelAtPeriodEnd"] === true || row["status"] !== "active") return "cancelled";
        await tx.razorpaySubscriptionContinuation.create({ data: { ...input, status: "reserved" } });
        return "reserved";
      });
    } catch (error) { if (isUniqueViolation(error)) return "existing"; throw error; }
  }

  async finishSubscriptionContinuation(input: { id: string; status: "applied" | "manual_review" | "skipped"; errorCategory?: string; now: Date }): Promise<boolean> {
    const result = await this.db.razorpaySubscriptionContinuation.updateMany({ where: { id: input.id, status: "reserved" }, data: { status: input.status, errorCategory: input.errorCategory ?? null, finishedAt: input.now, updatedAt: input.now } });
    return result.count === 1;
  }

  private manualIntentFromRow(row: Record<string, unknown>): ManualPaymentIntentRecord {
    return { id: String(row["id"]), userId: String(row["userId"]), idempotencyKey: String(row["idempotencyKey"]), providerPaymentLinkId: row["providerPaymentLinkId"] as string | null, checkoutUrl: row["checkoutUrl"] as string | null, planId: row["planId"] as PlanId, interval: row["interval"] as "weekly" | "monthly", amountPaise: Number(row["amountPaise"]), currency: "INR", status: row["status"] as ManualIntentStatus, accessStartsAt: row["accessStartsAt"] as Date | null, accessEndsAt: row["accessEndsAt"] as Date | null, errorCategory: row["errorCategory"] as string | null, createdAt: row["createdAt"] as Date, updatedAt: row["updatedAt"] as Date };
  }
  async reserveManualPaymentIntent(input: { id: string; userId: string; idempotencyKey: string; planId: PlanId; interval: "weekly" | "monthly"; amountPaise: number; now: Date }): Promise<{ status: "created" | "existing" | "conflict"; intent?: ManualPaymentIntentRecord }> {
    if (input.planId === "free" || getPlan(input.planId).pricePaise[input.interval] !== input.amountPaise || !input.idempotencyKey || input.idempotencyKey.length > 128) return { status: "conflict" };
    try { return await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      const old = await tx.manualPaymentIntent.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
      if (old) { const row = this.manualIntentFromRow(old); return row.planId === input.planId && row.interval === input.interval && row.amountPaise === input.amountPaise ? { status: "existing", intent: row } : { status: "conflict" }; }
      const current = await tx.subscription.findUnique({ where: { userId: input.userId } });
      if (current && (["created", "authenticated", "active", "pending", "halted"].includes(String(current["status"])) || (current["status"] === "cancelled" && current["cancelAtPeriodEnd"] === true)) && (!current["currentPeriodEnd"] || current["currentPeriodEnd"] > input.now)) return { status: "conflict" };
      const access = await tx.manualPlanAccess.findFirst({ where: { userId: input.userId, expiresAt: { gt: input.now } } });
      const pending = await tx.manualPaymentIntent.findFirst({ where: { userId: input.userId, status: { in: ["creating", "created", "manual_review"] } } });
      if (access || pending) return { status: "conflict" };
      const row = await tx.manualPaymentIntent.create({ data: { ...input, currency: "INR", status: "creating", providerPaymentLinkId: null, checkoutUrl: null, accessStartsAt: null, accessEndsAt: null, errorCategory: null, createdAt: input.now, updatedAt: input.now } });
      return { status: "created", intent: this.manualIntentFromRow(row) };
    }); } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" }; throw error; }
  }
  async reserveDiscountedManualPaymentIntent(input: ReserveDiscountedManualPaymentIntentInput): Promise<ReserveDiscountedManualPaymentIntentResult> {
    const code = normalizePromotionCode(input.couponCode);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey) ||
      !/^[A-Z0-9_-]{3,64}$/.test(code) || !Number.isFinite(input.now.getTime())) return { status: "conflict" };
    const eventWriteFailure = Symbol("discount reservation event write failed");
    try {
      return await this.db.$transaction(async (tx) => {
        // Keep the shared lock order: User first, then Promotion, then billing/redemption/audit rows.
        const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!Array.isArray(lockedUser) || lockedUser.length === 0) return { status: "conflict" as const };
        const old = await tx.manualPaymentIntent.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
        if (old) {
          const redemptionRow = await tx.promotionRedemption.findFirst({ where: { manualPaymentIntentId: old["id"], manualPaymentIntentUserId: input.userId } });
          if (!redemptionRow) return { status: "conflict" as const };
          const promotionId = String(redemptionRow["promotionId"]);
          const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${promotionId} FOR UPDATE`;
          if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return { status: "conflict" as const };
          const oldPromotion = await tx.promotion.findUnique({ where: { id: promotionId } });
          if (!oldPromotion || oldPromotion["code"] !== code || oldPromotion["type"] !== "discount_coupon") return { status: "conflict" as const };
          const promotion = this.promotionFromRow(oldPromotion);
          const reservationEvent = await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${redemptionRow["id"]}:reserved` } });
          const reservationMetadata = reservationEvent?.["metadata"] && typeof reservationEvent["metadata"] === "object" && !Array.isArray(reservationEvent["metadata"])
            ? reservationEvent["metadata"] as Record<string, unknown> : null;
          if (reservationMetadata?.["discountType"] !== promotion.discountType || reservationMetadata?.["discountValue"] !== promotion.discountValue) return { status: "conflict" as const };
          const amounts = calculateDiscountAmounts(promotion, input);
          if (!amounts) return { status: "conflict" as const };
          const intent = this.manualIntentFromRow(old);
          const redemption = this.promotionRedemptionFromRow(redemptionRow);
          const exact = intent.userId === input.userId && intent.idempotencyKey === input.idempotencyKey && intent.planId === input.planId && intent.interval === input.interval && intent.amountPaise === amounts.payablePaise &&
            redemption.promotionId === promotion.id && redemption.userId === input.userId && redemption.idempotencyKey === input.idempotencyKey && redemption.planId === input.planId && redemption.interval === input.interval &&
            redemption.listPricePaise === amounts.listPricePaise && redemption.discountPaise === amounts.discountPaise && redemption.payablePaise === amounts.payablePaise && redemption.manualPaymentIntentId === intent.id && redemption.manualPaymentIntentUserId === input.userId;
          return exact ? { status: "existing" as const, intent, redemption } : { status: "conflict" as const };
        }
        const initial = await tx.promotion.findUnique({ where: { code } });
        if (!initial) return { status: "unavailable" as const };
        const promotionId = String(initial["id"]);
        const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${promotionId} FOR UPDATE`;
        if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return { status: "unavailable" as const };
        const promotionRow = await tx.promotion.findUnique({ where: { id: promotionId } });
        if (!promotionRow || promotionRow["code"] !== code) return { status: "unavailable" as const };
        const promotion = this.promotionFromRow(promotionRow);
        if (promotion.type !== "discount_coupon") return { status: "unavailable" as const };
        const amounts = calculateDiscountAmounts(promotion, input);
        if (!amounts) return { status: "unavailable" as const };

        if (promotion.status !== "active" || promotion.startsAt > input.now || (promotion.expiresAt !== null && promotion.expiresAt <= input.now) ||
          (promotion.targetUserId !== null && promotion.targetUserId !== input.userId) || !promotion.eligiblePlanIds.includes(input.planId) || !validPromotionRecord(promotion) ||
          !validDiscountSnapshot(promotion, { userId: input.userId, planId: input.planId, interval: input.interval, ...amounts, now: input.now })) return { status: "unavailable" as const };
        const previous = await tx.promotionRedemption.findFirst({ where: { promotionId: promotion.id, userId: input.userId }, select: { id: true } });
        if (previous) return { status: "conflict" as const };
        const used = await tx.promotionRedemption.count({ where: { promotionId: promotion.id, status: { in: ["reserved", "redeemed", "manual_review"] } } });
        if (promotion.usageLimit !== null && used >= promotion.usageLimit) return { status: "unavailable" as const };

        const current = await tx.subscription.findUnique({ where: { userId: input.userId } });
        if (current && (["created", "authenticated", "active", "pending", "halted"].includes(String(current["status"])) || (current["status"] === "cancelled" && current["cancelAtPeriodEnd"] === true)) && (!current["currentPeriodEnd"] || current["currentPeriodEnd"] > input.now)) return { status: "conflict" as const };
        const access = await tx.manualPlanAccess.findFirst({ where: { userId: input.userId, expiresAt: { gt: input.now } } });
        const pending = await tx.manualPaymentIntent.findFirst({ where: { userId: input.userId, status: { in: ["creating", "created", "manual_review"] } } });
        if (access || pending) return { status: "conflict" as const };

        const intentRow = await tx.manualPaymentIntent.create({ data: { id: input.id, userId: input.userId, idempotencyKey: input.idempotencyKey, planId: input.planId, interval: input.interval,
          amountPaise: amounts.payablePaise, currency: "INR", status: "creating", providerPaymentLinkId: null, checkoutUrl: null, accessStartsAt: null, accessEndsAt: null, errorCategory: null, createdAt: input.now, updatedAt: input.now } });
        const redemptionId = `redemption-${input.id}`;
        let redemptionRow: Record<string, unknown>;
        try {
          redemptionRow = await tx.promotionRedemption.create({ data: { id: redemptionId, promotionId: promotion.id, userId: input.userId, status: "reserved", idempotencyKey: input.idempotencyKey,
            planId: input.planId, interval: input.interval, listPricePaise: amounts.listPricePaise, discountPaise: amounts.discountPaise, payablePaise: amounts.payablePaise, currency: "INR",
            manualPaymentIntentId: input.id, manualPaymentIntentUserId: input.userId, reservedAt: input.now, redeemedAt: null, releasedAt: null, createdAt: input.now, updatedAt: input.now } });
          await this.insertPromotionEvent(tx, { id: `event-${redemptionId}-reserved`, eventKey: `redemption:${redemptionId}:reserved`, eventType: "coupon_reserved", promotionId: promotion.id,
            subjectUserId: input.userId, redemptionId, occurredAt: input.now, metadata: { status: "reserved", planId: input.planId, discountType: promotion.discountType, discountValue: promotion.discountValue, discountPaise: amounts.discountPaise, payablePaise: amounts.payablePaise } });
        } catch { throw eventWriteFailure; }
        return { status: "created" as const, intent: this.manualIntentFromRow(intentRow), redemption: this.promotionRedemptionFromRow(redemptionRow) };
      });
    } catch (error) {
      if (error === eventWriteFailure || isUniqueViolation(error)) return { status: "conflict" };
      throw error;
    }
  }
  async finishManualPaymentIntent(input: { id: string; userId: string; status: ManualIntentStatus; providerPaymentLinkId?: string; checkoutUrl?: string; errorCategory?: string; now: Date }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
      const result = await tx.manualPaymentIntent.updateMany({ where: { id: input.id, userId: input.userId, status: "creating" }, data: { status: input.status, providerPaymentLinkId: input.providerPaymentLinkId ?? null, checkoutUrl: input.checkoutUrl ?? null, errorCategory: input.errorCategory ?? null, updatedAt: input.now } });
      return result.count === 1;
    });
  }
  async getManualPaymentIntent(userId: string, intentId: string): Promise<ManualPaymentIntentRecord | null> { const row = await this.db.manualPaymentIntent.findFirst({ where: { id: intentId, userId } }); return row ? this.manualIntentFromRow(row) : null; }
  async getManualPaymentIntentForWebhook(intentId: string): Promise<ManualPaymentIntentRecord | null> { const row = await this.db.manualPaymentIntent.findUnique({ where: { id: intentId } }); return row ? this.manualIntentFromRow(row) : null; }
  async settleManualPayment(input: SettleManualPaymentInput): Promise<"applied" | "duplicate" | "invalid" | "conflict"> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.userId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.intentId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerPaymentLinkId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerPaymentId) || !Number.isSafeInteger(input.amountPaise) || input.amountPaise < 1 || !Number.isFinite(input.paidAt.getTime()) || !Number.isFinite(input.now.getTime())) return "invalid";
    const stale = Symbol("manual payment settlement changed");
    try {
      return await this.db.$transaction(async (tx) => {
        // Global billing lock order: User, optional Promotion, then intent/payment/access/redemption/event rows.
        const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!Array.isArray(lockedUser) || lockedUser.length === 0) return "invalid";
        const intentRow = await tx.manualPaymentIntent.findFirst({ where: { id: input.intentId, userId: input.userId } });
        if (!intentRow) return await tx.paymentRecord.findUnique({ where: { providerPaymentId: input.providerPaymentId } }) ? "conflict" : "invalid";

        // This initial read only discovers the promotion lock key. All settlement data is re-read after that lock.
        const initialRedemption = await tx.promotionRedemption.findFirst({ where: { manualPaymentIntentId: input.intentId, manualPaymentIntentUserId: input.userId } });
        let promotion: PromotionRecord | null = null;
        let redemptionRow: Record<string, unknown> | null = null;
        if (initialRedemption) {
          const promotionId = String(initialRedemption["promotionId"]);
          const lockedPromotion = await tx.$queryRaw`SELECT "id" FROM "Promotion" WHERE "id" = ${promotionId} FOR UPDATE`;
          if (!Array.isArray(lockedPromotion) || lockedPromotion.length === 0) return "conflict";
          const [freshPromotion, freshRedemption] = await Promise.all([
            tx.promotion.findUnique({ where: { id: promotionId } }),
            tx.promotionRedemption.findFirst({ where: { id: initialRedemption["id"], manualPaymentIntentId: input.intentId, manualPaymentIntentUserId: input.userId } }),
          ]);
          if (!freshPromotion || !freshRedemption || freshRedemption["promotionId"] !== promotionId) return "conflict";
          promotion = this.promotionFromRow(freshPromotion);
          redemptionRow = freshRedemption;
        }

        const [paymentRow, accessRow, otherPayment] = await Promise.all([
          tx.paymentRecord.findUnique({ where: { providerPaymentId: input.providerPaymentId } }),
          tx.manualPlanAccess.findUnique({ where: { intentId: input.intentId } }),
          tx.paymentRecord.findFirst({ where: { manualPaymentIntentId: input.intentId } }),
        ]);
        const intent = this.manualIntentFromRow(intentRow);
        const redemption = redemptionRow ? this.promotionRedemptionFromRow(redemptionRow) : null;
        let periodEnd: Date | null = null;
        try { periodEnd = accessPeriodEnd(input.paidAt, intent.interval); } catch { /* malformed stored period fails closed */ }
        const hasSettlement = intent.status === "paid" || Boolean(accessRow) || Boolean(otherPayment);

        if (paymentRow || hasSettlement) {
          const paymentMatches = Boolean(paymentRow && otherPayment && otherPayment["providerPaymentId"] === input.providerPaymentId && paymentRow["userId"] === input.userId && paymentRow["manualPaymentIntentId"] === intent.id && paymentRow["subscriptionIntentId"] == null && paymentRow["providerSubscriptionId"] == null && paymentRow["amountPaise"] === input.amountPaise && input.currency === "INR" && input.status === "captured" && paymentRow["currency"] === input.currency && paymentRow["status"] === input.status && paymentRow["createdAt"] instanceof Date && paymentRow["createdAt"].getTime() === input.paidAt.getTime());
          const accessMatches = Boolean(accessRow && periodEnd && intent.status === "paid" && intent.providerPaymentLinkId === input.providerPaymentLinkId && intent.amountPaise === input.amountPaise && intent.accessStartsAt?.getTime() === input.paidAt.getTime() && intent.accessEndsAt?.getTime() === periodEnd.getTime() && accessRow["userId"] === input.userId && accessRow["intentId"] === intent.id && accessRow["providerPaymentId"] === input.providerPaymentId && accessRow["planId"] === intent.planId && accessRow["startsAt"] instanceof Date && accessRow["startsAt"].getTime() === input.paidAt.getTime() && accessRow["expiresAt"] instanceof Date && accessRow["expiresAt"].getTime() === periodEnd.getTime());
          let redemptionMatches = redemption === null;
          if (!redemption) {
            try { redemptionMatches = intent.amountPaise === getPlan(intent.planId).pricePaise[intent.interval]; } catch { redemptionMatches = false; }
          }
          if (redemption && promotion) {
            const [reservedEvent, redeemedEvent, redeemedAudits] = await Promise.all([
              tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${redemption.id}:reserved` } }),
              tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${redemption.id}:redeemed` } }),
              tx.auditLog.findMany({ where: { action: "promotion.coupon_redeemed", entityType: "PromotionRedemption", entityId: redemption.id } }),
            ]);
            const reservedMetadata = reservedEvent?.["metadata"] && typeof reservedEvent["metadata"] === "object" && !Array.isArray(reservedEvent["metadata"]) ? reservedEvent["metadata"] as Record<string, unknown> : null;
            const auditExists = redeemedAudits.some((entry) => {
              const metadata = entry["metadata"] && typeof entry["metadata"] === "object" && !Array.isArray(entry["metadata"]) ? entry["metadata"] as Record<string, unknown> : null;
              return metadata?.["eventKey"] === `redemption:${redemption.id}:redeemed`;
            });
            const amounts = calculateDiscountAmounts(promotion, { planId: intent.planId, interval: intent.interval });
            redemptionMatches = Boolean(redemption.status === "redeemed" && promotion.type === "discount_coupon" && redemption.promotionId === promotion.id && redemption.userId === input.userId && redemption.idempotencyKey === intent.idempotencyKey && redemption.planId === intent.planId && redemption.interval === intent.interval && redemption.currency === "INR" && redemption.manualPaymentIntentId === intent.id && redemption.manualPaymentIntentUserId === input.userId && amounts && redemption.listPricePaise === amounts.listPricePaise && redemption.discountPaise === amounts.discountPaise && redemption.payablePaise === amounts.payablePaise && intent.amountPaise === amounts.payablePaise && reservedMetadata?.["discountType"] === promotion.discountType && reservedMetadata?.["discountValue"] === promotion.discountValue && redeemedEvent?.["promotionId"] === promotion.id && redeemedEvent["eventType"] === "coupon_redeemed" && redeemedEvent["subjectUserId"] === input.userId && redeemedEvent["redemptionId"] === redemption.id && auditExists);
          }
          return paymentMatches && accessMatches && redemptionMatches ? "duplicate" : "conflict";
        }

        if (intent.status !== "created" || intent.providerPaymentLinkId !== input.providerPaymentLinkId || intent.amountPaise !== input.amountPaise || input.currency !== "INR" || input.status !== "captured") return "invalid";
        let amounts: ReturnType<typeof calculateDiscountAmounts> = null;
        if (redemption) {
          if (!promotion || promotion.type !== "discount_coupon" || redemption.status !== "reserved" || redemption.userId !== input.userId || redemption.idempotencyKey !== intent.idempotencyKey || redemption.planId !== intent.planId || redemption.interval !== intent.interval || redemption.currency !== "INR" || redemption.manualPaymentIntentId !== intent.id || redemption.manualPaymentIntentUserId !== input.userId) return "conflict";
          amounts = calculateDiscountAmounts(promotion, { planId: intent.planId, interval: intent.interval });
          const reservedEvent = await tx.promotionLifecycleEvent.findUnique({ where: { eventKey: `redemption:${redemption.id}:reserved` } });
          const metadata = reservedEvent?.["metadata"] && typeof reservedEvent["metadata"] === "object" && !Array.isArray(reservedEvent["metadata"]) ? reservedEvent["metadata"] as Record<string, unknown> : null;
          if (!amounts || redemption.listPricePaise !== amounts.listPricePaise || redemption.discountPaise !== amounts.discountPaise || redemption.payablePaise !== amounts.payablePaise || intent.amountPaise !== amounts.payablePaise || reservedEvent?.["promotionId"] !== promotion.id || reservedEvent["eventType"] !== "coupon_reserved" || reservedEvent["subjectUserId"] !== input.userId || reservedEvent["redemptionId"] !== redemption.id || metadata?.["status"] !== "reserved" || metadata?.["planId"] !== intent.planId || metadata?.["discountType"] !== promotion.discountType || metadata?.["discountValue"] !== promotion.discountValue || metadata?.["discountPaise"] !== amounts.discountPaise || metadata?.["payablePaise"] !== amounts.payablePaise) return "conflict";
        } else {
          try { if (getPlan(intent.planId).pricePaise[intent.interval] !== intent.amountPaise) return "conflict"; } catch { return "conflict"; }
        }

        const subscription = await tx.subscription.findUnique({ where: { userId: input.userId } });
        if (subscription && (["created", "authenticated", "active", "pending", "halted"].includes(String(subscription["status"])) || (subscription["status"] === "cancelled" && subscription["cancelAtPeriodEnd"] === true)) && (!subscription["currentPeriodEnd"] || subscription["currentPeriodEnd"] > input.now)) return "conflict";
        if (await tx.manualPlanAccess.findFirst({ where: { userId: input.userId, expiresAt: { gt: input.now } } })) return "conflict";
        if (!periodEnd) return "conflict";

        const startsAt = input.paidAt;
        await tx.paymentRecord.create({ data: { userId: input.userId, providerPaymentId: input.providerPaymentId, amountPaise: input.amountPaise, currency: "INR", status: "captured", manualPaymentIntentId: intent.id, subscriptionIntentId: null, providerSubscriptionId: null, createdAt: startsAt } });
        await tx.manualPlanAccess.create({ data: { id: randomUUID(), userId: input.userId, intentId: intent.id, providerPaymentId: input.providerPaymentId, planId: intent.planId, startsAt, expiresAt: periodEnd } });
        const intentUpdate = await tx.manualPaymentIntent.updateMany({ where: { id: intent.id, userId: input.userId, status: "created", providerPaymentLinkId: input.providerPaymentLinkId, amountPaise: input.amountPaise }, data: { status: "paid", accessStartsAt: startsAt, accessEndsAt: periodEnd, updatedAt: input.now } });
        if (intentUpdate.count !== 1) throw stale;
        if (redemption && promotion && amounts) {
          const redemptionUpdate = await tx.promotionRedemption.updateMany({ where: { id: redemption.id, promotionId: promotion.id, userId: input.userId, status: "reserved", manualPaymentIntentId: intent.id, manualPaymentIntentUserId: input.userId }, data: { status: "redeemed", redeemedAt: input.now, releasedAt: null, updatedAt: input.now } });
          if (redemptionUpdate.count !== 1) throw stale;
          await this.insertPromotionEvent(tx, { id: `event-${redemption.id}-redeemed`, eventKey: `redemption:${redemption.id}:redeemed`, eventType: "coupon_redeemed", promotionId: promotion.id, subjectUserId: input.userId, redemptionId: redemption.id, occurredAt: input.now, metadata: { status: "redeemed", planId: intent.planId, discountType: promotion.discountType, discountValue: promotion.discountValue, discountPaise: amounts.discountPaise, payablePaise: amounts.payablePaise } });
        }
        return "applied";
      });
    } catch (error) { if (error === stale || isUniqueViolation(error)) return "conflict"; throw error; }
  }

  async processRazorpaySubscriptionEvent(input: RazorpaySubscriptionEventInput): Promise<RazorpaySubscriptionEventResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        let lockedUserId: string | null = null;
        if (input.subscriptionId) {
          // The join discovers only the owning user and locks that User row before subscription state is read.
          const lockedOwner = await tx.$queryRaw`SELECT u."id" AS "userId" FROM "User" AS u INNER JOIN "Subscription" AS s ON s."userId" = u."id" WHERE s."razorpaySubscriptionId" = ${input.subscriptionId} FOR UPDATE OF u`;
          if (Array.isArray(lockedOwner) && lockedOwner.length > 0 && typeof lockedOwner[0]?.["userId"] === "string") lockedUserId = lockedOwner[0]["userId"] as string;
        }
        const subscription = input.subscriptionId ? await tx.subscription.findUnique({ where: { razorpaySubscriptionId: input.subscriptionId } }) : null;
        if (input.newStatus && (!subscription || !lockedUserId || subscription["userId"] !== lockedUserId || input.createdAt === undefined)) return "unknown_subscription";
        const intent = input.subscriptionId ? await tx.razorpaySubscriptionIntent.findUnique({ where: { providerSubscriptionId: input.subscriptionId } }) : null;
        if (input.newStatus === "active" && (!intent || intent["status"] === "manual_review" || intent["amountPaise"] == null || !input.payment || input.payment.status !== "captured" || input.payment.currency !== "INR" || input.payment.amount !== Number(intent["amountPaise"]) || !input.payment.id)) return "invalid_transition";
        const validPlanPayment = Boolean(intent && intent["amountPaise"] != null && input.payment && input.payment.currency === "INR" && input.payment.amount === Number(intent["amountPaise"]) && (input.payment.status === "captured" || input.payment.status === "failed"));
        await tx.webhookEvent.create({ data: { providerEventId: input.providerEventId, eventType: input.eventType, status: "received", receivedAt: this.now(), processedAt: null, errorMessage: null } });
        if (!input.newStatus || input.createdAt === undefined || !subscription) {
          await tx.webhookEvent.update({ where: { providerEventId: input.providerEventId }, data: { status: "ignored", processedAt: this.now() } });
          return "ignored";
        }
        const state: SubscriptionState = { planId: subscription["planId"] as PlanId, interval: subscription["interval"], status: subscription["status"], lastEventAt: Number(subscription["lastEventAt"] ?? 0), processedEventIds: [], trialEndsAt: subscription["trialEndsAt"] == null ? null : Number(subscription["trialEndsAt"]) };
        const outcome = applySubscriptionEvent(state, { eventId: input.providerEventId, createdAt: input.createdAt, newStatus: input.newStatus });
        if (!outcome.applied) {
          await tx.webhookEvent.update({ where: { providerEventId: input.providerEventId }, data: { status: "ignored", processedAt: this.now() } });
          return outcome.reason;
        }
        const update = await tx.subscription.updateMany({
          where: { id: subscription["id"], status: subscription["status"], lastEventAt: subscription["lastEventAt"] ?? 0 },
          data: { status: outcome.state.status, lastEventAt: BigInt(outcome.state.lastEventAt), ...(input.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: new Date(input.currentPeriodEnd * 1000) }), ...(outcome.state.status === "cancelled" && input.eventType === "subscription.cancelled" ? { cancelAtPeriodEnd: Boolean(subscription["cancelAtPeriodEnd"]) } : {}) },
        });
        if (update.count !== 1) throw new Error("Subscription changed while applying webhook.");
        if (intent && input.payment && validPlanPayment) {
          await tx.paymentRecord.create({ data: { userId: subscription["userId"], providerPaymentId: input.payment.id, amountPaise: input.payment.amount, currency: input.payment.currency, status: input.payment.status, subscriptionIntentId: intent["id"], providerSubscriptionId: input.subscriptionId, createdAt: this.now() } });
        }
        if (intent && !(intent["status"] === "manual_review" && intent["amountPaise"] == null) && ["active", "cancelled", "completed", "expired"].includes(outcome.state.status)) {
          const intentStatus = outcome.state.status === "active" ? "active" : outcome.state.status === "cancelled" ? "cancelled" : "expired";
          await tx.razorpaySubscriptionIntent.updateMany({ where: { id: intent["id"], providerSubscriptionId: input.subscriptionId }, data: { status: intentStatus, updatedAt: this.now() } });
        }
        await tx.webhookEvent.update({ where: { providerEventId: input.providerEventId }, data: { status: "processed", processedAt: this.now() } });
        return "applied";
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "duplicate";
      throw error;
    }
  }

  async getCycle(cycleId: string): Promise<CycleRecord | null> { const row = await this.db.publishingCycle.findFirst({ where: { id: cycleId, deletedAt: null } }); return row ? rowToCycle(row) : null; }
  async countActiveCycles(userId: string): Promise<number> { return this.db.publishingCycle.count({ where: { ownerId: userId, deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } } }); }
  async createCycle(cycle: CycleRecord): Promise<void> { await this.db.publishingCycle.create({ data: cycleToRow(cycle) }); }
  async createCycleWithinLimit(cycle: CycleRecord, activeCycleLimit: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${cycle.ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedUser) || lockedUser.length === 0 || !Number.isInteger(activeCycleLimit) || activeCycleLimit < 1) return false;
      const active = await tx.publishingCycle.count({ where: { ownerId: cycle.ownerId, deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } } });
      if (active >= activeCycleLimit) return false;
      await tx.publishingCycle.create({ data: cycleToRow(cycle) });
      return true;
    });
  }
  async createCycleWithCollectionItemsWithinLimit(cycle: CycleRecord, items: CycleItem[], activeCycleLimit: number, expectedCollectionSettingsVersions: Record<string, number>): Promise<boolean> {
    if (!Number.isInteger(activeCycleLimit) || activeCycleLimit < 1 || cycle.status !== "draft" || cycle.finalReviewConfirmed || items.length === 0 ||
      items.some((item) => item.cycleId !== cycle.id || item.cycleOwnerId !== cycle.ownerId || item.status !== "upcoming" || item.scheduledFor !== null || !Number.isInteger(item.position) || item.position < 1) ||
      new Set(items.map((item) => item.id)).size !== items.length || new Set(items.map((item) => item.mediaAssetId)).size !== items.length || new Set(items.map((item) => item.position)).size !== items.length ||
      Object.values(expectedCollectionSettingsVersions).some((version) => !Number.isInteger(version) || version < 1) ||
      items.some((item) => !item.sourceCollectionId || !Object.hasOwn(expectedCollectionSettingsVersions, item.sourceCollectionId))) return false;
    return this.db.$transaction(async (tx) => {
      const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${cycle.ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedUser) || lockedUser.length !== 1) return false;
      const active = await tx.publishingCycle.count({ where: { ownerId: cycle.ownerId, deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } } });
      if (active >= activeCycleLimit) return false;
      for (const [collectionId, expectedVersion] of Object.entries(expectedCollectionSettingsVersions).sort(([a], [b]) => a.localeCompare(b))) {
        const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} FOR SHARE`;
        if (!Array.isArray(locked) || locked.length !== 1) return false;
        const collection = await tx.videoCollection.findUnique({ where: { id: collectionId }, select: { ownerId: true, archived: true, settingsVersion: true } });
        if (!collection || collection["archived"] === true || Number(collection["settingsVersion"]) !== expectedVersion) return false;
        if (collection["ownerId"] !== cycle.ownerId) {
          const grant = await tx.collectionPermission.findFirst({ where: { collectionId, granteeId: cycle.ownerId, status: "active", capabilities: { has: "use_in_cycle" }, OR: [{ expiresAt: null }, { expiresAt: { gt: cycle.createdAt } }] }, select: { id: true } });
          if (!grant) return false;
        }
      }
      for (const item of items) {
        const collectionId = item.sourceCollectionId as string;
        const membership = await tx.collectionItem.findFirst({ where: { collectionId, mediaAssetId: item.mediaAssetId }, select: { id: true } });
        const [collectionRow, mediaRow, grantRows] = await Promise.all([
          tx.videoCollection.findUnique({ where: { id: collectionId } }),
          tx.mediaAsset.findUnique({ where: { id: item.mediaAssetId } }),
          tx.collectionPermission.findMany({ where: { collectionId } }),
        ]);
        if (!membership || !collectionRow || !mediaRow) return false;
        const collection = rowToCollection(collectionRow, [item.mediaAssetId]);
        const media = rowToMedia(mediaRow);
        const grants = grantRows.map(rowToGrant);
        if (collection.archived || media.status !== "active" || media.kind !== "video" || !canAddVideoToCycle(cycle.ownerId, media, collection, grants, cycle.createdAt ?? new Date()).allowed) return false;
        const expectedSourceKind = media.ownerId !== cycle.ownerId ? "shared_reference" : media.importedFromId ? "imported_copy" : "owned";
        if (item.sourceKind !== expectedSourceKind) return false;
      }
      await tx.publishingCycle.create({ data: cycleToRow(cycle) });
      await tx.cycleItem.createMany({ data: items.map(itemToRow) });
      return true;
    });
  }
  async listRunningCyclesForSettlement(afterCycleId: string | null, limit: number): Promise<CycleRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return [];
    return (await this.db.publishingCycle.findMany({
      where: { status: "running", deletedAt: null, ...(afterCycleId === null ? {} : { id: { gt: afterCycleId } }) },
      orderBy: { id: "asc" }, take: limit,
    })).map(rowToCycle);
  }
  async completeSettledCycle(input: { cycleId: string; ownerId: string; now: Date; activeCycleLimit: number; newId: () => string }): Promise<import("../repository.ts").CompleteSettledCycleResult> {
    return this.db.$transaction(async (tx) => {
      // Shared order: User first, then PublishingCycle, then CycleItem/audit rows.
      const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedUser) || lockedUser.length === 0) return "not_found";
      const lockedCycle = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${input.cycleId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedCycle) || lockedCycle.length === 0) return "not_found";
      const row = await tx.publishingCycle.findUnique({ where: { id: input.cycleId } });
      if (!row || row["ownerId"] !== input.ownerId || row["deletedAt"] instanceof Date) return "not_found";
      if (row["status"] === "completed") return "already_completed";
      if (row["status"] !== "running") return "not_ready";

      const cycle = rowToCycle(row);
      const items = (await tx.cycleItem.findMany({ where: { cycleId: cycle.id }, orderBy: [{ position: "asc" }, { id: "asc" }] })).map(rowToItem);
      if (!isCycleFinished(items)) return "not_ready";
      const decision = decideSettledCycle(cycle, items, cycle.repeatBehavior ?? "never");
      const repeatedMediaIds = new Set<string>();
      const eligibleCandidates = decision === "repeat_without_published_items" ? itemsEligibleForRepeat(items).filter((item) => {
        if (repeatedMediaIds.has(item.mediaAssetId)) return false;
        repeatedMediaIds.add(item.mediaAssetId);
        return true;
      }) : [];
      const collectionIds = [...new Set(eligibleCandidates.flatMap((item) => item.sourceCollectionId ? [item.sourceCollectionId] : []))].sort();
      const validateRepeatCandidates = async (): Promise<CycleItem[]> => {
        const result: CycleItem[] = [];
        for (const item of eligibleCandidates) {
          if (!item.sourceCollectionId) continue;
          const collectionRow = await tx.videoCollection.findUnique({ where: { id: item.sourceCollectionId } });
          const membership = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: item.sourceCollectionId, mediaAssetId: item.mediaAssetId } }, select: { id: true } });
          const [mediaRow, grantRows] = await Promise.all([
            tx.mediaAsset.findUnique({ where: { id: item.mediaAssetId } }),
            tx.collectionPermission.findMany({ where: { collectionId: item.sourceCollectionId } }),
          ]);
          if (!collectionRow || !membership || !mediaRow) continue;
          const media = rowToMedia(mediaRow);
          const collection = rowToCollection(collectionRow, [media.id]);
          const grants = grantRows.map(rowToGrant);
          if (collection.archived || media.kind !== "video" || media.status !== "active" || !canAddVideoToCycle(cycle.ownerId, media, collection, grants, input.now).allowed) continue;
          const expectedSourceKind = media.ownerId !== cycle.ownerId ? "shared_reference" : media.importedFromId ? "imported_copy" : "owned";
          if (item.sourceKind === expectedSourceKind) result.push(item);
        }
        return result;
      };
      const withCollectionLocks = async (index: number): Promise<import("../repository.ts").CompleteSettledCycleResult> => {
        if (index < collectionIds.length) {
          const lockedCollection = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionIds[index]} FOR SHARE`;
          if (!Array.isArray(lockedCollection) || lockedCollection.length !== 1) return withCollectionLocks(index + 1);
          return withCollectionLocks(index + 1);
        }
        const eligible = await validateRepeatCandidates();

      const completed = await tx.publishingCycle.updateMany({ where: { id: cycle.id, ownerId: input.ownerId, status: "running", deletedAt: null }, data: { status: "completed" } });
      if (completed.count !== 1) return "already_completed";
      let nextCycle: CycleRecord | null = null;
      let nextItems: CycleItem[] = [];
      if (eligible.length > 0 && decision === "repeat_without_published_items") {
        const active = await tx.publishingCycle.count({ where: { ownerId: input.ownerId, status: { in: ACTIVE_CYCLE_STATUSES } } });
        if (active < input.activeCycleLimit) {
          nextCycle = { ...cycle, id: input.newId(), status: "draft", finalReviewConfirmed: false, createdAt: input.now };
          nextItems = eligible.map((item) => ({
            ...item, id: input.newId(), cycleId: nextCycle!.id, cycleOwnerId: cycle.ownerId, status: "upcoming", version: 1,
            scheduledFor: null, lockedBy: null, lockExpiresAt: null, reviewReason: null, externalPostId: null, publishedAt: null,
          }));
          await tx.publishingCycle.create({ data: cycleToRow(nextCycle) });
          await tx.cycleItem.createMany({ data: nextItems.map(itemToRow) });
        }
      }
      await tx.auditLog.create({ data: { actorId: null, action: "cycle.completed", entityType: "PublishingCycle", entityId: cycle.id, metadata: { items: items.length } } });
      if (nextCycle) {
        await tx.auditLog.create({ data: { actorId: null, action: "cycle.repeat_queued", entityType: "PublishingCycle", entityId: cycle.id, metadata: { nextCycleId: nextCycle.id, items: nextItems.length } } });
        return "repeat_queued";
      }
      if (eligible.length > 0 && decision === "repeat_without_published_items") {
        await tx.auditLog.create({ data: { actorId: null, action: "cycle.repeat_skipped", entityType: "PublishingCycle", entityId: cycle.id, metadata: { reason: "active_cycle_limit" } } });
        return "repeat_skipped_limit";
      }
      return "completed";
      };
      return withCollectionLocks(0);
    });
  }
  async transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean> {
    const result = await this.db.publishingCycle.updateMany({ where: { id: cycleId, status: from, deletedAt: null }, data: { status: to, finalReviewConfirmed } });
    return result.count === 1;
  }
  async stopCycle(cycleId: string, ownerId: string, from: CycleStatus, finalReviewConfirmed: boolean, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean> {
    const changedDuringStop = Symbol("cycle changed during stop");
    try {
      return await this.db.$transaction(async (tx) => {
        const cycle = await tx.publishingCycle.updateMany({ where: { id: cycleId, ownerId, status: from, deletedAt: null }, data: { status: "stopped", finalReviewConfirmed } });
        if (cycle.count !== 1) return false;
        for (const { item, expectedVersion } of updates) {
          const saved = await tx.cycleItem.updateMany({ where: { id: item.id, cycleId, cycleOwnerId: ownerId, mediaAssetId: item.mediaAssetId, sourceKind: item.sourceKind, sourceCollectionId: item.sourceCollectionId, selectedRenderOutputId: item.selectedRenderOutputId, version: expectedVersion, status: { in: ["upcoming", "scheduled"] } }, data: itemToMutableData(item) });
          if (saved.count !== 1) throw changedDuringStop;
        }
        return true;
      });
    } catch (error) {
      if (error === changedDuringStop) return false;
      throw error;
    }
  }
  async deletePublishingCycle(cycleId: string, ownerId: string, now: Date): Promise<import("../repository.ts").DeletePublishingCycleResult> {
    const changedDuringDelete = Symbol("publishing cycle changed during deletion");
    try {
      return await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${cycleId} AND "ownerId" = ${ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return "not_found";
      const cycle = await tx.publishingCycle.findUnique({ where: { id: cycleId } });
      if (!cycle || cycle["ownerId"] !== ownerId) return "not_found";
      if (cycle["deletedAt"] instanceof Date) return "already_deleted";

      // A heartbeat may renew a claimed lease without changing the cycle row.
      // Lock all attempts before evaluating leases so cancellation and heartbeat
      // either complete before this snapshot or observe the tombstone afterward.
      await tx.$queryRaw`SELECT "id" FROM "PublishingJob" WHERE "cycleId" = ${cycleId} ORDER BY "id" FOR UPDATE`;
      const jobs = await tx.publishingJob.findMany({ where: { cycleId } });
      if (jobs.some((job) => job["stage"] === "needs_manual_review" || job["outcome"] === "ambiguous")) return "ambiguous_outcome";
      const activeStages = new Set(["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"]);
      const activeJobs = jobs.filter((job) => activeStages.has(String(job["stage"])));
      const expiredClaimed = activeJobs.filter((job) => job["stage"] === "claimed" && job["leaseExpiresAt"] instanceof Date && job["leaseExpiresAt"] <= now);
      if (activeJobs.some((job) => !expiredClaimed.includes(job))) return "active_worker";

      const items = await tx.cycleItem.findMany({ where: { cycleId } });
      if (items.some((item) => item["status"] === "processing" || item["status"] === "needs_review")) return "processing";
      const expiredClaimItemIds = new Set(expiredClaimed.map((job) => String(job["cycleItemId"])));
      if (items.some((item) => item["status"] === "publishing" && !expiredClaimItemIds.has(String(item["id"])))) return "ambiguous_outcome";

      const expiredClaimPairs = expiredClaimed.map((job) => ({
        job,
        item: items.find((candidate) => candidate["id"] === job["cycleItemId"]),
      }));
      // Validate the complete set before writing anything. A normal return from
      // an interactive transaction commits, so finding a malformed later claim
      // inside the mutation loop could otherwise commit cancellations already
      // performed for earlier claims.
      if (expiredClaimPairs.some(({ job, item }) =>
        job["ownerId"] !== ownerId || job["cycleId"] !== cycleId || job["stage"] !== "claimed" ||
        !(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] > now ||
        typeof job["workerId"] !== "string" || !job["workerId"] ||
        typeof job["lockToken"] !== "string" || !job["lockToken"] ||
        !item || item["cycleId"] !== cycleId || item["cycleOwnerId"] !== ownerId ||
        item["status"] !== "publishing" || item["lockedBy"] !== job["workerId"]
      )) return "conflict";

      for (const { job, item } of expiredClaimPairs) {
        // The full validation above guarantees an item for every pair.
        if (!item) throw changedDuringDelete;
        const itemUpdate = await tx.cycleItem.updateMany({ where: { id: item["id"], cycleId, status: "publishing", lockedBy: job["workerId"], version: item["version"] }, data: { status: "cancelled", scheduledFor: null, lockedBy: null, lockExpiresAt: null, version: { increment: 1 } } });
        if (itemUpdate.count !== 1) throw changedDuringDelete;
        const jobUpdate = await tx.publishingJob.updateMany({ where: { id: job["id"], ownerId, cycleId, stage: "claimed", workerId: job["workerId"], lockToken: job["lockToken"], leaseExpiresAt: { lte: now } }, data: { stage: "cancelled", workerId: null, lockToken: null, leaseExpiresAt: null, updatedAt: now, finishedAt: now } });
        if (jobUpdate.count !== 1) throw changedDuringDelete;
      }
      await tx.publishingJob.updateMany({ where: { cycleId, stage: "queued" }, data: { stage: "cancelled", workerId: null, lockToken: null, leaseExpiresAt: null, updatedAt: now, finishedAt: now } });
      await tx.cycleItem.updateMany({ where: { cycleId, status: { in: ["upcoming", "scheduled"] } }, data: { status: "cancelled", scheduledFor: null, version: { increment: 1 } } });
      const changed = await tx.publishingCycle.updateMany({ where: { id: cycleId, ownerId, deletedAt: null }, data: { deletedAt: now, status: "stopped", updatedAt: now } });
      if (changed.count !== 1) throw changedDuringDelete;
      await tx.auditLog.create({ data: { actorId: ownerId, action: "cycle.deleted", entityType: "PublishingCycle", entityId: cycleId, metadata: { cancelledQueuedAttempts: jobs.filter((job) => job["stage"] === "queued").length, retainedPublishedHistory: true } } });
      return "deleted";
      });
    } catch (error) {
      if (error === changedDuringDelete) return "conflict";
      throw error;
    }
  }
  async listCyclesForOwner(userId: string): Promise<CycleRecord[]> { return (await this.db.publishingCycle.findMany({ where: { ownerId: userId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })).map(rowToCycle); }

  async getCycleItems(cycleId: string): Promise<CycleItem[]> { return (await this.db.cycleItem.findMany({ where: { cycleId }, orderBy: [{ position: "asc" }, { id: "asc" }] })).map(rowToItem); }
  async addCycleItems(items: CycleItem[], expectedCollectionSettingsVersions: Record<string, number> = {}, orderUpdates: { item: CycleItem; expectedVersion: number }[] = [], now = new Date(), confirmedDuplicateMediaIds: string[] = []): Promise<boolean> {
    if (items.length === 0) return true;
    const cycleId = items[0]!.cycleId;
    const ownerId = items[0]!.cycleOwnerId;
    if (items.some((item) => item.cycleId !== cycleId || item.cycleOwnerId !== ownerId || !item.sourceCollectionId || !Object.hasOwn(expectedCollectionSettingsVersions, item.sourceCollectionId) || (item.status !== "upcoming" && item.status !== "scheduled")) || new Set(items.map((item) => item.id)).size !== items.length) return false;
    const collectionIds = [...new Set(items.map((item) => item.sourceCollectionId as string))].sort();
    const confirmedDuplicates = new Set(confirmedDuplicateMediaIds);
    const mediaIds = [...new Set(items.map((item) => item.mediaAssetId))];
    const incomingCounts = new Map<string, number>();
    for (const item of items) incomingCounts.set(item.mediaAssetId, (incomingCounts.get(item.mediaAssetId) ?? 0) + 1);
    if ([...incomingCounts].some(([mediaId, count]) => count > 1 && !confirmedDuplicates.has(mediaId))) return false;
    const orderConflict = Symbol("cycle item order changed during import");
    const insertConflict = Symbol("cycle item already exists during import");
    try { return await this.db.$transaction(async (tx) => {
      // Lock the parent so item insertion serializes with completion/stopping.
      const lockedCycle = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${cycleId} AND "ownerId" = ${ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedCycle) || lockedCycle.length === 0) return false;
      const cycle = await tx.publishingCycle.findUnique({ where: { id: cycleId } });
      if (!cycle || cycle["deletedAt"] instanceof Date || cycle["ownerId"] !== ownerId || cycle["status"] === "completed" || cycle["status"] === "stopped") return false;
      // The handler's earlier duplicate scan can be stale. The parent lock
      // serializes adders, so recheck active media here before ordering/inserting.
      const existingItems = await tx.cycleItem.findMany({ where: { cycleId, mediaAssetId: { in: mediaIds }, status: { not: "cancelled" } }, select: { mediaAssetId: true } });
      if (existingItems.some((item) => !confirmedDuplicates.has(String(item["mediaAssetId"])))) return false;
      for (const collectionId of [...new Set([...Object.keys(expectedCollectionSettingsVersions), ...collectionIds])].sort()) {
        const lockedCollection = await tx.$queryRaw`SELECT "settingsVersion" FROM "VideoCollection" WHERE "id" = ${collectionId} FOR SHARE`;
        if (!Array.isArray(lockedCollection) || lockedCollection.length !== 1 || Number(lockedCollection[0]?.["settingsVersion"]) !== expectedCollectionSettingsVersions[collectionId]) return false;
      }
      // Validate source collection, membership, current permission, video eligibility and source
      // provenance before changing any existing item order. Membership/permission writers lock
      // the same collection row, so this check is serialized with their changes.
      for (const item of items) {
        const collectionId = item.sourceCollectionId as string;
        const [collectionRow, membership, mediaRow, grantRows] = await Promise.all([
          tx.videoCollection.findUnique({ where: { id: collectionId } }),
          tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId, mediaAssetId: item.mediaAssetId } } }),
          tx.mediaAsset.findUnique({ where: { id: item.mediaAssetId } }),
          tx.collectionPermission.findMany({ where: { collectionId } }),
        ]);
        if (!collectionRow || !membership || !mediaRow) return false;
        const media = rowToMedia(mediaRow);
        const collection = rowToCollection(collectionRow, [item.mediaAssetId]);
        const grants = grantRows.map(rowToGrant);
        if (collection.archived || media.status !== "active" || media.kind !== "video" || !canAddVideoToCycle(ownerId, media, collection, grants, now).allowed) return false;
        const expectedSourceKind = media.ownerId !== ownerId ? "shared_reference" : media.importedFromId ? "imported_copy" : "owned";
        if (item.sourceKind !== expectedSourceKind) return false;
      }
      for (const { item, expectedVersion } of orderUpdates) {
        if (item.cycleId !== cycleId || item.cycleOwnerId !== ownerId || (item.status !== "upcoming" && item.status !== "scheduled")) return false;
        const saved = await tx.cycleItem.updateMany({
          where: { id: item.id, cycleId, cycleOwnerId: ownerId, version: expectedVersion, status: { in: ["upcoming", "scheduled"] } },
          data: { position: item.position, version: item.version },
        });
        if (saved.count !== 1) throw orderConflict;
      }
      try { await tx.cycleItem.createMany({ data: items.map(itemToRow) }); return true; }
      catch (error) { if (isUniqueViolation(error)) throw insertConflict; throw error; }
    }); } catch (error) { if (error === orderConflict || error === insertConflict) return false; throw error; }
  }
  async saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]> {
    const results = new Map<string, boolean>();
    const groups = new Map<string, typeof updates>();
    for (const update of updates) groups.set(update.item.cycleId, [...(groups.get(update.item.cycleId) ?? []), update]);
    for (const [cycleId, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      await this.db.$transaction(async (tx) => {
        const cycleBeforeLock = await tx.publishingCycle.findUnique({ where: { id: cycleId }, select: { ownerId: true } });
        const ownerId = typeof cycleBeforeLock?.["ownerId"] === "string" ? cycleBeforeLock["ownerId"] : null;
        if (!ownerId || group.some(({ item }) => item.cycleOwnerId !== ownerId)) {
          for (const { item } of group) results.set(item.id, false);
          return;
        }
        // A deletion and a cover assignment both lock the target MediaAsset before
        // either can commit. Acquire new cover rows before the cycle row for stable ordering.
        const storedItems = await tx.cycleItem.findMany({ where: { id: { in: group.map(({ item }) => item.id) }, cycleId }, select: { id: true, coverMediaId: true } });
        const storedCoverByItem = new Map(storedItems.map((row) => [String(row["id"]), row["coverMediaId"] as string | null ?? null]));
        const newlyReferencedMediaIds = group.flatMap(({ item }) => item.coverMediaId && storedCoverByItem.get(item.id) !== item.coverMediaId ? [item.coverMediaId] : []);
        const activeCoverIds = await lockActiveOwnedMediaRows(tx, ownerId, newlyReferencedMediaIds);
        const invalidCoverItemIds = new Set(group.filter(({ item }) => item.coverMediaId !== null && storedCoverByItem.get(item.id) !== item.coverMediaId && !activeCoverIds.has(item.coverMediaId)).map(({ item }) => item.id));
        const locked = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${cycleId} AND "ownerId" = ${ownerId} FOR UPDATE`;
        const cycle = Array.isArray(locked) && locked.length === 1 ? await tx.publishingCycle.findUnique({ where: { id: cycleId }, select: { ownerId: true, deletedAt: true } }) : null;
        for (const { item, expectedVersion } of group) {
          if (!cycle || cycle["deletedAt"] instanceof Date || cycle["ownerId"] !== item.cycleOwnerId || invalidCoverItemIds.has(item.id)) { results.set(item.id, false); continue; }
          const outcome = await tx.cycleItem.updateMany({ where: { id: item.id, cycleId, cycleOwnerId: item.cycleOwnerId, mediaAssetId: item.mediaAssetId, sourceKind: item.sourceKind, sourceCollectionId: item.sourceCollectionId, selectedRenderOutputId: item.selectedRenderOutputId, version: expectedVersion }, data: itemToMutableData(item) });
          results.set(item.id, outcome.count === 1);
        }
      });
    }
    return updates.map(({ item }) => ({ itemId: item.id, saved: results.get(item.id) ?? false }));
  }
  async selectCycleItemRenderOutput(input: SelectCycleItemRenderOutputInput): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const lockedCycle = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${input.cycleId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedCycle) || lockedCycle.length !== 1) return false;
      const cycle = await tx.publishingCycle.findUnique({ where: { id: input.cycleId } });
      if (!cycle || cycle["deletedAt"] instanceof Date || cycle["ownerId"] !== input.ownerId || cycle["status"] !== "draft") return false;
      const item = await tx.cycleItem.findUnique({ where: { id: input.itemId } });
      if (!item || item["cycleId"] !== input.cycleId || item["cycleOwnerId"] !== input.ownerId || item["version"] !== input.expectedVersion || (item["status"] !== "upcoming" && item["status"] !== "scheduled")) return false;
      if (input.renderOutputId !== null) {
        const output = await tx.mediaDerivative.findUnique({ where: { id: input.renderOutputId } });
        if (!output || output["kind"] !== "render" || output["ownerId"] !== input.ownerId || output["mediaAssetId"] !== item["mediaAssetId"]) return false;
      }
      const result = await tx.cycleItem.updateMany({
        where: { id: item["id"], cycleId: input.cycleId, cycleOwnerId: input.ownerId, version: input.expectedVersion, status: { in: ["upcoming", "scheduled"] } },
        data: {
          selectedRenderOutputId: input.renderOutputId,
          selectedRenderOwnerId: input.renderOutputId === null ? null : input.ownerId,
          selectedRenderSourceMediaId: input.renderOutputId === null ? null : item["mediaAssetId"],
          version: input.expectedVersion + 1,
        },
      });
      return result.count === 1;
    });
  }

  async saveCycleSchedule(cycleId: string, ownerId: string, scheduleSettings: PersistedCycleSchedule, updates: { item: CycleItem; expectedVersion: number }[]): Promise<boolean> {
    const changedDuringSave = Symbol("cycle schedule changed during save");
    try {
      return await this.db.$transaction(async (tx) => {
        const cycle = await tx.publishingCycle.updateMany({
          where: { id: cycleId, ownerId, status: "draft", deletedAt: null },
          data: { scheduleSettings, timezone: scheduleSettings.timeZone, orderMode: scheduleSettings.orderMode ?? "manual" },
        });
        if (cycle.count !== 1) return false;
        for (const { item, expectedVersion } of updates) {
          const saved = await tx.cycleItem.updateMany({
            where: { id: item.id, cycleId, cycleOwnerId: ownerId, mediaAssetId: item.mediaAssetId, sourceKind: item.sourceKind, sourceCollectionId: item.sourceCollectionId, selectedRenderOutputId: item.selectedRenderOutputId, version: expectedVersion, status: { in: ["upcoming", "scheduled"] } },
            data: itemToMutableData(item),
          });
          if (saved.count !== 1) throw changedDuringSave;
        }
        return true;
      });
    } catch (error) {
      if (error === changedDuringSave) return false;
      throw error;
    }
  }

  async getMedia(mediaId: string): Promise<MediaAsset | null> { const row = await this.db.mediaAsset.findUnique({ where: { id: mediaId } }); return row ? rowToMedia(row) : null; }
  async getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]> { return mediaIds.length === 0 ? [] : (await this.db.mediaAsset.findMany({ where: { id: { in: mediaIds } } })).map(rowToMedia); }
  async listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image"; search?: string; sort?: MediaSort }): Promise<{ items: MediaAsset[]; total: number }> {
    const where = { ownerId: userId, status: { not: "deleted" }, ...(page.kind ? { kind: page.kind } : {}), ...(page.search ? { originalFilename: { contains: page.search, mode: "insensitive" } } : {}) };
    const tie = { id: "asc" as const };
    const orderBy = page.sort === "oldest" ? [{ createdAt: "asc" as const }, tie] : page.sort === "name" ? [{ originalFilename: "asc" as const }, tie] : page.sort === "size" ? [{ sizeBytes: "desc" as const }, tie] : [{ createdAt: "desc" as const }, tie];
    const [rows, total] = await Promise.all([this.db.mediaAsset.findMany({ where, orderBy, skip: page.offset, take: page.limit }), this.db.mediaAsset.count({ where })]);
    return { items: rows.map(rowToMedia), total };
  }
  async getStorageUsedBytes(userId: string): Promise<number> {
    const [mediaSum, renderSum] = await Promise.all([
      this.db.mediaAsset.aggregate({ where: { ownerId: userId, status: { not: "deleted" } }, _sum: { sizeBytes: true } }),
      this.db.mediaDerivative.aggregate({ where: { ownerId: userId, kind: "render" }, _sum: { sizeBytes: true } }),
    ]);
    return Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0);
  }

  async addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      // Lock this user's row so two uploads by the same user are checked one after the other.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${media.ownerId} FOR UPDATE`;
      const sum = await tx.mediaAsset.aggregate({ where: { ownerId: media.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
      if (Number(sum._sum["sizeBytes"] ?? 0) + media.sizeBytes > limitBytes) return false;
      await tx.mediaAsset.create({ data: mediaToRow(media, keys) });
      return true;
    });
  }
  async addMediaWithVerificationJobIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, job: MediaVerificationJobRecord, audit: AuditEntry, limitBytes: number, collectionId?: string): Promise<boolean | "collection_unavailable"> {
    const idempotencyKey = `media-verification:${media.id}`;
    if (media.validation !== "incomplete" || job.ownerId !== media.ownerId || job.mediaAssetId !== media.id || job.status !== "queued" || job.idempotencyKey !== idempotencyKey) return false;
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${media.ownerId} FOR UPDATE`;
        if (collectionId) {
          const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} AND "ownerId" = ${media.ownerId} FOR UPDATE`;
          if (!Array.isArray(locked) || locked.length !== 1) return "collection_unavailable";
          const collection = await tx.videoCollection.findFirst({ where: { id: collectionId, ownerId: media.ownerId, archived: false }, select: { id: true } });
          if (!collection) return "collection_unavailable";
        }
        const sum = await tx.mediaAsset.aggregate({ where: { ownerId: media.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
        if (Number(sum._sum["sizeBytes"] ?? 0) + media.sizeBytes > limitBytes) return false;
        if (await tx.processingJob.findUnique({ where: { idempotencyKey } })) return false;
        await tx.mediaAsset.create({ data: mediaToRow(media, keys) });
        if (collectionId) {
          const position = await tx.collectionItem.count({ where: { collectionId } }) + 1;
          await tx.collectionItem.create({ data: { id: randomUUID(), collectionId, mediaAssetId: media.id, position, captionText: "", coverMediaId: null, version: 1 } });
          await tx.videoCollection.update({ where: { id: collectionId }, data: { settingsVersion: { increment: 1 } } });
          await tx.auditLog.create({ data: { actorId: media.ownerId, action: "collection.item_added", entityType: "CollectionItem", entityId: `${collectionId}:${media.id}`, metadata: { collectionId, mediaAssetId: media.id, source: "collection_upload" } } });
        }
        await tx.processingJob.create({ data: { id: job.id, ownerId: job.ownerId, kind: "media_verification", status: "queued", cycleItemId: null, mediaAssetId: job.mediaAssetId, progressPercent: 0, attempts: 0, idempotencyKey, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: job.createdAt, finishedAt: null, settingsHash: null, payload: job.payload, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null } });
        await tx.auditLog.create({ data: { actorId: audit.actorId, action: audit.action, entityType: audit.entityType, entityId: audit.entityId, metadata: audit.metadata ?? null } });
        return true;
      });
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; }
  }
  async getMediaVerificationForOwner(ownerId: string, mediaId: string) {
    const media = await this.db.mediaAsset.findFirst({ where: { id: mediaId, ownerId, status: { not: "deleted" } }, select: { id: true } });
    if (!media) return null;
    const row = await this.db.processingJob.findUnique({ where: { idempotencyKey: `media-verification:${mediaId}` } });
    return mediaVerificationStateFromJob(row ? mediaVerificationJobFromRow(row) : undefined, mediaId);
  }
  async listMediaVerificationsForOwner(ownerId: string, mediaIds: string[]) {
    const ids = [...new Set(mediaIds)]; if (ids.length === 0) return [];
    const [mediaRows, jobRows] = await Promise.all([
      this.db.mediaAsset.findMany({ where: { id: { in: ids }, ownerId, status: { not: "deleted" } }, select: { id: true } }),
      this.db.processingJob.findMany({ where: { ownerId, mediaAssetId: { in: ids }, kind: "media_verification" } }),
    ]);
    const jobs = new Map(jobRows.map((row) => { const job = mediaVerificationJobFromRow(row); return [job.mediaAssetId, job] as const; }));
    const owned = new Set(mediaRows.map((row) => String(row["id"])));
    return ids.filter((id) => owned.has(id)).map((id) => mediaVerificationStateFromJob(jobs.get(id), id));
  }
  async retryMediaVerification(ownerId: string, mediaId: string, now: Date): Promise<"queued" | "existing" | "missing" | "not_retryable"> {
    const media = await this.db.mediaAsset.findFirst({ where: { id: mediaId, ownerId, status: { not: "deleted" } }, select: { id: true } });
    if (!media) return "missing";
    const row = await this.db.processingJob.findUnique({ where: { idempotencyKey: `media-verification:${mediaId}` } });
    if (!row || row["ownerId"] !== ownerId || row["kind"] !== "media_verification") return "not_retryable";
    const job = mediaVerificationJobFromRow(row);
    if (job.status === "queued" || job.status === "running") return "existing";
    const payload = typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : {};
    if (job.status !== "failed" || payload["retryable"] !== true || job.attempts >= 6) return "not_retryable";
    const result = await this.db.processingJob.updateMany({ where: { id: job.id, ownerId, kind: "media_verification", status: "failed", attempts: job.attempts }, data: { status: "queued", progressPercent: 0, lockedBy: null, lockToken: null, lockExpiresAt: null, finishedAt: null, errorMessage: null, payload: { ...payload, stage: "queued", outcome: "processing", errorCode: null, retryable: false, updatedAt: now.toISOString() } } });
    return result.count === 1 ? "queued" : "existing";
  }
  async claimNextMediaVerificationJob(claim: MediaVerificationClaim): Promise<MediaVerificationJobRecord | null> {
    if (!claim.workerId || !Number.isFinite(claim.leaseSeconds) || claim.leaseSeconds <= 0) return null;
    return this.db.$transaction(async (tx) => {
      const exhausted = await tx.processingJob.findMany({ where: { kind: "media_verification", status: "running", attempts: { gte: 6 }, lockExpiresAt: { lte: claim.now }, ...(claim.jobId ? { id: claim.jobId } : {}) }, take: 50 });
      for (const row of exhausted) await tx.processingJob.updateMany({ where: { id: row["id"], status: "running", lockToken: row["lockToken"], lockExpiresAt: { lte: claim.now } }, data: { status: "failed", finishedAt: claim.now, lockedBy: null, lockToken: null, lockExpiresAt: null, errorMessage: "Verification worker stopped before completing." , payload: { stage: "storage_verifying", outcome: "failed", errorCode: "worker_interrupted", retryable: false, updatedAt: claim.now.toISOString(), completedStages: [] } } });
      const candidates = await tx.processingJob.findMany({ where: { kind: "media_verification", attempts: { lt: 6 }, OR: [{ status: "queued", OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lte: claim.now } }] }, { status: "running", lockExpiresAt: { lte: claim.now } }], ...(claim.jobId ? { id: claim.jobId } : {}) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50 });
      for (const row of candidates) {
        const old = mediaVerificationJobFromRow(row); const lockToken = randomUUID();
        const updated = await tx.processingJob.updateMany({ where: { id: old.id, ownerId: old.ownerId, kind: "media_verification", status: old.status, lockToken: old.lockToken, ...(old.status === "running" ? { lockExpiresAt: { lte: claim.now } } : {}), attempts: old.attempts }, data: { status: "running", lockedBy: claim.workerId, lockToken, lockExpiresAt: new Date(claim.now.getTime() + claim.leaseSeconds * 1000), attempts: { increment: 1 } } });
        if (updated.count !== 1) continue;
        const claimed = await tx.processingJob.findFirst({ where: { id: old.id, ownerId: old.ownerId, status: "running", lockToken } });
        if (claimed) return mediaVerificationJobFromRow(claimed);
      }
      return null;
    });
  }
  async updateMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; now: Date; leaseSeconds: number; payload: unknown }): Promise<boolean> {
    if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) return false;
    const result = await this.db.processingJob.updateMany({ where: { id: input.id, ownerId: input.ownerId, kind: "media_verification", status: "running", lockToken: input.lockToken }, data: { payload: input.payload, lockExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000) } });
    return result.count === 1;
  }
  async completeMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; finishedAt: Date; payload: unknown; width: number; height: number; durationMs: number | null }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const job = await tx.processingJob.findFirst({ where: { id: input.id, ownerId: input.ownerId, kind: "media_verification", status: "running", lockToken: input.lockToken } });
      if (!job) return false;
      const media = await tx.mediaAsset.findFirst({ where: { id: job["mediaAssetId"], ownerId: input.ownerId, status: "active" }, select: { id: true } });
      if (!media) return false;
      const updated = await tx.processingJob.updateMany({ where: { id: input.id, ownerId: input.ownerId, kind: "media_verification", status: "running", lockToken: input.lockToken }, data: { status: "succeeded", progressPercent: 100, finishedAt: input.finishedAt, payload: input.payload, errorMessage: null, lockToken: null, lockedBy: null, lockExpiresAt: null } });
      if (updated.count !== 1) return false;
      await tx.mediaAsset.update({ where: { id: job["mediaAssetId"] }, data: { metadataValidated: true, width: input.width, height: input.height, durationMs: input.durationMs } });
      return true;
    });
  }
  async failMediaVerificationJob(input: { id: string; ownerId: string; lockToken: string; now: Date; payload: unknown; errorMessage: string; retryAt?: Date }): Promise<boolean> {
    const result = await this.db.processingJob.updateMany({ where: { id: input.id, ownerId: input.ownerId, kind: "media_verification", status: "running", lockToken: input.lockToken }, data: { status: input.retryAt ? "queued" : "failed", progressPercent: 0, finishedAt: input.retryAt ? null : input.now, lockExpiresAt: input.retryAt ?? null, payload: input.payload, errorMessage: input.errorMessage.slice(0, 200), lockToken: null, lockedBy: null } });
    return result.count === 1;
  }
  async getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null> {
    const row = await this.db.mediaAsset.findUnique({ where: { id: mediaId } });
    return row ? { storageKey: row["storageKey"], thumbnailKey: row["thumbnailKey"] ?? null, mimeType: row["mimeType"] ?? null } : null;
  }

  async createOrGetEditedMediaReplacement(input: EditedReplacementRequest) {
    const idempotencyKey = `edited-replacement:${input.ownerId}:${input.sourceMediaAssetId}:${input.sourceDerivativeId}`;
    if (input.idempotencyKey !== idempotencyKey) return { status: "conflict" as const };
    try {
      return await this.db.$transaction(async (tx) => {
        if (!(await lockedUsers(tx, [input.ownerId]))) return { status: "missing" as const };
        const prior = await tx.editedMediaReplacement.findUnique({ where: { idempotencyKey } });
        if (prior) return prior["ownerId"] === input.ownerId && prior["sourceMediaAssetId"] === input.sourceMediaAssetId && prior["sourceDerivativeId"] === input.sourceDerivativeId
          ? { status: "existing" as const, job: editedReplacementFromRow(prior) } : { status: "conflict" as const };
        if (await tx.mediaAsset.findUnique({ where: { id: input.plannedReplacementMediaAssetId } }) || await tx.editedMediaReplacement.findUnique({ where: { plannedReplacementMediaAssetId: input.plannedReplacementMediaAssetId } })) return { status: "conflict" as const };
        const sourceLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${input.sourceMediaAssetId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(sourceLock) || sourceLock.length !== 1) return { status: "missing" as const };
        const sourceRow = await tx.mediaAsset.findFirst({ where: { id: input.sourceMediaAssetId, ownerId: input.ownerId } });
        const outputRow = await tx.mediaDerivative.findFirst({ where: { id: input.sourceDerivativeId, mediaAssetId: input.sourceMediaAssetId, ownerId: input.ownerId, kind: "render" } });
        const render = await tx.processingJob.findFirst({ where: { ownerId: input.ownerId, kind: "render", status: "succeeded", mediaAssetId: input.sourceMediaAssetId, outputDerivativeId: input.sourceDerivativeId } });
        if (!sourceRow || !outputRow || !render) return { status: "missing" as const };
        const source = rowToMedia(sourceRow);
        if (source.status !== "active" || source.validation !== "verified" || source.kind !== "video") return { status: "not_verified" as const };
        const memberships = await tx.collectionItem.findMany({ where: { mediaAssetId: source.id }, select: { id: true, collectionId: true, version: true }, orderBy: [{ collectionId: "asc" }, { id: "asc" }] });
        const collectionIds = [...new Set(memberships.map((row) => String(row["collectionId"])))].sort();
        for (const collectionId of collectionIds) {
          const lock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
          if (!Array.isArray(lock) || lock.length !== 1) return { status: "unauthorized" as const };
        }
        const lockedMemberships = await tx.collectionItem.findMany({ where: { mediaAssetId: source.id }, select: { id: true, collectionId: true, version: true } });
        if (JSON.stringify(lockedMemberships.map((row) => [String(row["id"]), String(row["collectionId"]), Number(row["version"])]).sort()) !== JSON.stringify(memberships.map((row) => [String(row["id"]), String(row["collectionId"]), Number(row["version"])]).sort())) return { status: "conflict" as const };
        const covers = await Promise.all([
          tx.videoCollection.count({ where: { sharedCoverMediaId: source.id } }), tx.collectionItem.count({ where: { coverMediaId: source.id } }), tx.cycleItem.count({ where: { coverMediaId: source.id } }),
        ]);
        const activeCycles = await tx.cycleItem.findMany({ where: { mediaAssetId: source.id, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { id: true } });
        const imports = await tx.mediaImportJob.findMany({ where: { sourceMediaId: source.id, status: { in: ["pending", "copying", "verifying"] } }, select: { id: true } });
        const renders = await tx.processingJob.findMany({ where: { mediaAssetId: source.id, kind: "render", status: { in: ["queued", "running"] } }, select: { id: true } });
        if (covers.some(Boolean) || activeCycles.length || imports.length || renders.length) return { status: "dependency" as const };
        let planId: PlanId;
        try { planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, true); }
        catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, false); }
        const [mediaSum, renderSum] = await Promise.all([
          tx.mediaAsset.aggregate({ where: { ownerId: input.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } }),
          tx.mediaDerivative.aggregate({ where: { ownerId: input.ownerId, kind: "render" }, _sum: { sizeBytes: true } }),
        ]);
        const outputSize = Number(outputRow["sizeBytes"]);
        if (!Number.isSafeInteger(outputSize) || outputSize <= 0 || Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + outputSize > getPlan(planId).limits.storageBytes) return { status: "quota" as const };
        const row = await tx.editedMediaReplacement.create({ data: {
          id: input.id, ownerId: input.ownerId, sourceMediaAssetId: source.id, sourceDerivativeId: String(outputRow["id"]), plannedReplacementMediaAssetId: input.plannedReplacementMediaAssetId,
          replacementMediaAssetId: null, stagingObjectKey: null, status: "queued", idempotencyKey, membershipSnapshot: memberships.map((item) => ({ id: String(item["id"]), collectionId: String(item["collectionId"]), version: Number(item["version"]) })),
          attempts: 0, lockedBy: null, lockToken: null, lockExpiresAt: null, errorCode: null, createdAt: input.now, updatedAt: input.now, completedAt: null,
        } });
        await tx.auditLog.create({ data: { actorId: input.ownerId, action: "media.edited_replacement_requested", entityType: "EditedMediaReplacement", entityId: input.id, metadata: { sourceMediaAssetId: source.id, sourceDerivativeId: String(outputRow["id"]) } } });
        return { status: "created" as const, job: editedReplacementFromRow(row) };
      });
    } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" as const }; throw error; }
  }

  async getEditedMediaReplacementForOwner(ownerId: string, sourceMediaAssetId: string, sourceDerivativeId: string) {
    const row = await this.db.editedMediaReplacement.findFirst({ where: { ownerId, sourceMediaAssetId, sourceDerivativeId } });
    return row ? editedReplacementFromRow(row) : null;
  }

  async claimNextEditedMediaReplacement(input: EditedReplacementClaim) {
    if (!input.workerId || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) return null;
    return this.db.$transaction(async (tx) => {
      const candidates = await tx.editedMediaReplacement.findMany({ where: { ...(input.jobId ? { id: input.jobId } : {}), OR: [{ status: "queued", OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lte: input.now } }] }, { status: { in: ["copying", "verifying"] }, lockExpiresAt: { lte: input.now } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 50 });
      for (const candidate of candidates) {
        if (!(await lockedUsers(tx, [String(candidate["ownerId"])]))) continue;
        const lock = await tx.$queryRaw`SELECT "id" FROM "EditedMediaReplacement" WHERE "id" = ${String(candidate["id"])} FOR UPDATE`;
        if (!Array.isArray(lock) || lock.length !== 1) continue;
        const current = await tx.editedMediaReplacement.findUnique({ where: { id: candidate["id"] } }); if (!current) continue;
        const active = (current["status"] === "queued" && (!(current["lockExpiresAt"] instanceof Date) || current["lockExpiresAt"] <= input.now)) || (["copying", "verifying"].includes(String(current["status"])) && current["lockExpiresAt"] instanceof Date && current["lockExpiresAt"] <= input.now);
        if (!active) continue;
        const token = randomUUID(); const attempt = Number(current["attempts"] ?? 0) + 1;
        const stage = stagingKeyFor(`replacement-${String(current["id"])}-${attempt}-${token.slice(0, 8)}`);
        const updated = await tx.editedMediaReplacement.updateMany({ where: { id: current["id"], status: current["status"], lockToken: current["lockToken"] ?? null, lockExpiresAt: current["lockExpiresAt"] ?? null }, data: { status: current["replacementMediaAssetId"] ? "verifying" : "copying", lockedBy: input.workerId, lockToken: token, lockExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000), attempts: { increment: 1 }, stagingObjectKey: stage, errorCode: null, updatedAt: input.now } });
        if (updated.count !== 1) continue;
        const row = await tx.editedMediaReplacement.findUnique({ where: { id: current["id"] } }); if (row) return editedReplacementFromRow(row);
      }
      return null;
    });
  }

  async heartbeatEditedMediaReplacement(input: { jobId: string; ownerId: string; lockToken: string; now: Date; leaseSeconds: number; stagingObjectKey?: string }) {
    const changed = await this.db.editedMediaReplacement.updateMany({ where: { id: input.jobId, ownerId: input.ownerId, status: { in: ["copying", "verifying"] }, lockToken: input.lockToken, lockExpiresAt: { gt: input.now } }, data: { lockExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000), updatedAt: input.now, ...(input.stagingObjectKey ? { stagingObjectKey: input.stagingObjectKey } : {}) } });
    return changed.count === 1;
  }

  async commitEditedMediaReplacement(input: EditedReplacementCommitInput): Promise<EditedReplacementCommitResult> {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.editedMediaReplacement.findUnique({ where: { id: input.jobId } }); if (!initial) return "stale";
      if (!(await lockedUsers(tx, [input.ownerId]))) return "unauthorized";
      const sourceLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${String(initial["sourceMediaAssetId"])} FOR UPDATE`;
      const replacementLock = await tx.$queryRaw`SELECT "id" FROM "EditedMediaReplacement" WHERE "id" = ${input.jobId} FOR UPDATE`;
      if (!Array.isArray(sourceLock) || sourceLock.length !== 1 || !Array.isArray(replacementLock) || replacementLock.length !== 1) return "stale";
      const job = await tx.editedMediaReplacement.findUnique({ where: { id: input.jobId } }); const source = await tx.mediaAsset.findFirst({ where: { id: initial["sourceMediaAssetId"], ownerId: input.ownerId } });
      const output = await tx.mediaDerivative.findFirst({ where: { id: initial["sourceDerivativeId"], ownerId: input.ownerId, mediaAssetId: initial["sourceMediaAssetId"], kind: "render" } });
      if (!job || !source || !output || job["ownerId"] !== input.ownerId || job["lockToken"] !== input.lockToken || !(job["lockExpiresAt"] instanceof Date) || job["lockExpiresAt"] <= input.now || !["copying", "verifying"].includes(String(job["status"]))) return "stale";
      if (input.media.ownerId !== input.ownerId || input.media.id !== job["plannedReplacementMediaAssetId"] || input.media.validation !== "incomplete" || input.media.sizeBytes !== Number(output["sizeBytes"]) || input.storageKey !== mediaKeyFor(input.ownerId, input.media.id) || input.verificationJob.ownerId !== input.ownerId || input.verificationJob.mediaAssetId !== input.media.id || input.verificationJob.status !== "queued" || input.verificationJob.idempotencyKey !== `media-verification:${input.media.id}`) return "unauthorized";
      const existingAsset = await tx.mediaAsset.findUnique({ where: { id: input.media.id } });
      if (existingAsset) return job["replacementMediaAssetId"] === input.media.id ? "existing" : "conflict";
      let planId: PlanId;
      try { planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, true); }
      catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, false); }
      const [mediaSum, renderSum] = await Promise.all([
        tx.mediaAsset.aggregate({ where: { ownerId: input.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } }), tx.mediaDerivative.aggregate({ where: { ownerId: input.ownerId, kind: "render" }, _sum: { sizeBytes: true } }),
      ]);
      if (Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + input.media.sizeBytes > Math.min(input.limitBytes, getPlan(planId).limits.storageBytes)) return "quota";
      const verification = await tx.processingJob.findUnique({ where: { idempotencyKey: input.verificationJob.idempotencyKey } });
      if (verification && (verification["ownerId"] !== input.ownerId || verification["mediaAssetId"] !== input.media.id || verification["kind"] !== "media_verification")) return "conflict";
      await tx.mediaAsset.create({ data: mediaToRow(input.media, { storageKey: input.storageKey, thumbnailKey: null }) });
      if (!verification) await tx.processingJob.create({ data: { id: input.verificationJob.id, ownerId: input.ownerId, kind: "media_verification", status: "queued", cycleItemId: null, mediaAssetId: input.media.id, progressPercent: 0, attempts: 0, idempotencyKey: input.verificationJob.idempotencyKey, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: input.now, finishedAt: null, settingsHash: null, payload: input.verificationJob.payload, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null } });
      const updated = await tx.editedMediaReplacement.updateMany({ where: { id: input.jobId, ownerId: input.ownerId, lockToken: input.lockToken, status: { in: ["copying", "verifying"] }, lockExpiresAt: { gt: input.now } }, data: { status: "verifying", replacementMediaAssetId: input.media.id, updatedAt: input.now } });
      if (updated.count !== 1) throw new Error("Replacement lease changed while saving verified input.");
      return "applied";
    });
  }

  async finalizeEditedMediaReplacement(input: { jobId: string; ownerId: string; lockToken: string; now: Date; cleanupJobId: string }): Promise<EditedReplacementFinalizeResult> {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.editedMediaReplacement.findUnique({ where: { id: input.jobId } }); if (!initial) return "stale";
      if (!(await lockedUsers(tx, [input.ownerId]))) return "stale";
      const sourceLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${String(initial["sourceMediaAssetId"])} FOR UPDATE`;
      const replacementLock = initial["replacementMediaAssetId"] ? await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${String(initial["replacementMediaAssetId"])} FOR UPDATE` : [];
      const jobLock = await tx.$queryRaw`SELECT "id" FROM "EditedMediaReplacement" WHERE "id" = ${input.jobId} FOR UPDATE`;
      if (!Array.isArray(sourceLock) || sourceLock.length !== 1 || !Array.isArray(replacementLock) || replacementLock.length !== 1 || !Array.isArray(jobLock) || jobLock.length !== 1) return "stale";
      const job = await tx.editedMediaReplacement.findUnique({ where: { id: input.jobId } });
      if (!job || job["ownerId"] !== input.ownerId || job["lockToken"] !== input.lockToken || job["status"] !== "verifying" || !(job["lockExpiresAt"] instanceof Date) || job["lockExpiresAt"] <= input.now || !job["replacementMediaAssetId"]) return "stale";
      const source = await tx.mediaAsset.findFirst({ where: { id: job["sourceMediaAssetId"], ownerId: input.ownerId } }); const replacement = await tx.mediaAsset.findFirst({ where: { id: job["replacementMediaAssetId"], ownerId: input.ownerId } });
      if (!source || !replacement) return "stale";
      const verification = await tx.processingJob.findUnique({ where: { idempotencyKey: `media-verification:${replacement["id"]}` } });
      if (replacement["status"] !== "active" || replacement["metadataValidated"] !== true || !verification || verification["status"] !== "succeeded") return "unverified";
      if (source["status"] !== "active") return "conflict";
      const memberships = await tx.collectionItem.findMany({ where: { mediaAssetId: source["id"] }, orderBy: [{ collectionId: "asc" }, { id: "asc" }] });
      const current = memberships.map((item) => ({ id: String(item["id"]), collectionId: String(item["collectionId"]), version: Number(item["version"]) }));
      const snapshot = Array.isArray(job["membershipSnapshot"]) ? (job["membershipSnapshot"] as Record<string, unknown>[]).map((item) => ({ id: String(item["id"]), collectionId: String(item["collectionId"]), version: Number(item["version"]) })) : [];
      if (stableJson(current) !== stableJson(snapshot)) return "membership_changed";
      const ids = [...new Set(current.map((item) => item.collectionId))].sort();
      for (const collectionId of ids) { const lock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`; if (!Array.isArray(lock) || lock.length !== 1) return "conflict"; }
      const lockedMemberships = await tx.collectionItem.findMany({ where: { mediaAssetId: source.id }, orderBy: [{ collectionId: "asc" }, { id: "asc" }] });
      const lockedSnapshot = lockedMemberships.map((item) => ({ id: String(item["id"]), collectionId: String(item["collectionId"]), version: Number(item["version"]) }));
      if (stableJson(lockedSnapshot) !== stableJson(snapshot)) return "membership_changed";
      const conflict = await tx.collectionItem.findMany({ where: { mediaAssetId: replacement.id, collectionId: { in: ids } }, select: { id: true } }); if (conflict.length) return "conflict";
      const [coverRefs, activeCycles, imports, renders] = await Promise.all([
        Promise.all([tx.videoCollection.count({ where: { sharedCoverMediaId: source.id } }), tx.collectionItem.count({ where: { coverMediaId: source.id } }), tx.cycleItem.count({ where: { coverMediaId: source.id } })]),
        tx.cycleItem.findMany({ where: { mediaAssetId: source.id, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { id: true } }),
        tx.mediaImportJob.findMany({ where: { sourceMediaId: source.id, status: { in: ["pending", "copying", "verifying"] } }, select: { id: true } }),
        tx.processingJob.findMany({ where: { mediaAssetId: source.id, kind: "render", status: { in: ["queued", "running"] } }, select: { id: true } }),
      ]);
      if (coverRefs.some(Boolean) || activeCycles.length || imports.length || renders.length) return "dependency";
      const cleanupKey = `media-cleanup:${source.id}`; const existingCleanup = await tx.processingJob.findUnique({ where: { idempotencyKey: cleanupKey } });
      if (existingCleanup && (existingCleanup["ownerId"] !== input.ownerId || existingCleanup["mediaAssetId"] !== source.id || existingCleanup["kind"] !== "cleanup")) return "conflict";
      for (const member of lockedMemberships) {
        const changed = await tx.collectionItem.updateMany({ where: { id: member["id"], collectionId: member["collectionId"], mediaAssetId: source.id, version: member["version"] }, data: { mediaAssetId: replacement.id, version: { increment: 1 } } });
        if (changed.count !== 1) throw new Error("Collection membership changed during replacement finalization.");
        await tx.videoCollection.updateMany({ where: { id: member["collectionId"], ownerId: input.ownerId }, data: { settingsVersion: { increment: 1 } } });
      }
      const tombstone = await tx.mediaAsset.updateMany({ where: { id: source.id, ownerId: input.ownerId, status: "active" }, data: { status: "deleted", deleteAfter: null } });
      if (tombstone.count !== 1) throw new Error("Original media changed during replacement finalization.");
      if (!existingCleanup) await tx.processingJob.create({ data: { id: input.cleanupJobId, ownerId: input.ownerId, kind: "cleanup", status: "queued", cycleItemId: null, mediaAssetId: source.id, progressPercent: 0, attempts: 0, idempotencyKey: cleanupKey, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: input.now, finishedAt: null, settingsHash: null, payload: { version: 1, mediaAssetId: source.id }, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null } });
      const completed = await tx.editedMediaReplacement.updateMany({ where: { id: job.id, ownerId: input.ownerId, status: "verifying", lockToken: input.lockToken, lockExpiresAt: { gt: input.now } }, data: { status: "completed", completedAt: input.now, updatedAt: input.now, lockedBy: null, lockToken: null, lockExpiresAt: null, errorCode: null } });
      if (completed.count !== 1) throw new Error("Replacement lease changed during finalization.");
      await tx.auditLog.create({ data: { actorId: input.ownerId, action: "media.edited_replacement_completed", entityType: "EditedMediaReplacement", entityId: job.id, metadata: { sourceMediaAssetId: source.id, replacementMediaAssetId: replacement.id, collectionIds: ids } } });
      return "applied";
    });
  }

  async failEditedMediaReplacement(input: { jobId: string; ownerId: string; lockToken: string; now: Date; errorCode: string; retryAt: Date | null }) {
    const current = await this.db.editedMediaReplacement.findFirst({ where: { id: input.jobId, ownerId: input.ownerId, lockToken: input.lockToken, status: { in: ["copying", "verifying"] }, lockExpiresAt: { gt: input.now } } });
    if (!current) return false;
    const changed = await this.db.editedMediaReplacement.updateMany({ where: { id: input.jobId, ownerId: input.ownerId, lockToken: input.lockToken, status: { in: ["copying", "verifying"] }, lockExpiresAt: { gt: input.now } }, data: { status: input.retryAt ? "queued" : "blocked", errorCode: input.errorCode.slice(0, 80), lockedBy: null, lockToken: null, lockExpiresAt: input.retryAt, updatedAt: input.now } });
    return changed.count === 1;
  }

  async createOrGetMediaImportJob(input: MediaImportRequestInput) {
    const idempotencyKey = `import:${input.importerId}:${input.sourceMediaId}`;
    if (input.idempotencyKey !== idempotencyKey) return { status: "conflict" as const };
    try {
      return await this.db.$transaction(async (tx) => {
        const sourceInitial = await tx.mediaAsset.findUnique({ where: { id: input.sourceMediaId } });
        if (!sourceInitial) return { status: "not_found" as const };
        if (!(await lockedUsers(tx, [input.importerId, String(sourceInitial["ownerId"])]))) return { status: "not_found" as const };
        const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.sourceCollectionId} FOR UPDATE`;
        if (!Array.isArray(locked) || locked.length !== 1) return { status: "not_found" as const };
        const mediaLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${input.sourceMediaId} FOR UPDATE`;
        if (!Array.isArray(mediaLock) || mediaLock.length !== 1) return { status: "not_found" as const };
        const sourceRow = await tx.mediaAsset.findUnique({ where: { id: input.sourceMediaId } });
        const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.sourceCollectionId } });
        if (!sourceRow || !collectionRow) return { status: "not_found" as const };
        const item = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: input.sourceCollectionId, mediaAssetId: input.sourceMediaId } } });
        if (!item) return { status: "not_found" as const };
        const grants = (await tx.collectionPermission.findMany({ where: { collectionId: input.sourceCollectionId } })).map(rowToGrant);
        const collection = rowToCollection(collectionRow, [input.sourceMediaId]);
        const source = rowToMedia(sourceRow);
        if (collection.ownerId !== source.ownerId || source.kind === "image") return { status: "unauthorized" as const };
        if (!canImportVideo(input.importerId, source, collection, grants, input.now).allowed) return { status: "unauthorized" as const };
        const existing = await tx.mediaImportJob.findUnique({ where: { idempotencyKey } });
        if (existing) {
          const job = mediaImportJobFromRow(existing);
          return job.importerId === input.importerId && job.sourceMediaId === input.sourceMediaId && job.sourceCollectionId === input.sourceCollectionId
            ? { status: "existing" as const, job } : { status: "conflict" as const };
        }
        let importerPlan: PlanId;
        try { importerPlan = await this.effectivePlanIdInTransaction(tx, input.importerId, input.now, true); }
        catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; importerPlan = await this.effectivePlanIdInTransaction(tx, input.importerId, input.now, false); }
        const mediaSum = await tx.mediaAsset.aggregate({ where: { ownerId: input.importerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
        const renderSum = await tx.mediaDerivative.aggregate({ where: { ownerId: input.importerId, kind: "render" }, _sum: { sizeBytes: true } });
        if (Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + source.sizeBytes > getPlan(importerPlan).limits.storageBytes) return { status: "quota" as const };
        const finalKey = mediaKeyFor(input.importerId, input.resultMediaAssetId);
        const row = await tx.mediaImportJob.create({ data: { id: input.id, importerId: input.importerId, sourceMediaId: input.sourceMediaId, sourceCollectionId: input.sourceCollectionId, status: "pending", idempotencyKey, newObjectKey: finalKey, stagingObjectKey: null, lockedBy: null, lockToken: null, leaseExpiresAt: null, attempts: 0, attemptStorageKeys: [], resultMediaAssetId: input.resultMediaAssetId, failureReason: null, createdAt: input.now, updatedAt: input.now } });
        await tx.auditLog.create({ data: { actorId: input.importerId, action: "media.import_requested", entityType: "MediaImportJob", entityId: input.id, metadata: { sourceMediaId: input.sourceMediaId, sourceCollectionId: input.sourceCollectionId } } });
        return { status: "created" as const, job: mediaImportJobFromRow(row) };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The user-first locks serialize legitimate retries. A unique violation outside that
      // path may instead be a colliding job/result ID and must not be mistaken for idempotency.
      return { status: "conflict" as const };
    }
  }
  async getMediaImportJobForOwner(importerId: string, jobId: string) { const row = await this.db.mediaImportJob.findFirst({ where: { id: jobId, importerId } }); return row ? mediaImportJobFromRow(row) : null; }
  async listMediaImportJobsForOwner(importerId: string) { return (await this.db.mediaImportJob.findMany({ where: { importerId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })).map(mediaImportJobFromRow); }
  async retryMediaImportJob(importerId: string, jobId: string, now: Date) {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.mediaImportJob.findUnique({ where: { id: jobId } }); if (!initial || initial["importerId"] !== importerId || !initial["sourceCollectionId"]) return false;
      const sourceInitial = await tx.mediaAsset.findUnique({ where: { id: initial["sourceMediaId"] } }); if (!sourceInitial) return false;
      if (!(await lockedUsers(tx, [importerId, String(sourceInitial["ownerId"])]))) return false;
      const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${initial["sourceCollectionId"]} FOR UPDATE`;
      if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return false;
      const mediaLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${initial["sourceMediaId"]} FOR UPDATE`;
      if (!Array.isArray(mediaLock) || mediaLock.length !== 1) return false;
      const jobLock = await tx.$queryRaw`SELECT "id" FROM "MediaImportJob" WHERE "id" = ${jobId} FOR UPDATE`;
      if (!Array.isArray(jobLock) || jobLock.length !== 1) return false;
      const job = await tx.mediaImportJob.findUnique({ where: { id: jobId } });
      const sourceRow = await tx.mediaAsset.findUnique({ where: { id: initial["sourceMediaId"] } });
      const collectionRow = await tx.videoCollection.findUnique({ where: { id: initial["sourceCollectionId"] } });
      const member = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: initial["sourceCollectionId"], mediaAssetId: initial["sourceMediaId"] } } });
      if (!job || job["importerId"] !== importerId || job["status"] !== "failed" || !sourceRow || !collectionRow || !member) return false;
      const source = rowToMedia(sourceRow); const grants = (await tx.collectionPermission.findMany({ where: { collectionId: initial["sourceCollectionId"] } })).map(rowToGrant);
      if (String(collectionRow["ownerId"]) !== source.ownerId || source.kind === "image" || !canImportVideo(importerId, source, rowToCollection(collectionRow, [source.id]), grants, now).allowed) return false;
      const changed = await tx.mediaImportJob.updateMany({ where: { id: jobId, importerId, status: "failed" }, data: { status: "pending", failureReason: null, lockedBy: null, lockToken: null, leaseExpiresAt: null, stagingObjectKey: null, updatedAt: now } });
      if (changed.count !== 1) return false;
      await tx.auditLog.create({ data: { actorId: importerId, action: "media.import_retried", entityType: "MediaImportJob", entityId: jobId } }); return true;
    });
  }
  async claimNextMediaImportJob(input: MediaImportClaim) {
    return this.db.$transaction(async (tx) => {
      const candidate = await tx.mediaImportJob.findFirst({ where: { ...(input.jobId ? { id: input.jobId } : {}), OR: [{ status: "pending" }, { status: { in: ["copying", "verifying"] }, leaseExpiresAt: { lte: input.now } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (!candidate) return null;
      const current = await tx.mediaImportJob.findUnique({ where: { id: candidate["id"] } }); if (!current) return null;
      const source = await tx.mediaAsset.findUnique({ where: { id: current["sourceMediaId"] } }); if (!source) return null;
      if (!(await lockedUsers(tx, [String(current["importerId"]), String(source["ownerId"])]))) return null;
      const collectionExists = await tx.videoCollection.findUnique({ where: { id: current["sourceCollectionId"] } });
      if (collectionExists) {
        const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${current["sourceCollectionId"]} FOR UPDATE`;
        if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return null;
      }
      const mediaLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${current["sourceMediaId"]} FOR UPDATE`;
      if (!Array.isArray(mediaLock) || mediaLock.length !== 1) return null;
      const jobLock = await tx.$queryRaw`SELECT "id" FROM "MediaImportJob" WHERE "id" = ${current["id"]} FOR UPDATE`;
      if (!Array.isArray(jobLock) || jobLock.length !== 1) return null;
      const refreshed = await tx.mediaImportJob.findUnique({ where: { id: current["id"] } });
      if (!refreshed || !(refreshed["status"] === "pending" || ((refreshed["status"] === "copying" || refreshed["status"] === "verifying") && refreshed["leaseExpiresAt"] instanceof Date && refreshed["leaseExpiresAt"] <= input.now))) return null;
      // Claim even if collection membership or permission has disappeared. The worker must persist a
      // terminal failure/audit event rather than leave a permanently pending job that blocks deletion.
      const token = randomUUID(); const staging = stagingKeyFor(`import-${String(refreshed["id"])}-${Number(refreshed["attempts"] ?? 0) + 1}-${token.slice(0, 8)}`);
      const eligible = await tx.mediaImportJob.updateMany({ where: { id: refreshed["id"], status: refreshed["status"], lockToken: refreshed["lockToken"] ?? null, leaseExpiresAt: refreshed["leaseExpiresAt"] ?? null }, data: { status: "copying", lockedBy: input.workerId, lockToken: token, leaseExpiresAt: new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000), attempts: { increment: 1 }, stagingObjectKey: staging, attemptStorageKeys: [...(Array.isArray(refreshed["attemptStorageKeys"]) ? refreshed["attemptStorageKeys"] as string[] : []), staging], updatedAt: input.now } });
      if (eligible.count !== 1) return null;
      const claimed = await tx.mediaImportJob.findUnique({ where: { id: refreshed["id"] } }); return claimed ? mediaImportJobFromRow(claimed) : null;
    });
  }
  async heartbeatMediaImportJob(input: { jobId: string; lockToken: string; now: Date; leaseSeconds: number }) {
    const changed = await this.db.mediaImportJob.updateMany({ where: { id: input.jobId, lockToken: input.lockToken, status: { in: ["copying", "verifying"] }, leaseExpiresAt: { gt: input.now } }, data: { leaseExpiresAt: new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000), updatedAt: input.now } }); return changed.count === 1;
  }
  async markMediaImportVerifying(input: MediaImportVerificationInput) { const changed = await this.db.mediaImportJob.updateMany({ where: { id: input.jobId, lockToken: input.lockToken, status: "copying", leaseExpiresAt: { gt: input.now } }, data: { status: "verifying", updatedAt: input.now } }); return changed.count === 1; }
  async finalizeMediaImportJob(input: MediaImportFinalizationInput) {
    return this.db.$transaction(async (tx) => {
      const currentJob = await tx.mediaImportJob.findUnique({ where: { id: input.jobId } }); if (!currentJob) return "stale" as const;
      const sourceInitial = await tx.mediaAsset.findUnique({ where: { id: currentJob["sourceMediaId"] } }); if (!sourceInitial) return "unauthorized" as const;
      if (!(await lockedUsers(tx, [String(currentJob["importerId"]), String(sourceInitial["ownerId"])]))) return "unauthorized" as const;
      const collLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${currentJob["sourceCollectionId"]} FOR UPDATE`;
      if (!Array.isArray(collLock) || collLock.length !== 1) return "unauthorized" as const;
      const sourceLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${currentJob["sourceMediaId"]} FOR UPDATE`;
      if (!Array.isArray(sourceLock) || sourceLock.length !== 1) return "unauthorized" as const;
      const jobLock = await tx.$queryRaw`SELECT "id" FROM "MediaImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
      if (!Array.isArray(jobLock) || jobLock.length !== 1) return "stale" as const;
      const jobRow = await tx.mediaImportJob.findUnique({ where: { id: input.jobId } });
      if (!jobRow || jobRow["importerId"] !== input.importerId || jobRow["status"] !== "verifying" || jobRow["lockToken"] !== input.lockToken || !(jobRow["leaseExpiresAt"] instanceof Date) || jobRow["leaseExpiresAt"] <= input.now) return "stale" as const;
      const sourceRow = await tx.mediaAsset.findUnique({ where: { id: jobRow["sourceMediaId"] } }); const collectionRow = await tx.videoCollection.findUnique({ where: { id: jobRow["sourceCollectionId"] } });
      const member = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: jobRow["sourceCollectionId"], mediaAssetId: jobRow["sourceMediaId"] } } });
      if (!sourceRow || !collectionRow || !member) return "unauthorized" as const;
      if (await tx.mediaAsset.findUnique({ where: { id: jobRow["resultMediaAssetId"] } })) return "unauthorized" as const;
      const source = rowToMedia(sourceRow); const grants = (await tx.collectionPermission.findMany({ where: { collectionId: jobRow["sourceCollectionId"] } })).map(rowToGrant);
      if (String(collectionRow["ownerId"]) !== source.ownerId || source.kind === "image") return "unauthorized" as const;
      if (!canImportVideo(input.importerId, source, rowToCollection(collectionRow, [source.id]), grants, input.now).allowed) return "unauthorized" as const;
      if (input.media.ownerId !== input.importerId || input.media.id !== jobRow["resultMediaAssetId"] || input.media.importedFromId !== source.id || input.storageKey !== jobRow["newObjectKey"] || input.media.sizeBytes !== source.sizeBytes) return "unauthorized" as const;
      let importerPlan: PlanId;
      try { importerPlan = await this.effectivePlanIdInTransaction(tx, input.importerId, input.now, true); }
      catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; importerPlan = await this.effectivePlanIdInTransaction(tx, input.importerId, input.now, false); }
      const mediaSum = await tx.mediaAsset.aggregate({ where: { ownerId: input.importerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
      const renderSum = await tx.mediaDerivative.aggregate({ where: { ownerId: input.importerId, kind: "render" }, _sum: { sizeBytes: true } });
      if (Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + source.sizeBytes > getPlan(importerPlan).limits.storageBytes) return "quota" as const;
      await input.commitStagedObject();
      await tx.mediaAsset.create({ data: mediaToRow(input.media, { storageKey: input.storageKey, thumbnailKey: null }) });
      const changed = await tx.mediaImportJob.updateMany({ where: { id: input.jobId, status: "verifying", lockToken: input.lockToken, leaseExpiresAt: { gt: input.now } }, data: { status: "succeeded", failureReason: null, lockedBy: null, lockToken: null, leaseExpiresAt: null, updatedAt: input.now } });
      if (changed.count !== 1) throw new Error("Import claim became stale during finalization.");
      await tx.auditLog.create({ data: { actorId: input.importerId, action: "media.import_completed", entityType: "MediaImportJob", entityId: input.jobId, metadata: { sourceMediaId: source.id, importedMediaId: input.media.id, sizeBytes: input.media.sizeBytes } } });
      return "applied" as const;
    });
  }
  async failMediaImportJob(input: { jobId: string; lockToken: string; now: Date; reason: string }) {
    return this.db.$transaction(async (tx) => {
      const job = await tx.mediaImportJob.findUnique({ where: { id: input.jobId } }); if (!job) return false;
      const reason = input.reason.slice(0, 300);
      const changed = await tx.mediaImportJob.updateMany({ where: { id: input.jobId, lockToken: input.lockToken, status: { in: ["copying", "verifying"] }, leaseExpiresAt: { gt: input.now } }, data: { status: "failed", failureReason: reason, lockedBy: null, lockToken: null, leaseExpiresAt: null, updatedAt: input.now } });
      if (changed.count !== 1) return false;
      await tx.auditLog.create({ data: { actorId: job["importerId"] as string, action: "media.import_failed", entityType: "MediaImportJob", entityId: input.jobId, metadata: { reason } } }); return true;
    });
  }
  async scheduleMediaDeletion(input: { mediaId: string; ownerId: string; now: Date; graceDays: number }) {
    return this.db.$transaction(async (tx) => {
      if (!(await lockedUsers(tx, [input.ownerId]))) return "missing" as const;
      const initial = await tx.mediaAsset.findFirst({ where: { id: input.mediaId, ownerId: input.ownerId } }); if (!initial) return "missing" as const;
      const locked = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${input.mediaId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return "missing" as const;
      const active = await tx.mediaImportJob.findFirst({ where: { sourceMediaId: input.mediaId, status: { in: ["pending", "copying", "verifying"] } } });
      if (active) return "import_pending" as const;
      if (initial["status"] === "pending_deletion") return "already_pending" as const;
      const deleteAfter = new Date(input.now.getTime() + Math.max(1, Math.min(input.graceDays, 30)) * 86_400_000);
      const updated = await tx.mediaAsset.updateMany({ where: { id: input.mediaId, ownerId: input.ownerId, status: "active" }, data: { status: "pending_deletion", deleteAfter } }); if (updated.count !== 1) return "already_pending" as const;
      await tx.auditLog.create({ data: { actorId: input.ownerId, action: "media.deletion_scheduled", entityType: "MediaAsset", entityId: input.mediaId, metadata: { deleteAfter: deleteAfter.toISOString() } } }); return "scheduled" as const;
    });
  }

  async requestPermanentMediaDeletion(input: { id: string; mediaId: string; ownerId: string; expectedCollectionIds: string[]; now: Date }) {
    try {
      return await this.db.$transaction(async (tx) => {
        if (!(await lockedUsers(tx, [input.ownerId]))) return { status: "missing" as const };
        const mediaLock = await tx.$queryRaw`SELECT "id" FROM "MediaAsset" WHERE "id" = ${input.mediaId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(mediaLock) || mediaLock.length !== 1) return { status: "missing" as const };
        const idempotencyKey = `media-cleanup:${input.mediaId}`;
        const existing = await tx.processingJob.findUnique({ where: { idempotencyKey } });
        if (existing) return existing["ownerId"] === input.ownerId && existing["kind"] === "cleanup" && existing["mediaAssetId"] === input.mediaId
          ? { status: "existing" as const, job: mediaCleanupJobFromRow(existing), removedCollectionIds: [] }
          : { status: "conflict" as const };
        const media = await tx.mediaAsset.findFirst({ where: { id: input.mediaId, ownerId: input.ownerId } });
        if (!media) return { status: "missing" as const };
        if (media["status"] === "deleted") return { status: "already_deleted" as const };
        const collectionRows = await tx.collectionItem.findMany({ where: { mediaAssetId: input.mediaId }, select: { id: true, collectionId: true } });
        const collectionIds = [...new Set(collectionRows.map((row) => String(row["collectionId"])))].sort();
        if (JSON.stringify(collectionIds) !== JSON.stringify([...new Set(input.expectedCollectionIds)].sort())) return { status: "collections_changed" as const };
        const cycleItems = await tx.cycleItem.findMany({ where: { mediaAssetId: input.mediaId }, select: { status: true } });
        if (cycleItems.some((item) => ["upcoming", "scheduled", "processing", "publishing"].includes(String(item["status"])))) return { status: "in_use" as const };
        const imports = await tx.mediaImportJob.findMany({ where: { sourceMediaId: input.mediaId, status: { in: ["pending", "copying", "verifying"] } }, select: { id: true } });
        if (imports.length) return { status: "import_in_progress" as const };
        const renders = await tx.processingJob.findMany({ where: { mediaAssetId: input.mediaId, kind: "render", status: { in: ["queued", "running"] } }, select: { id: true } });
        if (renders.length) return { status: "in_use" as const };
        const sharedCoverRows = await tx.videoCollection.findMany({ where: { sharedCoverMediaId: input.mediaId }, select: { id: true } });
        const itemCoverRows = await tx.collectionItem.findMany({ where: { coverMediaId: input.mediaId }, select: { collectionId: true } });
        const coverCollectionIds = [...new Set([...sharedCoverRows.map((row) => String(row["id"])), ...itemCoverRows.map((row) => String(row["collectionId"]))])].sort();
        const collectionLockIds = [...new Set([...collectionIds, ...coverCollectionIds])].sort();
        // Cover writers use User -> MediaAsset -> VideoCollection. Lock every current
        // cover parent with the same final lock so archive/restore cannot race stale-ref cleanup.
        if (collectionLockIds.length) {
          for (const collectionId of collectionLockIds) {
            const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} FOR UPDATE`;
            if (!Array.isArray(locked) || locked.length !== 1) {
              if (collectionIds.includes(collectionId)) return { status: "collections_changed" as const };
            }
          }
        }
        // Re-read every dependency after taking the locks. Collection-derived cycle creation
        // takes FOR SHARE on these same rows, so this closes the check/unlink race while keeping
        // historical CycleItems intact.
        const lockedMemberships = await tx.collectionItem.findMany({ where: { mediaAssetId: input.mediaId }, select: { collectionId: true } });
        const lockedCollectionIds = [...new Set(lockedMemberships.map((row) => String(row["collectionId"])))].sort();
        if (JSON.stringify(lockedCollectionIds) !== JSON.stringify(collectionIds)) return { status: "collections_changed" as const };
        const lockedCycleItems = await tx.cycleItem.findMany({ where: { mediaAssetId: input.mediaId }, select: { status: true } });
        if (lockedCycleItems.some((item) => ["upcoming", "scheduled", "processing", "publishing"].includes(String(item["status"])))) return { status: "in_use" as const };
        const lockedImports = await tx.mediaImportJob.findMany({ where: { sourceMediaId: input.mediaId, status: { in: ["pending", "copying", "verifying"] } }, select: { id: true } });
        if (lockedImports.length) return { status: "import_in_progress" as const };
        const lockedRenders = await tx.processingJob.findMany({ where: { mediaAssetId: input.mediaId, kind: "render", status: { in: ["queued", "running"] } }, select: { id: true } });
        if (lockedRenders.length) return { status: "in_use" as const };
        const activeSharedCoverRows = await tx.videoCollection.findMany({ where: { sharedCoverMediaId: input.mediaId, archived: false }, select: { id: true, name: true } });
        const activeItemCoverRows = await tx.collectionItem.findMany({ where: { coverMediaId: input.mediaId, collection: { is: { archived: false } } }, select: { id: true, collectionId: true } });
        const activeCycleCoverRows = await tx.cycleItem.findMany({ where: { coverMediaId: input.mediaId, cycle: { is: { deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } } } }, select: { id: true, cycleId: true } });
        const archivedSharedCoverRows = await tx.videoCollection.findMany({ where: { sharedCoverMediaId: input.mediaId, archived: true }, select: { id: true } });
        const archivedItemCoverRows = await tx.collectionItem.findMany({ where: { coverMediaId: input.mediaId, collection: { is: { archived: true } } }, select: { id: true, collectionId: true } });
        const coverDependencies = new Map<string, { type: "collection" | "cycle"; id: string; name: string }>();
        for (const row of activeSharedCoverRows) coverDependencies.set(`collection:${String(row["id"])}`, { type: "collection", id: String(row["id"]), name: String(row["name"] ?? "Untitled collection") });
        const itemCoverCollectionIds = [...new Set(activeItemCoverRows.map((row) => String(row["collectionId"])))];
        const cycleCoverIds = [...new Set(activeCycleCoverRows.map((row) => String(row["cycleId"])))];
        const itemCoverCollections = itemCoverCollectionIds.length
          ? await tx.videoCollection.findMany({ where: { id: { in: itemCoverCollectionIds }, archived: false }, select: { id: true, name: true } })
          : [];
        const activeCoverCycles = cycleCoverIds.length
          ? await tx.publishingCycle.findMany({ where: { id: { in: cycleCoverIds }, deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } }, select: { id: true, name: true } })
          : [];
        for (const row of itemCoverCollections) coverDependencies.set(`collection:${String(row["id"])}`, { type: "collection", id: String(row["id"]), name: String(row["name"] ?? "Untitled collection") });
        for (const row of activeCoverCycles) coverDependencies.set(`cycle:${String(row["id"])}`, { type: "cycle", id: String(row["id"]), name: String(row["name"] ?? "Untitled cycle") });
        const dependencies = [...coverDependencies.values()].sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
        if (dependencies.length) return { status: "cover_in_use" as const, dependencies };

        // Archived collections can be restored, so clear only their obsolete cover
        // pointers before deleting the referenced storage. Soft-deleted cycle-item
        // pointers remain untouched to preserve publishing history.
        const archivedCollectionIds = [...new Set([...archivedSharedCoverRows.map((row) => String(row["id"])), ...archivedItemCoverRows.map((row) => String(row["collectionId"]))])].sort();
        if (archivedSharedCoverRows.length) await tx.videoCollection.updateMany({ where: { id: { in: archivedSharedCoverRows.map((row) => String(row["id"])) }, archived: true, sharedCoverMediaId: input.mediaId }, data: { sharedCoverMediaId: null, settingsVersion: { increment: 1 } } });
        if (archivedItemCoverRows.length) {
          const itemOnlyCollectionIds = archivedCollectionIds.filter((id) => !archivedSharedCoverRows.some((row) => String(row["id"]) === id));
          if (itemOnlyCollectionIds.length) await tx.videoCollection.updateMany({ where: { id: { in: itemOnlyCollectionIds }, archived: true }, data: { settingsVersion: { increment: 1 } } });
          await tx.collectionItem.updateMany({ where: { id: { in: archivedItemCoverRows.map((row) => String(row["id"])) }, collectionId: { in: archivedCollectionIds }, coverMediaId: input.mediaId }, data: { coverMediaId: null, version: { increment: 1 } } });
        }
        await tx.collectionItem.deleteMany({ where: { mediaAssetId: input.mediaId } });
        const changed = await tx.mediaAsset.updateMany({ where: { id: input.mediaId, ownerId: input.ownerId, status: media["status"] }, data: { status: "deleted", deleteAfter: null } });
        if (changed.count !== 1) throw new Error("Media changed while deletion was being confirmed.");
        const job = await tx.processingJob.create({ data: { id: input.id, ownerId: input.ownerId, kind: "cleanup", status: "queued", cycleItemId: null, mediaAssetId: input.mediaId, progressPercent: 0, attempts: 0, idempotencyKey, lockedBy: null, lockExpiresAt: null, errorMessage: null, createdAt: input.now, finishedAt: null, settingsHash: null, payload: { version: 1, mediaAssetId: input.mediaId }, pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null } });
        await tx.auditLog.create({ data: { actorId: input.ownerId, action: "media.permanent_deletion_queued", entityType: "MediaAsset", entityId: input.mediaId, metadata: { collectionIds } } });
        return { status: "queued" as const, job: mediaCleanupJobFromRow(job), removedCollectionIds: collectionIds };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: "conflict" as const };
      throw error;
    }
  }

  async claimMediaCleanupJob(input: { workerId: string; now: Date; leaseSeconds: number }): Promise<MediaCleanupJobRecord | null> {
    if (!input.workerId || !Number.isFinite(input.leaseSeconds) || input.leaseSeconds <= 0) return null;
    return this.db.$transaction(async (tx) => {
      const candidates = await tx.processingJob.findMany({ where: { kind: "cleanup", OR: [{ status: "queued", createdAt: { lte: input.now } }, { status: "running", lockExpiresAt: { lte: input.now } }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      for (const candidate of candidates) {
        const ownerId = String(candidate["ownerId"]);
        if (!(await lockedUsers(tx, [ownerId]))) continue;
        const lockToken = randomUUID();
        const changed = await tx.processingJob.updateMany({ where: { id: candidate["id"], kind: "cleanup", status: candidate["status"], ...(candidate["status"] === "running" ? { lockToken: candidate["lockToken"], lockExpiresAt: { lte: input.now } } : {}) }, data: { status: "running", lockedBy: input.workerId, lockToken, lockExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000), attempts: { increment: 1 } } });
        if (changed.count !== 1) continue;
        const claimed = await tx.processingJob.findFirst({ where: { id: candidate["id"], kind: "cleanup", status: "running", lockToken } });
        if (claimed) return mediaCleanupJobFromRow(claimed);
      }
      return null;
    });
  }

  async getMediaCleanupJobForOwner(ownerId: string, mediaId: string): Promise<MediaCleanupJobRecord | null> {
    const row = await this.db.processingJob.findFirst({ where: { ownerId, mediaAssetId: mediaId, kind: "cleanup" } });
    return row ? mediaCleanupJobFromRow(row) : null;
  }

  async canCleanupMediaAsset(mediaId: string): Promise<boolean> {
    const media = await this.db.mediaAsset.findUnique({ where: { id: mediaId }, select: { status: true } });
    if (!media || media["status"] !== "deleted") return false;
    const [items, imports, renders, collectionCovers, itemCovers, cycleCovers] = await Promise.all([
      this.db.cycleItem.findMany({ where: { mediaAssetId: mediaId, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { status: true } }),
      this.db.mediaImportJob.findMany({ where: { sourceMediaId: mediaId, status: { in: ["pending", "copying", "verifying"] } }, select: { id: true } }),
      this.db.processingJob.findMany({ where: { mediaAssetId: mediaId, kind: "render", status: { in: ["queued", "running"] } }, select: { id: true } }),
      this.db.videoCollection.findMany({ where: { sharedCoverMediaId: mediaId, archived: false }, select: { id: true } }),
      this.db.collectionItem.findMany({ where: { coverMediaId: mediaId, collection: { is: { archived: false } } }, select: { id: true } }),
      this.db.cycleItem.findMany({ where: { coverMediaId: mediaId, cycle: { is: { deletedAt: null, status: { in: ACTIVE_CYCLE_STATUSES } } } }, select: { id: true } }),
    ]);
    return !items.some((item) => ["upcoming", "scheduled", "processing", "publishing"].includes(String(item["status"]))) && imports.length === 0 && renders.length === 0 && collectionCovers.length === 0 && itemCovers.length === 0 && cycleCovers.length === 0;
  }

  async finishMediaCleanupJob(input: { id: string; ownerId: string; lockToken: string; now: Date }): Promise<boolean> {
    const result = await this.db.processingJob.updateMany({ where: { id: input.id, ownerId: input.ownerId, kind: "cleanup", status: "running", lockToken: input.lockToken }, data: { status: "succeeded", progressPercent: 100, finishedAt: input.now, errorMessage: null, lockToken: null, lockedBy: null, lockExpiresAt: null } });
    return result.count === 1;
  }

  async failMediaCleanupJob(input: { id: string; ownerId: string; lockToken: string; now: Date; errorCode: string; retryAt: Date | null }): Promise<boolean> {
    const current = await this.db.processingJob.findFirst({ where: { id: input.id, ownerId: input.ownerId, kind: "cleanup", status: "running", lockToken: input.lockToken } });
    if (!current) return false;
    const retry = input.retryAt !== null;
    const result = await this.db.processingJob.updateMany({ where: { id: input.id, ownerId: input.ownerId, kind: "cleanup", status: "running", lockToken: input.lockToken }, data: { status: retry ? "queued" : "failed", createdAt: retry ? input.retryAt : input.now, finishedAt: retry ? null : input.now, errorMessage: input.errorCode, lockToken: null, lockedBy: null, lockExpiresAt: null } });
    return result.count === 1;
  }

  private async collectionsFromRows(rows: Record<string, unknown>[]): Promise<VideoCollection[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r["id"] as string);
    const items = await this.db.collectionItem.findMany({ where: { collectionId: { in: ids } }, orderBy: [{ position: "asc" }, { mediaAssetId: "asc" }] });
    const byCollection = new Map<string, string[]>();
    const settingsByCollection = new Map<string, { mediaAssetId: string; captionText: string; coverMediaId: string | null; version: number }[]>();
    for (const item of items) {
      byCollection.set(item["collectionId"], [...(byCollection.get(item["collectionId"]) ?? []), item["mediaAssetId"]]);
      settingsByCollection.set(item["collectionId"], [...(settingsByCollection.get(item["collectionId"]) ?? []), { mediaAssetId: item["mediaAssetId"], captionText: String(item["captionText"] ?? ""), coverMediaId: typeof item["coverMediaId"] === "string" ? item["coverMediaId"] : null, version: typeof item["version"] === "number" ? item["version"] : 1 }]);
    }
    return rows.map((r) => rowToCollection(r, byCollection.get(r["id"] as string) ?? [], settingsByCollection.get(r["id"] as string) ?? []));
  }
  async getCollection(collectionId: string): Promise<VideoCollection | null> {
    const row = await this.db.videoCollection.findUnique({ where: { id: collectionId } });
    return row ? (await this.collectionsFromRows([row]))[0] ?? null : null;
  }
  private async mediaRowsExist(db: PrismaClientLike, mediaIds: string[]): Promise<boolean> {
    if (new Set(mediaIds).size !== mediaIds.length) return false;
    if (mediaIds.length === 0) return true;
    return (await db.mediaAsset.count({ where: { id: { in: mediaIds } } })) === mediaIds.length;
  }
  async createCollection(collection: VideoCollection): Promise<boolean> {
    try {
      return await this.db.$transaction(async (tx) => {
        const lockedUser = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${collection.ownerId} FOR UPDATE`;
        if (!Array.isArray(lockedUser) || lockedUser.length !== 1 || !(await this.mediaRowsExist(tx, collection.mediaIds))) return false;
        const ownedActiveMedia = collection.mediaIds.length === 0 ? 0 : await tx.mediaAsset.count({ where: { id: { in: collection.mediaIds }, ownerId: collection.ownerId, status: "active" } });
        if (ownedActiveMedia !== collection.mediaIds.length) return false;
        const itemSettings = new Map((collection.items ?? []).map((item) => [item.mediaAssetId, item]));
        const coverIds = [collection.sharedCoverMediaId ?? null, ...collection.mediaIds.map((mediaId) => itemSettings.get(mediaId)?.coverMediaId ?? null)].filter((id): id is string => id !== null);
        const activeCoverIds = await lockActiveOwnedMediaRows(tx, collection.ownerId, coverIds);
        if (activeCoverIds.size !== new Set(coverIds).size) return false;
        await tx.videoCollection.create({ data: { id: collection.id, ownerId: collection.ownerId, name: collection.name ?? collection.id, description: collection.description ?? null, visibility: collection.visibility, archived: collection.archived, captionMode: collection.captionMode ?? "individual", sharedCaptionText: collection.sharedCaptionText ?? null, coverMode: collection.coverMode ?? "individual", sharedCoverMediaId: collection.sharedCoverMediaId ?? null, settingsVersion: collection.settingsVersion ?? 1, ...(collection.createdAt ? { createdAt: collection.createdAt } : {}) } });
        if (collection.mediaIds.length > 0) {
          await tx.collectionItem.createMany({ data: collection.mediaIds.map((mediaAssetId, position) => { const item = itemSettings.get(mediaAssetId); return { collectionId: collection.id, mediaAssetId, position, captionText: item?.captionText ?? "", coverMediaId: item?.coverMediaId ?? null }; }) });
        }
        return true;
      });
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; }
  }
  async addOwnedMediaToCollection(input: { collectionId: string; mediaAssetId: string; ownerId: string; actorId: string; now: Date }): Promise<"added" | "existing" | "not_found" | "not_owned"> {
    if (input.actorId !== input.ownerId) return "not_owned";
    return this.db.$transaction(async (tx) => {
      if (!(await lockedUsers(tx, [input.ownerId]))) return "not_found";
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return "not_found";
      const collection = await tx.videoCollection.findUnique({ where: { id: input.collectionId }, select: { archived: true } });
      if (!collection || collection["archived"] === true) return "not_found";
      const media = await tx.mediaAsset.findFirst({ where: { id: input.mediaAssetId, ownerId: input.ownerId, status: "active", kind: "video" }, select: { id: true } });
      if (!media) return "not_owned";
      const existing = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId } }, select: { id: true } });
      if (existing) return "existing";
      const last = await tx.collectionItem.findFirst({ where: { collectionId: input.collectionId }, orderBy: [{ position: "desc" }, { id: "desc" }], select: { position: true } });
      await tx.collectionItem.create({ data: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId, position: Number(last?.["position"] ?? -1) + 1 } });
      await tx.videoCollection.updateMany({ where: { id: input.collectionId, ownerId: input.ownerId }, data: { settingsVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "collection.item_added", entityType: "CollectionItem", entityId: `${input.collectionId}:${input.mediaAssetId}`, metadata: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId } } });
      return "added";
    });
  }
  async saveCollectionItemSettings(input: { collectionId: string; ownerId: string; mediaAssetId: string; captionText: string; coverMediaId: string | null; expectedVersion: number }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.collectionItem.findUnique({ where: { collectionId_mediaAssetId: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId } }, select: { coverMediaId: true } });
      const initialCollection = await tx.videoCollection.findUnique({ where: { id: input.collectionId }, select: { ownerId: true } });
      if (!initial || initialCollection?.["ownerId"] !== input.ownerId || !(await lockedUsers(tx, [input.ownerId]))) return false;
      if (input.coverMediaId !== null && initial["coverMediaId"] !== input.coverMediaId) {
        const valid = await lockActiveOwnedMediaRows(tx, input.ownerId, [input.coverMediaId]);
        if (!valid.has(input.coverMediaId)) return false;
      }
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return false;
      const result = await tx.collectionItem.updateMany({ where: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId, version: input.expectedVersion }, data: { captionText: input.captionText, coverMediaId: input.coverMediaId, version: { increment: 1 } } });
      if (result.count === 1) await tx.videoCollection.updateMany({ where: { id: input.collectionId, ownerId: input.ownerId }, data: { settingsVersion: { increment: 1 } } });
      return result.count === 1;
    });
  }
  async saveCollectionSharedSettings(input: { collectionId: string; ownerId: string; actorId: string; affected: number; expectedVersion: number; captionMode?: "individual" | "shared"; sharedCaptionText?: string | null; coverMode?: "individual" | "shared"; sharedCoverMediaId?: string | null }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.videoCollection.findUnique({ where: { id: input.collectionId }, select: { ownerId: true, sharedCoverMediaId: true } });
      if (!initial || initial["ownerId"] !== input.ownerId || !(await lockedUsers(tx, [input.ownerId]))) return false;
      if (input.sharedCoverMediaId != null && initial["sharedCoverMediaId"] !== input.sharedCoverMediaId) {
        const valid = await lockActiveOwnedMediaRows(tx, input.ownerId, [input.sharedCoverMediaId]);
        if (!valid.has(input.sharedCoverMediaId)) return false;
      }
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return false;
      const data: Record<string, unknown> = { settingsVersion: { increment: 1 } };
      if (input.captionMode !== undefined) data["captionMode"] = input.captionMode;
      if (input.sharedCaptionText !== undefined) data["sharedCaptionText"] = input.sharedCaptionText;
      if (input.coverMode !== undefined) data["coverMode"] = input.coverMode;
      if (input.sharedCoverMediaId !== undefined) data["sharedCoverMediaId"] = input.sharedCoverMediaId;
      const result = await tx.videoCollection.updateMany({ where: { id: input.collectionId, ownerId: input.ownerId, settingsVersion: input.expectedVersion }, data });
      if (result.count !== 1) return false;
      const shared = input.captionMode === "shared" || input.coverMode === "shared";
      await tx.auditLog.create({ data: { actorId: input.actorId, action: shared ? "collection.shared_settings_applied" : "collection.settings_mode_changed", entityType: "VideoCollection", entityId: input.collectionId, metadata: { affected: input.affected, captionMode: input.captionMode ?? null, coverMode: input.coverMode ?? null } } });
      return true;
    });
  }
  async updateCollection(collectionId: string, details: { name: string; description: string | null; visibility: VideoCollection["visibility"]; archived: boolean }): Promise<boolean> {
    const result = await this.db.videoCollection.updateMany({ where: { id: collectionId }, data: { name: details.name, description: details.description, visibility: details.visibility, archived: details.archived } });
    return result.count === 1;
  }
  async replaceCollectionMedia(collectionId: string, mediaIds: string[]): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const initial = await tx.videoCollection.findUnique({ where: { id: collectionId }, select: { ownerId: true } });
      if (!initial || !(await lockedUsers(tx, [String(initial["ownerId"])]))) return false;
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return false;
      const collection = await tx.videoCollection.findUnique({ where: { id: collectionId }, select: { ownerId: true, archived: true } });
      if (!collection) return false;
      if (!(await this.mediaRowsExist(tx, mediaIds))) return false;
      if (mediaIds.length > 0) {
        const ownedActiveMedia = await tx.mediaAsset.count({ where: { id: { in: mediaIds }, ownerId: collection["ownerId"], status: "active" } });
        if (ownedActiveMedia !== mediaIds.length) return false;
      }
      const current = await tx.collectionItem.findMany({ where: { collectionId } });
      const removed = current.map((item) => item["mediaAssetId"] as string).filter((id) => !mediaIds.includes(id));
      if (removed.length && await tx.mediaImportJob.findFirst({ where: { sourceCollectionId: collectionId, sourceMediaId: { in: removed }, status: { in: ["pending", "copying", "verifying"] } } })) return false;
      if (removed.length && await tx.cycleItem.findFirst({ where: { sourceCollectionId: collectionId, mediaAssetId: { in: removed }, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { id: true } })) return false;
      await tx.collectionItem.deleteMany({ where: { collectionId, mediaAssetId: { in: removed } } });
      const existingIds = new Set(current.map((item) => item["mediaAssetId"] as string));
      const added = mediaIds.filter((id) => !existingIds.has(id));
      if (added.length > 0) await tx.collectionItem.createMany({ data: added.map((mediaAssetId) => ({ collectionId, mediaAssetId, position: mediaIds.indexOf(mediaAssetId) })) });
      for (const mediaAssetId of mediaIds) await tx.collectionItem.updateMany({ where: { collectionId, mediaAssetId }, data: { position: mediaIds.indexOf(mediaAssetId) } });
      await tx.videoCollection.updateMany({ where: { id: collectionId }, data: { settingsVersion: { increment: 1 } } });
      return true;
    });
  }
  async removeCollectionItem(input: { collectionId: string; mediaAssetId: string; actorId: string; now: Date }): Promise<"removed" | "already_absent" | "not_found" | "forbidden" | "conflict"> {
    return this.db.$transaction(async (tx) => {
      // Share the collection lock used by grant changes and membership edits, so a revoked
      // delegated manager cannot race this authorization check.
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1) return "not_found";
      const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.collectionId } });
      if (!collectionRow) return "not_found";
      const memberships = await tx.collectionItem.findMany({ where: { collectionId: input.collectionId }, orderBy: [{ position: "asc" }, { mediaAssetId: "asc" }] });
      const collection = rowToCollection(collectionRow, memberships.map((item) => String(item["mediaAssetId"])));
      const grants = (await tx.collectionPermission.findMany({ where: { collectionId: input.collectionId } })).map(rowToGrant);
      const capabilities = getCollectionCapabilities(input.actorId, collection, grants, input.now);
      if (!capabilities.has("view")) return "not_found";
      if (!capabilities.has("manage")) return "forbidden";
      const selected = memberships.find((item) => item["mediaAssetId"] === input.mediaAssetId);
      if (!selected) return "already_absent";
      const activeImport = await tx.mediaImportJob.findFirst({ where: { sourceCollectionId: input.collectionId, sourceMediaId: input.mediaAssetId, status: { in: ["pending", "copying", "verifying"] } } });
      if (activeImport) return "conflict";
      const activeCycleReference = await tx.cycleItem.findFirst({ where: { sourceCollectionId: input.collectionId, mediaAssetId: input.mediaAssetId, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { id: true } });
      if (activeCycleReference) return "conflict";
      const removed = await tx.collectionItem.deleteMany({ where: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId } });
      if (removed.count !== 1) return "already_absent";
      await tx.videoCollection.updateMany({ where: { id: input.collectionId }, data: { settingsVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "collection.item_removed", entityType: "CollectionItem", entityId: `${input.collectionId}:${input.mediaAssetId}`, metadata: { collectionId: input.collectionId, mediaAssetId: input.mediaAssetId } } });
      return "removed";
    });
  }
  async deleteCollection(collectionId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${collectionId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length !== 1 || !(await tx.videoCollection.findUnique({ where: { id: collectionId } }))) return false;
      if (await tx.mediaImportJob.findFirst({ where: { sourceCollectionId: collectionId, status: { in: ["pending", "copying", "verifying"] } } })) return false;
      if (await tx.cycleItem.findFirst({ where: { sourceCollectionId: collectionId, status: { in: ["upcoming", "scheduled", "processing", "publishing"] } }, select: { id: true } })) return false;
      await tx.collectionItem.deleteMany({ where: { collectionId } });
      await tx.collectionPermission.deleteMany({ where: { collectionId } });
      const removed = await tx.videoCollection.deleteMany({ where: { id: collectionId } });
      return removed.count === 1;
    });
  }
  async listCollectionsForOwner(userId: string): Promise<VideoCollection[]> { return this.collectionsFromRows(await this.db.videoCollection.findMany({ where: { ownerId: userId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })); }
  async listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]> {
    const grants = (await this.db.collectionPermission.findMany({ where: { granteeId: userId, status: "active" } })).filter((g) => g["expiresAt"] == null || (g["expiresAt"] as Date) > now);
    const ids = grants.map((g) => g["collectionId"] as string);
    if (ids.length === 0) return [];
    const rows = (await this.db.videoCollection.findMany({ where: { id: { in: ids } } })).filter((r) => r["ownerId"] !== userId);
    return this.collectionsFromRows(rows);
  }
  async listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]> {
    const links = await this.db.collectionItem.findMany({ where: { mediaAssetId: mediaId } });
    const ids = [...new Set(links.map((l) => l["collectionId"] as string))];
    return ids.length === 0 ? [] : this.collectionsFromRows(await this.db.videoCollection.findMany({ where: { id: { in: ids } } }));
  }

  async getGrants(collectionId: string): Promise<CollectionPermissionGrant[]> { return (await this.db.collectionPermission.findMany({ where: { collectionId } })).map(rowToGrant); }
  async createCollectionShareLink(input: CreateCollectionShareLinkInput) {
    const initial = await this.db.videoCollection.findFirst({ where: { id: input.collectionId, ownerId: input.ownerId }, select: { id: true } });
    if (!initial) return { status: "not_found" as const };
    await this.getPlanIdForUser(input.ownerId, input.now);
    try {
      return await this.db.$transaction(async (tx) => {
        const userLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(userLock) || userLock.length !== 1) return { status: "not_found" as const };
        const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return { status: "not_found" as const };
        const collection = await tx.videoCollection.findUnique({ where: { id: input.collectionId }, select: { id: true, ownerId: true, visibility: true, archived: true } });
        if (!collection || collection["ownerId"] !== input.ownerId) return { status: "not_found" as const };
        if (collection["visibility"] !== "link" || collection["archived"] === true) return { status: "invalid" as const, reason: "Only active collections set to link visibility can receive a share link." };
        let planId: PlanId;
        try { planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, true); }
        catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, false); }
        const plan = getPlan(planId);
        const decision = validateShareLinkSettings({ capabilities: input.capabilities, expiresAt: input.expiresAt, now: input.now, collectionSharing: plan.features.collectionSharing, expiringGrants: plan.sharing.expiringGrants });
        if (!decision.allowed) return { status: plan.features.collectionSharing === "none" || (input.expiresAt !== null && !plan.sharing.expiringGrants) ? "plan_limit" as const : "invalid" as const, reason: decision.reason };
        const link: CollectionShareLinkRecord = { id: input.id, collectionId: input.collectionId, tokenHash: input.tokenHash, capabilities: [...new Set(input.capabilities)], expiresAt: input.expiresAt, revokedAt: null, createdById: input.ownerId, createdAt: input.now };
        await tx.collectionShareLink.create({ data: { ...link } });
        await tx.auditLog.create({ data: { actorId: input.ownerId, action: "sharing.share_link_created", entityType: "CollectionShareLink", entityId: link.id, metadata: { collectionId: link.collectionId, capabilities: link.capabilities, expiresAt: link.expiresAt?.toISOString() ?? null } } });
        return { status: "created" as const, link: shareLinkSummary(link) };
      });
    } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" as const }; throw error; }
  }
  async updateCollectionShareLink(input: UpdateCollectionShareLinkInput) {
    const initial = await this.db.collectionShareLink.findFirst({ where: { id: input.id, collectionId: input.collectionId, createdById: input.ownerId } });
    if (!initial) return { status: "not_found" as const };
    await this.getPlanIdForUser(input.ownerId, input.now);
    return this.db.$transaction(async (tx) => {
      const userLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(userLock) || userLock.length !== 1) return { status: "not_found" as const };
      const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return { status: "not_found" as const };
      const currentRow = await tx.collectionShareLink.findFirst({ where: { id: input.id, collectionId: input.collectionId, createdById: input.ownerId } });
      const collection = await tx.videoCollection.findUnique({ where: { id: input.collectionId }, select: { id: true, ownerId: true, visibility: true, archived: true } });
      if (!currentRow || !collection || collection["ownerId"] !== input.ownerId) return { status: "not_found" as const };
      const current = shareLinkFromRow(currentRow);
      if (current.revokedAt !== null) return { status: "revoked" as const };
      if (collection["visibility"] !== "link" || collection["archived"] === true) return { status: "invalid" as const, reason: "The collection is not available for link sharing." };
      let planId: PlanId;
      try { planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, true); }
      catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, false); }
      const plan = getPlan(planId);
      const decision = validateShareLinkSettings({ capabilities: input.capabilities, expiresAt: input.expiresAt, now: input.now, collectionSharing: plan.features.collectionSharing, expiringGrants: plan.sharing.expiringGrants });
      if (!decision.allowed) return { status: plan.features.collectionSharing === "none" || (input.expiresAt !== null && !plan.sharing.expiringGrants) ? "plan_limit" as const : "invalid" as const, reason: decision.reason };
      const capabilities = [...new Set(input.capabilities)];
      const unchanged = JSON.stringify(current.capabilities) === JSON.stringify(capabilities) && (current.expiresAt?.getTime() ?? null) === (input.expiresAt?.getTime() ?? null);
      if (unchanged) return { status: "unchanged" as const, link: shareLinkSummary(current) };
      const changed = await tx.collectionShareLink.updateMany({ where: { id: input.id, collectionId: input.collectionId, createdById: input.ownerId, revokedAt: null }, data: { capabilities, expiresAt: input.expiresAt } });
      if (changed.count !== 1) return { status: "conflict" as const };
      await tx.auditLog.create({ data: { actorId: input.ownerId, action: "sharing.share_link_updated", entityType: "CollectionShareLink", entityId: input.id, metadata: { collectionId: input.collectionId, capabilities, expiresAt: input.expiresAt?.toISOString() ?? null } } });
      return { status: "updated" as const, link: { ...current, capabilities, expiresAt: input.expiresAt } };
    });
  }
  async revokeCollectionShareLink(input: { id: string; collectionId: string; ownerId: string; now: Date }) {
    const initial = await this.db.collectionShareLink.findFirst({ where: { id: input.id, collectionId: input.collectionId, createdById: input.ownerId }, select: { id: true, revokedAt: true } });
    if (!initial) return "not_found" as const;
    if (initial["revokedAt"] !== null) return "already_revoked" as const;
    return this.db.$transaction(async (tx) => {
      const userLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(userLock) || userLock.length !== 1) return "not_found" as const;
      const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return "not_found" as const;
      const changed = await tx.collectionShareLink.updateMany({ where: { id: input.id, collectionId: input.collectionId, createdById: input.ownerId, revokedAt: null }, data: { revokedAt: input.now } });
      if (changed.count !== 1) return "already_revoked" as const;
      await tx.auditLog.create({ data: { actorId: input.ownerId, action: "sharing.share_link_revoked", entityType: "CollectionShareLink", entityId: input.id, metadata: { collectionId: input.collectionId } } });
      return "revoked" as const;
    });
  }
  async listCollectionShareLinksForOwner(collectionId: string, ownerId: string): Promise<CollectionShareLinkSummary[]> {
    const collection = await this.db.videoCollection.findFirst({ where: { id: collectionId, ownerId }, select: { id: true } });
    if (!collection) return [];
    return (await this.db.collectionShareLink.findMany({ where: { collectionId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true, collectionId: true, capabilities: true, expiresAt: true, revokedAt: true, createdById: true, createdAt: true } })).map((row) => {
      const mapped = shareLinkFromRow({ ...row, tokenHash: "" });
      return shareLinkSummary(mapped);
    });
  }
  async getCollectionShareLinkByTokenHash(tokenHash: string): Promise<CollectionShareLinkRecord | null> {
    const row = await this.db.collectionShareLink.findFirst({ where: { tokenHash }, select: { id: true, collectionId: true, tokenHash: true, capabilities: true, expiresAt: true, revokedAt: true, createdById: true, createdAt: true } });
    return row ? shareLinkFromRow(row) : null;
  }
  async createCollectionAccessRequest(input: CreateCollectionAccessRequestInput) {
    const initial = await this.db.videoCollection.findUnique({ where: { id: input.collectionId } });
    if (!initial || initial["ownerId"] === input.requesterId) return { status: "not_found" as const };
    const ownerId = String(initial["ownerId"]);
    const requested = [...new Set(input.requestedCapabilities)];
    if (!requested.length || requested.includes("manage") || requested.some((cap) => !["view", "use_in_cycle", "import_copy", "download"].includes(cap))) return { status: "invalid" as const, reason: "Choose one or more supported collection permissions." };
    try {
      return await this.db.$transaction(async (tx) => {
        const userIds = [...new Set([ownerId, input.requesterId])].sort();
        const lockedUsers = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${userIds[0]}, ${userIds[1] ?? userIds[0]}) ORDER BY "id" FOR UPDATE`;
        if (!Array.isArray(lockedUsers) || lockedUsers.length !== userIds.length) return { status: "not_found" as const };
        const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return { status: "not_found" as const };
        const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.collectionId } });
        if (!collectionRow || collectionRow["ownerId"] !== ownerId) return { status: "not_found" as const };
        const collection = rowToCollection(collectionRow, []);
        const grants = (await tx.collectionPermission.findMany({ where: { collectionId: collection.id } })).map(rowToGrant);
        if (getCollectionCapabilities(input.requesterId, collection, grants, input.now).has("view")) return { status: "already_has_access" as const };
        const rows = (await tx.collectionAccessRequest.findMany({ where: { collectionId: collection.id } })).map(accessRequestFromRow);
        const pending = rows.find((request) => request.requesterId === input.requesterId && request.status === "pending");
        if (pending) return { status: "existing" as const, request: pending };
        const domain = canCreateAccessRequest(input.requesterId, collection, rows);
        if (!domain.allowed) return { status: "invalid" as const, reason: domain.reason };
        const record: CollectionAccessRequestRecord = { id: input.id, collectionId: collection.id, requesterId: input.requesterId, requestedCapabilities: requested, status: "pending", decidedById: null, decidedAt: null, createdAt: input.now };
        await tx.collectionAccessRequest.create({ data: { ...record } });
        await tx.auditLog.create({ data: { actorId: input.requesterId, action: "sharing.access_request_created", entityType: "CollectionAccessRequest", entityId: record.id, metadata: { collectionId: collection.id, requestedCapabilities: requested } } });
        return { status: "created" as const, request: record };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const row = await this.db.collectionAccessRequest.findFirst({ where: { collectionId: input.collectionId, requesterId: input.requesterId, status: "pending" } });
      return row ? { status: "existing" as const, request: accessRequestFromRow(row) } : { status: "conflict" as const };
    }
  }
  async listPendingCollectionAccessRequests(collectionId: string, ownerId: string): Promise<CollectionAccessRequestRecord[]> {
    const collection = await this.db.videoCollection.findFirst({ where: { id: collectionId, ownerId }, select: { id: true } });
    if (!collection) return [];
    return (await this.db.collectionAccessRequest.findMany({ where: { collectionId, status: "pending" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(accessRequestFromRow);
  }
  async listCollectionAccessRequestsForRequester(requesterId: string): Promise<CollectionAccessRequestRecord[]> {
    return (await this.db.collectionAccessRequest.findMany({ where: { requesterId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })).map(accessRequestFromRow);
  }
  async decideCollectionAccessRequest(input: DecideCollectionAccessRequestInput) {
    const initialRequest = await this.db.collectionAccessRequest.findFirst({ where: { id: input.requestId, collectionId: input.collectionId } });
    if (!initialRequest) return { status: "not_found" as const };
    const requesterId = String(initialRequest["requesterId"]);
    const initialCollection = await this.db.videoCollection.findFirst({ where: { id: input.collectionId, ownerId: input.ownerId } });
    if (!initialCollection) return { status: "not_found" as const };
    await this.getPlanIdForUser(input.ownerId, input.now);
    return this.db.$transaction(async (tx) => {
      const userIds = [...new Set([input.ownerId, requesterId])].sort();
      const lockedUsers = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${userIds[0]}, ${userIds[1] ?? userIds[0]}) ORDER BY "id" FOR UPDATE`;
      if (!Array.isArray(lockedUsers) || lockedUsers.length !== userIds.length) return { status: "not_found" as const };
      const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(collectionLock) || collectionLock.length !== 1) return { status: "not_found" as const };
      const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.collectionId } });
      const row = await tx.collectionAccessRequest.findUnique({ where: { id: input.requestId } });
      if (!collectionRow || collectionRow["ownerId"] !== input.ownerId || !row || row["collectionId"] !== input.collectionId) return { status: "not_found" as const };
      const current = accessRequestFromRow(row);
      if (current.status !== "pending") return { status: "already_decided" as const };
      const collection = rowToCollection(collectionRow, []);
      const domain = decideAccessRequest(input.ownerId, collection, { collectionId: current.collectionId, requesterId: current.requesterId, requestedCapabilities: current.requestedCapabilities, status: current.status }, input.decision);
      if (!domain.ok) return { status: "forbidden" as const, reason: domain.reason };
      const nowRequest = { status: input.decision, decidedById: input.ownerId, decidedAt: input.now };
      let newGrant: CollectionPermissionGrant | null = null;
      if (input.decision === "approved") {
        const grants = (await tx.collectionPermission.findMany({ where: { collectionId: collection.id } })).map(rowToGrant);
        let planId: PlanId;
        try { planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, true); }
        catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; planId = await this.effectivePlanIdInTransaction(tx, input.ownerId, input.now, false); }
        const planned = planGrantCreation({ actorId: input.ownerId, granteeId: current.requesterId, collection, existingGrants: grants, capabilities: current.requestedCapabilities, expiresAt: null, policy: getPlan(planId).sharing, now: input.now });
        if (!planned.ok) return { status: planned.code === "plan_limit" ? "plan_limit" as const : planned.code === "invalid" ? "invalid" as const : "forbidden" as const, reason: planned.reason };
        newGrant = planned.grant;
      }
      const changed = await tx.collectionAccessRequest.updateMany({ where: { id: current.id, collectionId: current.collectionId, requesterId: current.requesterId, status: "pending" }, data: nowRequest });
      if (changed.count !== 1) return { status: "conflict" as const };
      if (newGrant) {
        const data = grantToRow(newGrant);
        await tx.collectionPermission.upsert({ where: { collectionId_granteeId: { collectionId: collection.id, granteeId: current.requesterId } }, create: data, update: { capabilities: data["capabilities"], status: "active", expiresAt: data["expiresAt"], grantedById: data["grantedById"], revokedAt: null } });
      }
      await tx.auditLog.create({ data: { actorId: input.ownerId, action: `sharing.access_request_${input.decision}`, entityType: "CollectionAccessRequest", entityId: current.id, metadata: { collectionId: collection.id, requesterId: current.requesterId, ...(newGrant ? { grantedCapabilities: newGrant.capabilities } : {}) } } });
      return { status: "applied" as const, request: { ...current, ...nowRequest }, grant: newGrant };
    });
  }
  async createOrUpdateCollectionGrant(input: CreateCollectionGrantInput): Promise<CollectionGrantMutationResult> {
    const initial = await this.db.videoCollection.findUnique({ where: { id: input.collectionId } });
    if (!initial) return { status: "not_found" };
    const ownerId = String(initial["ownerId"]);
    // Activate a due queued entitlement before taking the grant transaction's shared User lock.
    await this.getPlanIdForUser(ownerId, input.now);
    try {
      return await this.db.$transaction(async (tx) => {
        const userLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(userLock) || userLock.length === 0) return { status: "not_found" as const };
        const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(collectionLock) || collectionLock.length === 0) return { status: "not_found" as const };
        const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.collectionId } });
        if (!collectionRow || collectionRow["ownerId"] !== ownerId) return { status: "not_found" as const };
        const collection = rowToCollection(collectionRow, []);
        const rows = await tx.collectionPermission.findMany({ where: { collectionId: input.collectionId } });
        const grants = rows.map(rowToGrant);
        if (!getCollectionCapabilities(input.actorId, collection, grants, input.now).has("view")) return { status: "not_found" as const };
        let ownerPlanId: PlanId;
        try { ownerPlanId = await this.effectivePlanIdInTransaction(tx, ownerId, input.now, true); }
        catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; ownerPlanId = await this.effectivePlanIdInTransaction(tx, ownerId, input.now, false); }
        const decision = planGrantCreation({ actorId: input.actorId, granteeId: input.granteeId, collection, existingGrants: grants, capabilities: input.capabilities, expiresAt: input.expiresAt, policy: getPlan(ownerPlanId).sharing, now: input.now });
        if (!decision.ok) return { status: decision.code === "plan_limit" ? "plan_limit" as const : decision.code === "invalid" ? "invalid" as const : "forbidden" as const, reason: decision.reason };
        const old = grants.find((grant) => grant.granteeId === input.granteeId);
        const sameCapabilities = old && old.capabilities.length === decision.grant.capabilities.length && [...old.capabilities].sort().every((value, index) => value === [...decision.grant.capabilities].sort()[index]);
        if (old?.status === "active" && old.grantedById === decision.grant.grantedById && old.expiresAt?.getTime() === decision.grant.expiresAt?.getTime() && sameCapabilities) return { status: "existing" as const, grant: old };
        const data = grantToRow(decision.grant);
        const saved = await tx.collectionPermission.upsert({
          where: { collectionId_granteeId: { collectionId: input.collectionId, granteeId: input.granteeId } },
          create: data,
          update: { capabilities: data["capabilities"], status: "active", expiresAt: data["expiresAt"], grantedById: data["grantedById"], revokedAt: null },
        });
        await tx.auditLog.create({ data: { actorId: input.actorId, action: "sharing.grant_created", entityType: "VideoCollection", entityId: input.collectionId, metadata: { granteeId: input.granteeId, capabilities: decision.grant.capabilities, expiresAt: input.expiresAt?.toISOString() ?? null } } });
        return { status: "applied" as const, grant: rowToGrant(saved) };
      });
    } catch (error) { if (isUniqueViolation(error)) return { status: "conflict" }; throw error; }
  }
  async revokeCollectionGrant(input: RevokeCollectionGrantInput): Promise<CollectionGrantMutationResult> {
    const initial = await this.db.videoCollection.findUnique({ where: { id: input.collectionId } });
    if (!initial) return { status: "not_found" };
    const ownerId = String(initial["ownerId"]);
    await this.getPlanIdForUser(ownerId, input.now);
    return this.db.$transaction(async (tx) => {
      const userLock = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE`;
      if (!Array.isArray(userLock) || userLock.length === 0) return { status: "not_found" as const };
      const collectionLock = await tx.$queryRaw`SELECT "id" FROM "VideoCollection" WHERE "id" = ${input.collectionId} AND "ownerId" = ${ownerId} FOR UPDATE`;
      if (!Array.isArray(collectionLock) || collectionLock.length === 0) return { status: "not_found" as const };
      const collectionRow = await tx.videoCollection.findUnique({ where: { id: input.collectionId } });
      if (!collectionRow || collectionRow["ownerId"] !== ownerId) return { status: "not_found" as const };
      const collection = rowToCollection(collectionRow, []);
      const rows = await tx.collectionPermission.findMany({ where: { collectionId: input.collectionId } });
      const grants = rows.map(rowToGrant);
      if (!getCollectionCapabilities(input.actorId, collection, grants, input.now).has("view")) return { status: "not_found" as const };
      const grant = grants.find((candidate) => candidate.granteeId === input.granteeId && candidate.status === "active");
      if (!grant) return { status: "not_found" as const };
      let ownerPlanId: PlanId;
      try { ownerPlanId = await this.effectivePlanIdInTransaction(tx, ownerId, input.now, true); }
      catch (error) { if (!isPromotionSchemaUnavailable(error)) throw error; ownerPlanId = await this.effectivePlanIdInTransaction(tx, ownerId, input.now, false); }
      const decision = planGrantRevocation({ actorId: input.actorId, collection, grant, allGrants: grants, policy: getPlan(ownerPlanId).sharing, now: input.now });
      if (!decision.ok) return { status: "forbidden" as const, reason: decision.reason };
      const changed = await tx.collectionPermission.updateMany({ where: { collectionId: input.collectionId, granteeId: input.granteeId, status: "active" }, data: { status: "revoked", revokedAt: input.now } });
      if (changed.count !== 1) return { status: "not_found" as const };
      await tx.auditLog.create({ data: { actorId: input.actorId, action: "sharing.grant_revoked", entityType: "VideoCollection", entityId: input.collectionId, metadata: { granteeId: input.granteeId } } });
      return { status: "applied" as const, grant: decision.grant };
    });
  }
  async upsertGrant(grant: CollectionPermissionGrant): Promise<void> {
    const row = grantToRow(grant);
    await this.db.collectionPermission.upsert({ where: { collectionId_granteeId: { collectionId: grant.collectionId, granteeId: grant.granteeId } }, create: row, update: { capabilities: row["capabilities"], status: row["status"], expiresAt: row["expiresAt"], grantedById: row["grantedById"], revokedAt: row["revokedAt"] } });
  }

  async getSocialAccount(accountId: string): Promise<SocialAccountRecord | null> { const row = await this.db.socialAccount.findUnique({ where: { id: accountId } }); return row ? rowToSocialAccount(row) : null; }
  async listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]> { return (await this.db.socialAccount.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(rowToSocialAccount); }
  async saveInstagramConnection(connection: InstagramConnectionWrite): Promise<string> {
    return this.db.$transaction(async (tx) => {
      const existing = (await tx.socialAccount.findMany({ where: { userId: connection.userId, platform: "instagram", externalAccountId: connection.externalAccountId } }))[0];
      const data = {
        username: connection.username, accountType: connection.accountType, grantedScopes: connection.grantedScopes.join(" "),
        tokenExpiresAt: connection.tokenExpiresAt, encryptedAccessToken: connection.encryptedAccessToken, status: "connected",
      };
      if (existing) {
        await tx.socialAccount.update({ where: { id: existing["id"] }, data });
        return existing["id"] as string;
      }
      await tx.socialAccount.create({ data: { id: connection.id, userId: connection.userId, platform: "instagram", externalAccountId: connection.externalAccountId, ...data } });
      return connection.id;
    });
  }
  async saveInstagramConnectionWithinLimit(connection: InstagramConnectionWrite, now: Date): Promise<{ status: "saved"; accountId: string } | { status: "limit" }> {
    const save = (includePromotions: boolean) => this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${connection.userId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length === 0) return { status: "limit" as const };
      const planId = await this.effectivePlanIdInTransaction(tx, connection.userId, now, includePromotions);
      const limit = getPlan(planId).limits.connectedAccounts;
      const existing = (await tx.socialAccount.findMany({ where: { userId: connection.userId, platform: "instagram", externalAccountId: connection.externalAccountId }, select: { id: true, status: true } }))[0];
      const connectedCount = await tx.socialAccount.count({ where: { userId: connection.userId, platform: "instagram", status: "connected" } });
      if (existing?.["status"] !== "connected" && connectedCount >= limit) return { status: "limit" as const };
      const data = { username: connection.username, accountType: connection.accountType, grantedScopes: connection.grantedScopes.join(" "), tokenExpiresAt: connection.tokenExpiresAt, encryptedAccessToken: connection.encryptedAccessToken, status: "connected" };
      if (existing) {
        await tx.socialAccount.update({ where: { id: existing["id"] }, data });
        return { status: "saved" as const, accountId: String(existing["id"]) };
      }
      await tx.socialAccount.create({ data: { id: connection.id, userId: connection.userId, platform: "instagram", externalAccountId: connection.externalAccountId, ...data } });
      return { status: "saved" as const, accountId: connection.id };
    });
    try { return await save(true); }
    catch (error) { if (isPromotionSchemaUnavailable(error)) return save(false); throw error; }
  }
  async disconnectSocialAccount(userId: string, accountId: string): Promise<boolean> {
    const result = await this.db.socialAccount.updateMany({
      where: { id: accountId, userId },
      data: { status: "disconnected", encryptedAccessToken: null, tokenExpiresAt: null, grantedScopes: null },
    });
    return result.count === 1;
  }

  async getInstagramTokenCiphertext(userId: string, accountId: string): Promise<import("../repository.ts").InstagramTokenCiphertext | null> {
    const row = await this.db.socialAccount.findFirst({ where: { id: accountId, userId, platform: "instagram", status: "connected" } });
    const encryptedAccessToken = row?.["encryptedAccessToken"];
    if (!row || typeof encryptedAccessToken !== "string" || encryptedAccessToken.length === 0) return null;
    return { encryptedAccessToken, tokenExpiresAt: row["tokenExpiresAt"] instanceof Date ? row["tokenExpiresAt"] : null, status: row["status"] };
  }
  async updateInstagramTokenCiphertext(userId: string, accountId: string, expectedCiphertext: string, encryptedAccessToken: string, tokenExpiresAt: Date): Promise<boolean> {
    const result = await this.db.socialAccount.updateMany({ where: { id: accountId, userId, platform: "instagram", status: "connected", encryptedAccessToken: expectedCiphertext }, data: { encryptedAccessToken, tokenExpiresAt } });
    return result.count === 1;
  }

  private async usageSum(userId: string, kind: string, monthStart: Date): Promise<number> {
    const sum = await this.db.usageRecord.aggregate({ where: { userId, kind, periodStart: monthStart }, _sum: { amount: true } });
    return Number(sum._sum["amount"] ?? 0);
  }
  async getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }> {
    return { processingSeconds: await this.usageSum(userId, "processing_seconds", monthStart), exports: await this.usageSum(userId, "exports", monthStart) };
  }
  async getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number> { return this.usageSum(userId, "scheduled_items", monthStart); }

  async getRecentPublishTimes(userId: string, since: Date): Promise<Date[]> {
    const cycleIds = (await this.db.publishingCycle.findMany({ where: { ownerId: userId } })).map((c) => c["id"] as string);
    if (cycleIds.length === 0) return [];
    const items = await this.db.cycleItem.findMany({ where: { cycleId: { in: cycleIds }, status: "published", scheduledFor: { gte: since } } });
    return items.map((i) => i["scheduledFor"] as Date);
  }

  async listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]> {
    const rows = await this.db.editingTemplate.findMany({ where: { ownerId: userId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    return rows.map((r) => ({ id: r["id"], ownerId: r["ownerId"], name: r["name"], settings: r["settings"], createdAt: r["createdAt"] }));
  }
  async createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${template.ownerId} FOR UPDATE`; // serialise this user's saves
      const rows = await tx.editingTemplate.findMany({ where: { ownerId: template.ownerId } });
      const named = rows.filter((row) => !String(row["name"]).startsWith("v:")).length;
      if (named + 1 > limit) return false;
      await tx.editingTemplate.create({ data: { id: template.id, ownerId: template.ownerId, name: template.name, settings: template.settings, isDefault: false, createdAt: template.createdAt } });
      return true;
    });
  }
  async saveVideoSettings(template: EditingTemplateRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${template.ownerId} FOR UPDATE`;
      const existing = await tx.editingTemplate.findFirst({ where: { ownerId: template.ownerId, name: template.name } });
      if (existing) { await tx.editingTemplate.update({ where: { id: existing["id"] as string }, data: { settings: template.settings } }); return; }
      await tx.editingTemplate.create({ data: { id: template.id, ownerId: template.ownerId, name: template.name, settings: template.settings, isDefault: false, createdAt: template.createdAt } });
    });
  }
  async applyVideoSettingsBatch(input: ApplyVideoSettingsBatchInput): Promise<"applied" | "existing" | "not_owned" | "conflict"> {
    if (input.audit.actorId !== input.ownerId || input.audit.action !== "editor.bulk_applied" || input.audit.entityType !== "BulkEditDraft" || input.audit.entityId !== input.operationId || input.audit.metadata?.["operationFingerprint"] !== input.operationFingerprint || !/^[a-f0-9]{64}$/.test(input.operationFingerprint)) return "conflict";
    const mediaIds = input.templates.map((template) => template.name.startsWith("v:") ? template.name.slice(2) : "");
    if (input.templates.length === 0 || new Set(mediaIds).size !== mediaIds.length || input.expectedSettings.length !== input.templates.length || input.templates.some((template, index) => template.ownerId !== input.ownerId || !/^[A-Za-z0-9_-]{1,64}$/.test(mediaIds[index] ?? "") || template.name !== `v:${mediaIds[index]}` || input.expectedSettings[index]?.name !== template.name)) return "conflict";
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.ownerId} FOR UPDATE`;
      if (!Array.isArray(locked) || locked.length === 0) return "not_owned";
      const prior = await tx.auditLog.findFirst({ where: { action: input.audit.action, entityType: input.audit.entityType, entityId: input.operationId }, select: { actorId: true, metadata: true } });
      if (prior) {
        const metadata = prior["metadata"];
        return prior["actorId"] === input.ownerId && typeof metadata === "object" && metadata !== null && (metadata as Record<string, unknown>)["operationFingerprint"] === input.operationFingerprint ? "existing" : "conflict";
      }
      const owned = await tx.mediaAsset.findMany({ where: { id: { in: mediaIds }, ownerId: input.ownerId, status: "active", kind: "video" }, select: { id: true } });
      if (owned.length !== mediaIds.length) return "not_owned";
      if (input.requiredImageIds.length > 0) {
        const images = await tx.mediaAsset.findMany({ where: { id: { in: input.requiredImageIds }, ownerId: input.ownerId, status: "active", kind: "image" }, select: { id: true } });
        if (images.length !== new Set(input.requiredImageIds).size) return "not_owned";
      }
      for (let index = 0; index < input.templates.length; index++) {
        const template = input.templates[index]!; const expected = input.expectedSettings[index]!.settings;
        const current = await tx.editingTemplate.findFirst({ where: { ownerId: input.ownerId, name: template.name }, select: { settings: true } });
        if (expected === null ? Boolean(current) : !current || (() => { const parsed = parseEditingSettings(current["settings"]); return !parsed.ok || stableJson(parsed.settings) !== stableJson(expected); })()) return "conflict";
      }
      for (const template of input.templates) {
        const existing = await tx.editingTemplate.findFirst({ where: { ownerId: input.ownerId, name: template.name }, select: { id: true } });
        if (existing) await tx.editingTemplate.update({ where: { id: existing["id"] as string }, data: { settings: template.settings } });
        else await tx.editingTemplate.create({ data: { id: template.id, ownerId: template.ownerId, name: template.name, settings: template.settings, isDefault: false, createdAt: template.createdAt } });
      }
      await tx.auditLog.create({ data: { actorId: input.audit.actorId, action: input.audit.action, entityType: input.audit.entityType, entityId: input.audit.entityId, metadata: input.audit.metadata ?? null } });
      return "applied";
    });
  }
  async listAuditsForEntities(entityType: string, entityIds: string[]): Promise<{ entityId: string; action: string; metadata: Record<string, unknown> | null }[]> {
    if (entityIds.length === 0) return [];
    const rows = await this.db.auditLog.findMany({ where: { entityType, entityId: { in: entityIds } } });
    return rows.map((row) => ({ entityId: row["entityId"] as string, action: row["action"] as string, metadata: (row["metadata"] as Record<string, unknown> | null) ?? null }));
  }

  async saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void> {
    if (revisions.length > 0) await this.db.captionRevision.createMany({ data: revisions.map((r) => ({ cycleItemId: r.itemId, previousText: r.previousText, newText: r.newText, source: r.source, changedById: r.changedBy, changedAt: r.changedAt })) });
  }
  async findRenderOutput(ownerId: string, sourceMediaId: string, settingsHash: string): Promise<{ id: string; sizeBytes: number } | null> {
    const row = await this.db.mediaDerivative.findFirst({ where: { ownerId, mediaAssetId: sourceMediaId, kind: "render", settingsHash } });
    return row ? { id: row["id"], sizeBytes: Number(row["sizeBytes"]) } : null;
  }
  async countRenderOutputsSince(ownerId: string, since: Date): Promise<number> {
    return this.db.mediaDerivative.count({ where: { ownerId, kind: "render", createdAt: { gte: since } } });
  }
  async saveRenderOutput(record: { id: string; sourceMediaId: string; ownerId: string; storageKey: string; sizeBytes: number; settingsHash: string; createdAt: Date }, limitBytes: number, fence?: import("../repository.ts").RenderJobFence): Promise<SaveRenderResult> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${record.ownerId} FOR UPDATE`;
      if (fence) {
        const currentJob = await tx.processingJob.findFirst({ where: { id: fence.id, ownerId: fence.ownerId, kind: "render", status: "running", lockToken: fence.lockToken } });
        if (!currentJob) return { status: "stale_job" };
      }
      const existing = await tx.mediaDerivative.findFirst({ where: { ownerId: record.ownerId, mediaAssetId: record.sourceMediaId, kind: "render", settingsHash: record.settingsHash } });
      if (existing) return { status: "duplicate", id: existing["id"] as string };
      const mediaSum = await tx.mediaAsset.aggregate({ where: { ownerId: record.ownerId, status: { not: "deleted" } }, _sum: { sizeBytes: true } });
      const renderSum = await tx.mediaDerivative.aggregate({ where: { ownerId: record.ownerId, kind: "render" }, _sum: { sizeBytes: true } });
      if (Number(mediaSum._sum["sizeBytes"] ?? 0) + Number(renderSum._sum["sizeBytes"] ?? 0) + record.sizeBytes > limitBytes) return { status: "over_quota" };
      await tx.mediaDerivative.create({ data: { id: record.id, mediaAssetId: record.sourceMediaId, ownerId: record.ownerId, kind: "render", storageKey: record.storageKey, sizeBytes: BigInt(record.sizeBytes), settingsHash: record.settingsHash, createdAt: record.createdAt } });
      return { status: "saved", id: record.id };
    });
  }
  async listRenderOutputsForOwner(ownerId: string): Promise<RenderOutputRecord[]> {
    const rows = await this.db.mediaDerivative.findMany({ where: { ownerId, kind: "render" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 20 });
    return rows.map((row) => ({ id: row["id"], sourceMediaId: row["mediaAssetId"], ownerId: row["ownerId"], sizeBytes: Number(row["sizeBytes"]), createdAt: row["createdAt"] }));
  }
  async listRenderOutputsForOwnerAndSource(ownerId: string, sourceMediaId: string): Promise<RenderOutputRecord[]> {
    const rows = await this.db.mediaDerivative.findMany({ where: { ownerId, mediaAssetId: sourceMediaId, kind: "render" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    return rows.map((row) => ({ id: row["id"], ownerId: row["ownerId"], sourceMediaId: row["mediaAssetId"], sizeBytes: Number(row["sizeBytes"]), createdAt: row["createdAt"] }));
  }
  async listRenderOutputPreviewsForOwner(ownerId: string, sourceMediaIds: string[]): Promise<{ id: string; sourceMediaId: string; settingsHash: string }[]> {
    if (sourceMediaIds.length === 0) return [];
    const rows = await this.db.mediaDerivative.findMany({
      where: { ownerId, mediaAssetId: { in: sourceMediaIds }, kind: "render" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, mediaAssetId: true, settingsHash: true },
    });
    return rows.map((row) => ({ id: row["id"], sourceMediaId: row["mediaAssetId"], settingsHash: row["settingsHash"] }));
  }
  async createRenderJob(job: RenderJobRecord): Promise<CreateRenderJobResult> {
    try {
      const row = await this.db.processingJob.create({ data: renderJobToRow(job) });
      return { status: "created", job: renderJobFromRow(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.processingJob.findUnique({ where: { idempotencyKey: job.idempotencyKey } });
      if (existing && existing["kind"] === "render" && existing["ownerId"] === job.ownerId && existing["mediaAssetId"] === job.mediaAssetId && existing["settingsHash"] === job.settingsHash && stableJson(existing["payload"] ?? null) === stableJson(job.payload ?? null)) return { status: "existing", job: renderJobFromRow(existing) };
      return { status: "conflict" };
    }
  }
  async getRenderJobForOwner(id: string, ownerId: string): Promise<RenderJobRecord | null> {
    const row = await this.db.processingJob.findFirst({ where: { id, ownerId, kind: "render" } });
    return row ? renderJobFromRow(row) : null;
  }
  async getRenderJobByIdempotencyKey(idempotencyKey: string, ownerId: string): Promise<RenderJobRecord | null> {
    const row = await this.db.processingJob.findFirst({ where: { idempotencyKey, ownerId, kind: "render" } });
    return row ? renderJobFromRow(row) : null;
  }
  async listRenderJobsForOwner(ownerId: string): Promise<RenderJobRecord[]> {
    const rows = await this.db.processingJob.findMany({ where: { ownerId, kind: "render" }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    return rows.map(renderJobFromRow);
  }
  async claimNextRenderJob(claim: RenderJobClaim): Promise<RenderJobRecord | null> {
    if (!claim.workerId || !Number.isFinite(claim.leaseSeconds) || claim.leaseSeconds <= 0) return null;
    let includePromotions = true;
    const claimableWhere = { kind: "render", OR: [{ status: "queued" }, { status: "running", lockExpiresAt: { lte: claim.now } }], ...(claim.jobId ? { id: claim.jobId } : {}) };
    const queuedOwners = await this.db.processingJob.findMany({ where: claimableWhere, select: { ownerId: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    for (const ownerId of new Set(queuedOwners.map((row) => String(row["ownerId"])))) {
      try { await this.activateNextPromotionalAccessGrant(ownerId, claim.now); }
      catch (error) { if (isPromotionSchemaUnavailable(error)) { includePromotions = false; break; } throw error; }
    }
    const claimWithEntitlements = (includePromotionalAccess: boolean) => this.db.$transaction(async (tx) => {
      const queued = await tx.processingJob.findMany({ where: claimableWhere, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      for (const candidate of queued) {
        const ownerId = candidate["ownerId"] as string;
        // Serialize claims for one account. Different users lock different rows and can proceed independently.
        const lockedUsers = await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(lockedUsers) || lockedUsers.length === 0) continue;
        const planId = await this.effectivePlanIdInTransaction(tx, ownerId, claim.now, includePromotionalAccess);
        const limit = getPlan(planId).limits.concurrentJobs;
        const running = await tx.processingJob.count({ where: { ownerId, kind: "render", status: "running", lockExpiresAt: { gt: claim.now } } });
        if (running >= limit) continue;

        const lockToken = randomUUID();
        const update = await tx.processingJob.updateMany({
          where: { id: candidate["id"], ownerId, kind: "render", status: candidate["status"], ...(candidate["status"] === "running" ? { lockToken: candidate["lockToken"], lockExpiresAt: { lte: claim.now } } : {}) },
          data: { status: "running", lockedBy: claim.workerId, lockToken, lockExpiresAt: new Date(claim.now.getTime() + claim.leaseSeconds * 1000), attempts: { increment: 1 }, pendingOutputId: randomUUID(), ffmpegPid: null, ffmpegStartedAt: null },
        });
        if (update.count !== 1) continue;
        const row = await tx.processingJob.findFirst({ where: { id: candidate["id"], ownerId, kind: "render", status: "running", lockToken } });
        if (row) return renderJobFromRow(row);
      }
      return null;
    });
    if (!includePromotions) return claimWithEntitlements(false);
    try { return await claimWithEntitlements(true); }
    catch (error) { if (isPromotionSchemaUnavailable(error)) return claimWithEntitlements(false); throw error; }
  }
  private async updateWorkerOwnedRenderJob(id: string, ownerId: string, lockToken: string, data: Record<string, unknown>): Promise<boolean> {
    if (!lockToken) return false;
    const result = await this.db.processingJob.updateMany({ where: { id, ownerId, kind: "render", status: "running", lockToken }, data });
    return result.count === 1;
  }
  async heartbeatRenderJob(id: string, ownerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean> {
    if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return false;
    return this.updateWorkerOwnedRenderJob(id, ownerId, lockToken, { lockExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) });
  }
  async updateRenderJobProgress(id: string, ownerId: string, lockToken: string, progressPercent: number): Promise<boolean> {
    if (!Number.isInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) return false;
    return this.updateWorkerOwnedRenderJob(id, ownerId, lockToken, { progressPercent });
  }
  async completeRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, outputDerivativeId: string): Promise<boolean> {
    if (!outputDerivativeId) return false;
    return this.updateWorkerOwnedRenderJob(id, ownerId, lockToken, { status: "succeeded", progressPercent: 100, finishedAt, outputDerivativeId, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async failRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date, errorMessage: string): Promise<boolean> {
    return this.updateWorkerOwnedRenderJob(id, ownerId, lockToken, { status: "failed", finishedAt, errorMessage, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async cancelRenderJob(id: string, ownerId: string, lockToken: string, finishedAt: Date): Promise<boolean> {
    return this.updateWorkerOwnedRenderJob(id, ownerId, lockToken, { status: "cancelled", finishedAt, lockToken: null, lockedBy: null, lockExpiresAt: null });
  }
  async getRenderOutput(id: string): Promise<{ id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string } | null> {
    const row = await this.db.mediaDerivative.findUnique({ where: { id } });
    return row && row["kind"] === "render" ? { id: row["id"], ownerId: row["ownerId"], sourceMediaId: row["mediaAssetId"], sizeBytes: Number(row["sizeBytes"]), storageKey: row["storageKey"] } : null;
  }
  async addUsageRecords(records: UsageRecordDraft[]): Promise<void> {
    for (const record of records) {
      try {
        await this.db.usageRecord.create({ data: { userId: record.userId, kind: record.kind, amount: BigInt(record.amount), periodStart: record.periodStart, idempotencyKey: record.idempotencyKey } });
      } catch (error) { if (!isUniqueViolation(error)) throw error; }
    }
  }
  async updateCycleRepeat(cycleId: string, ownerId: string, repeatBehavior: "never" | "ask" | "automatic"): Promise<boolean> {
    const result = await this.db.publishingCycle.updateMany({ where: { id: cycleId, ownerId, deletedAt: null }, data: { repeatBehavior } });
    return result.count === 1;
  }
  async listPublishingJobsForAccount(userId: string, socialAccountId: string): Promise<PublishingJobRecord[]> {
    const cycles = await this.db.publishingCycle.findMany({ where: { ownerId: userId, socialAccountId } });
    if (cycles.length === 0) return [];
    const items = await this.db.cycleItem.findMany({ where: { cycleId: { in: cycles.map((cycle) => cycle["id"]) } } });
    if (items.length === 0) return [];
    const rows = await this.db.publishingJob.findMany({ where: { cycleItemId: { in: items.map((item) => item["id"]) } } });
    const outcomes = new Set(["in_progress", "success", "definite_failure", "ambiguous"]);
    return rows.flatMap((row) => {
      const outcome = row["outcome"];
      const startedAt = row["startedAt"];
      if (typeof outcome !== "string" || !outcomes.has(outcome) || !(startedAt instanceof Date)) return [];
      return [{ id: String(row["id"]), cycleItemId: String(row["cycleItemId"]), outcome: outcome as PublishingJobRecord["outcome"], startedAt }];
    });
  }
  async listDuePublishingCandidates(now: Date, limit: number): Promise<import("../repository.ts").DuePublishingCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const rows = await this.db.cycleItem.findMany({ where: { status: "scheduled", scheduledFor: { lte: now } }, orderBy: [{ scheduledFor: "asc" }, { position: "asc" }, { id: "asc" }], take: Math.min(limit, 500) });
    const candidates: import("../repository.ts").DuePublishingCandidate[] = [];
    for (const row of rows) {
      const cycle = await this.getCycle(String(row["cycleId"]));
      if (!cycle || cycle.status !== "running") continue;
      const account = await this.getSocialAccount(cycle.socialAccountId);
      candidates.push({ cycle, item: rowToItem(row), account });
    }
    return candidates;
  }
  async listPublishingAttemptsForItem(ownerId: string, cycleId: string, cycleItemId: string): Promise<PublishingAttemptRecord[]> {
    const rows = await this.db.publishingJob.findMany({ where: { ownerId, cycleId, cycleItemId }, orderBy: [{ attemptNumber: "asc" }, { id: "asc" }] });
    return rows.map(publishingAttemptFromRow);
  }
  async listActivePublishingAttemptsForWorker(workerId: string, now: Date, limit: number): Promise<PublishingAttemptRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const rows = await this.db.publishingJob.findMany({ where: { workerId, stage: { in: ["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"] }, leaseExpiresAt: { gt: now } }, orderBy: [{ startedAt: "asc" }, { id: "asc" }], take: Math.min(limit, 500) });
    return rows.map(publishingAttemptFromRow);
  }
  async listExpiredActivePublishingAttempts(now: Date, limit: number): Promise<{ jobId: string; ownerId: string }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const rows = await this.db.publishingJob.findMany({ where: { stage: { in: ["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"] }, leaseExpiresAt: { lte: now } }, orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }], take: Math.min(limit, 500) });
    return rows.map((row) => ({ jobId: String(row["id"]), ownerId: String(row["ownerId"]) }));
  }
  async createOrGetPublishingAttempt(input: CreatePublishingAttemptInput): Promise<{ status: "created" | "existing" | "conflict"; job?: PublishingAttemptRecord }> {
    if (input.idempotencyKey !== buildPublishIdempotencyKey({ cycleId: input.cycleId, id: input.cycleItemId }, input.attemptNumber)) return { status: "conflict" };
    const identityMatches = (row: Record<string, unknown>) => row["ownerId"] === input.ownerId && row["cycleId"] === input.cycleId && row["cycleItemId"] === input.cycleItemId && row["socialAccountId"] === input.socialAccountId;
    try {
      const result = await this.db.$transaction(async (tx) => {
        const lockedCycle = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${input.cycleId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(lockedCycle) || lockedCycle.length !== 1) return { status: "conflict" as const };
        const [cycle, item, account] = await Promise.all([tx.publishingCycle.findUnique({ where: { id: input.cycleId } }), tx.cycleItem.findUnique({ where: { id: input.cycleItemId } }), tx.socialAccount.findUnique({ where: { id: input.socialAccountId } })]);
        if (!cycle || cycle["deletedAt"] instanceof Date || !item || !account || cycle["ownerId"] !== input.ownerId || cycle["socialAccountId"] !== input.socialAccountId || item["cycleId"] !== input.cycleId || item["cycleOwnerId"] !== input.ownerId || account["userId"] !== input.ownerId || input.attemptNumber < 1) return { status: "conflict" as const };
        const existing = await tx.publishingJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return identityMatches(existing) ? { status: "existing" as const, job: publishingAttemptFromRow(existing) } : { status: "conflict" as const };
        const row = await tx.publishingJob.create({ data: { id: input.id, ownerId: input.ownerId, cycleId: input.cycleId, cycleItemId: input.cycleItemId, socialAccountId: input.socialAccountId, attemptNumber: input.attemptNumber, idempotencyKey: input.idempotencyKey, stage: "queued", outcome: "in_progress", startedAt: input.now, createdAt: input.now, updatedAt: input.now } });
        return { status: "created" as const, job: publishingAttemptFromRow(row) };
      });
      return result;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.publishingJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      return existing && identityMatches(existing) ? { status: "existing", job: publishingAttemptFromRow(existing) } : { status: "conflict" };
    }
  }
  async claimPublishingAttempt(input: ClaimPublishingAttemptInput): Promise<PublishingAttemptRecord | null> {
    const stale = Symbol("claim lost");
    try {
      return await this.db.$transaction(async (tx) => {
        // Serializes claims for one account. The partial unique index is the second line of defense.
        const locked = await tx.$queryRaw`SELECT "id" FROM "SocialAccount" WHERE "id" = ${input.socialAccountId} FOR UPDATE`;
        if (!Array.isArray(locked) || locked.length !== 1) return null;
        const cycleLock = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${input.cycleId} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(cycleLock) || cycleLock.length !== 1) return null;
        const [job, cycle, item, account] = await Promise.all([tx.publishingJob.findUnique({ where: { id: input.attemptId } }), tx.publishingCycle.findUnique({ where: { id: input.cycleId } }), tx.cycleItem.findUnique({ where: { id: input.cycleItemId } }), tx.socialAccount.findUnique({ where: { id: input.socialAccountId } })]);
        if (!job || job["stage"] !== "queued" || !cycle || !item || !account) return null;
        const accountEligibility = evaluateInstagramEligibility({ platform: account["platform"], status: account["status"], accountType: account["accountType"], grantedScopes: account["grantedScopes"], hasToken: typeof account["encryptedAccessToken"] === "string" && account["encryptedAccessToken"].length > 0, tokenExpiresAt: account["tokenExpiresAt"], now: input.now });
        const eligible = accountEligibility.eligible && account["userId"] === input.ownerId;
        const valid = eligible && cycle["deletedAt"] == null && cycle["ownerId"] === input.ownerId && cycle["socialAccountId"] === input.socialAccountId && cycle["status"] === "running" && item["cycleId"] === input.cycleId && item["cycleOwnerId"] === input.ownerId && item["version"] === input.expectedItemVersion && (item["status"] === "upcoming" || item["status"] === "scheduled") && (!(item["scheduledFor"] instanceof Date) || item["scheduledFor"] <= input.now) && job["ownerId"] === input.ownerId && job["cycleId"] === input.cycleId && job["cycleItemId"] === input.cycleItemId && job["socialAccountId"] === input.socialAccountId;
        if (!valid) return null;
        const active = await tx.publishingJob.findFirst({ where: { socialAccountId: input.socialAccountId, stage: { in: ["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"] } } });
        if (active) return null;
        const lockToken = randomUUID(), expiresAt = new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000);
        const itemUpdate = await tx.cycleItem.updateMany({ where: { id: input.cycleItemId, cycleId: input.cycleId, cycleOwnerId: input.ownerId, version: input.expectedItemVersion, status: item["status"], scheduledFor: item["scheduledFor"] ?? null }, data: { status: "publishing", lockedBy: input.workerId, lockExpiresAt: expiresAt, version: { increment: 1 } } });
        if (itemUpdate.count !== 1) return null;
        const claimed = await tx.publishingJob.updateMany({ where: { id: input.attemptId, ownerId: input.ownerId, stage: "queued", lockToken: null }, data: { stage: "claimed", workerId: input.workerId, lockToken, leaseExpiresAt: expiresAt, startedAt: input.now, updatedAt: input.now } });
        if (claimed.count !== 1) throw stale;
        const row = await tx.publishingJob.findUnique({ where: { id: input.attemptId } });
        return row ? publishingAttemptFromRow(row) : null;
      });
    } catch (error) { if (error === stale) return null; throw error; }
  }
  async transitionPublishingAttempt(input: PublishingAttemptUpdate): Promise<boolean> {
    if (!canTransitionPublishingAttempt(input.expectedStage, input.nextStage) || (input.nextStage === "published" && !input.instagramMediaId) || (input.instagramMediaId && input.nextStage !== "published") || (input.nextStage === "container_processing" && !input.containerId)) return false;
    const terminal = ["published", "failed", "needs_manual_review"].includes(input.nextStage);
    const outcome = publishingOutcomeForStage(input.nextStage);
    const safeError = input.errorCategory !== undefined || input.errorDetails !== undefined ? safePublishingError(input.errorCategory) : null;
    const data: Record<string, unknown> = { stage: input.nextStage, outcome, updatedAt: input.now, ...(terminal ? { finishedAt: input.now, workerId: null, lockToken: null, leaseExpiresAt: null } : {}), ...(input.leaseSeconds === undefined ? {} : { leaseExpiresAt: new Date(input.now.getTime() + Math.max(1, input.leaseSeconds) * 1000) }), ...(input.containerId === undefined ? {} : { containerId: input.containerId }), ...(input.instagramMediaId === undefined ? {} : { instagramMediaId: input.instagramMediaId }), ...(safeError ? { errorCategory: safeError.category, errorDetails: safeError.details } : {}) };
    const stale = Symbol("attempt changed");
    try {
      return await this.db.$transaction(async (tx) => {
        const initial = await tx.publishingJob.findUnique({ where: { id: input.jobId } });
        if (!initial || initial["ownerId"] !== input.ownerId) return false;
        const cycleLock = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${initial["cycleId"]} AND "ownerId" = ${input.ownerId} FOR UPDATE`;
        if (!Array.isArray(cycleLock) || cycleLock.length !== 1) return false;
        const cycle = await tx.publishingCycle.findUnique({ where: { id: initial["cycleId"] } });
        if (!cycle || cycle["deletedAt"] instanceof Date) return false;
        const job = await tx.publishingJob.findUnique({ where: { id: input.jobId } });
        if (!job || job["ownerId"] !== input.ownerId || job["workerId"] !== input.workerId || job["lockToken"] !== input.lockToken || job["stage"] !== input.expectedStage || !(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] <= input.now) return false;
        if (["ready_to_publish", "publishing"].includes(input.nextStage) && !(input.containerId ?? job["containerId"])) return false;
        if (terminal) {
          const itemStatus = input.nextStage === "published" ? "published" : input.nextStage === "failed" ? "failed" : "needs_review";
          const item = await tx.cycleItem.updateMany({ where: { id: job["cycleItemId"], status: "publishing", lockedBy: input.workerId }, data: { status: itemStatus, externalPostId: input.nextStage === "published" ? input.instagramMediaId : undefined, publishedAt: input.nextStage === "published" ? input.now : undefined, lockedBy: null, lockExpiresAt: null, reviewReason: input.nextStage === "needs_manual_review" ? "ambiguous_publish_result" : null, version: { increment: 1 } } });
          if (item.count !== 1) throw stale;
        }
        const changed = await tx.publishingJob.updateMany({ where: { id: input.jobId, ownerId: input.ownerId, workerId: input.workerId, lockToken: input.lockToken, stage: input.expectedStage, leaseExpiresAt: { gt: input.now } }, data });
        if (changed.count !== 1) throw stale;
        return true;
      });
    } catch (error) { if (error === stale) return false; throw error; }
  }
  async heartbeatPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date, leaseSeconds: number): Promise<boolean> {
    const initial = await this.db.publishingJob.findUnique({ where: { id: jobId }, select: { cycleId: true } });
    if (!initial) return false;
    return this.db.$transaction(async (tx) => {
      const lockedCycle = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${initial["cycleId"]} AND "ownerId" = ${ownerId} FOR UPDATE`;
      if (!Array.isArray(lockedCycle) || lockedCycle.length !== 1) return false;
      const job = await tx.publishingJob.findUnique({ where: { id: jobId } });
      if (!job || job["ownerId"] !== ownerId || job["workerId"] !== workerId || job["lockToken"] !== lockToken || !isActivePublishingAttempt(job["stage"] as PublishingAttemptRecord["stage"]) || !(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] <= now) return false;
      const cycle = await tx.publishingCycle.findUnique({ where: { id: initial["cycleId"] } });
      if (!cycle || cycle["deletedAt"] instanceof Date) return false;
      const changed = await tx.publishingJob.updateMany({ where: { id: jobId, ownerId, workerId, lockToken, stage: job["stage"], leaseExpiresAt: { gt: now } }, data: { leaseExpiresAt: new Date(now.getTime() + Math.max(1, leaseSeconds) * 1000), updatedAt: now } });
      return changed.count === 1;
    });
  }
  async cancelPublishingAttempt(jobId: string, ownerId: string, now: Date): Promise<boolean> {
    const stale = Symbol("cancel changed");
    const initial = await this.db.publishingJob.findUnique({ where: { id: jobId }, select: { cycleId: true } });
    if (!initial) return false;
    try {
      return await this.db.$transaction(async (tx) => {
        const cycleLock = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${initial["cycleId"]} AND "ownerId" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(cycleLock) || cycleLock.length !== 1) return false;
        const job = await tx.publishingJob.findUnique({ where: { id: jobId } });
        if (!job || job["ownerId"] !== ownerId || (job["stage"] !== "queued" && job["stage"] !== "claimed")) return false;
        if (job["stage"] === "claimed" && (!(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] > now)) return false;
        if (job["stage"] === "claimed") {
          const item = await tx.cycleItem.findUnique({ where: { id: job["cycleItemId"] } });
          if (!item || item["status"] !== "publishing" || item["lockedBy"] !== job["workerId"]) return false;
          const changedItem = await tx.cycleItem.updateMany({ where: { id: item["id"], status: "publishing", lockedBy: job["workerId"], version: item["version"] }, data: { status: "scheduled", lockedBy: null, lockExpiresAt: null, version: { increment: 1 } } });
          if (changedItem.count !== 1) throw stale;
        }
        const changed = await tx.publishingJob.updateMany({ where: { id: jobId, ownerId, stage: job["stage"] }, data: { stage: "cancelled", outcome: "in_progress", workerId: null, lockToken: null, leaseExpiresAt: null, updatedAt: now, finishedAt: now } });
        if (changed.count !== 1) throw stale;
        return true;
      });
    } catch (error) { if (error === stale) return false; throw error; }
  }
  async cancelClaimedPublishingAttempt(jobId: string, ownerId: string, workerId: string, lockToken: string, now: Date): Promise<boolean> {
    const stale = Symbol("claim cancellation changed");
    const initial = await this.db.publishingJob.findUnique({ where: { id: jobId }, select: { cycleId: true } });
    if (!initial) return false;
    try {
      return await this.db.$transaction(async (tx) => {
        const cycleLock = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${initial["cycleId"]} AND "ownerId" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(cycleLock) || cycleLock.length !== 1) return false;
        const job = await tx.publishingJob.findUnique({ where: { id: jobId } });
        if (!job || job["ownerId"] !== ownerId || job["workerId"] !== workerId || job["lockToken"] !== lockToken || job["stage"] !== "claimed" || !(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] <= now) return false;
        const [item, cycle] = await Promise.all([tx.cycleItem.findUnique({ where: { id: job["cycleItemId"] } }), tx.publishingCycle.findUnique({ where: { id: job["cycleId"] } })]);
        if (!item || !cycle || cycle["ownerId"] !== ownerId || item["status"] !== "publishing" || item["lockedBy"] !== workerId) return false;
        const restoredStatus = cycle["status"] === "stopped" || cycle["status"] === "completed" ? "cancelled" : item["scheduledFor"] ? "scheduled" : "upcoming";
        const itemUpdate = await tx.cycleItem.updateMany({ where: { id: item["id"], cycleId: job["cycleId"], cycleOwnerId: ownerId, status: "publishing", lockedBy: workerId, version: item["version"] }, data: { status: restoredStatus, lockedBy: null, lockExpiresAt: null, version: { increment: 1 } } });
        if (itemUpdate.count !== 1) throw stale;
        const jobUpdate = await tx.publishingJob.updateMany({ where: { id: jobId, ownerId, workerId, lockToken, stage: "claimed", leaseExpiresAt: { gt: now } }, data: { stage: "cancelled", workerId: null, lockToken: null, leaseExpiresAt: null, updatedAt: now, finishedAt: now } });
        if (jobUpdate.count !== 1) throw stale;
        return true;
      });
    } catch (error) { if (error === stale) return false; throw error; }
  }
  async markExpiredPublishingAttemptForReview(jobId: string, ownerId: string, now: Date): Promise<boolean> {
    const stale = Symbol("expired attempt changed");
    const initial = await this.db.publishingJob.findUnique({ where: { id: jobId }, select: { cycleId: true } });
    if (!initial) return false;
    try {
      return await this.db.$transaction(async (tx) => {
        const cycleLock = await tx.$queryRaw`SELECT "id" FROM "PublishingCycle" WHERE "id" = ${initial["cycleId"]} AND "ownerId" = ${ownerId} FOR UPDATE`;
        if (!Array.isArray(cycleLock) || cycleLock.length !== 1) return false;
        const job = await tx.publishingJob.findUnique({ where: { id: jobId } });
        if (!job || job["ownerId"] !== ownerId || !isActivePublishingAttempt(job["stage"] as PublishingAttemptRecord["stage"]) || !(job["leaseExpiresAt"] instanceof Date) || job["leaseExpiresAt"] > now) return false;
        const item = await tx.cycleItem.findUnique({ where: { id: job["cycleItemId"] } });
        if (!item || item["status"] !== "publishing" || item["lockedBy"] !== job["workerId"]) return false;
        const changedItem = await tx.cycleItem.updateMany({ where: { id: item["id"], status: "publishing", lockedBy: job["workerId"], version: item["version"] }, data: { status: "needs_review", lockedBy: null, lockExpiresAt: null, reviewReason: "worker_lost_during_publish", version: { increment: 1 } } });
        if (changedItem.count !== 1) throw stale;
        const changed = await tx.publishingJob.updateMany({ where: { id: jobId, ownerId, stage: job["stage"], leaseExpiresAt: { lte: now }, lockToken: job["lockToken"] }, data: { stage: "needs_manual_review", outcome: "ambiguous", workerId: null, lockToken: null, leaseExpiresAt: null, errorCategory: "worker_lease_expired", errorDetails: "The worker lease expired; the external outcome was not verified.", updatedAt: now, finishedAt: now } });
        if (changed.count !== 1) throw stale;
        return true;
      });
    } catch (error) { if (error === stale) return false; throw error; }
  }
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.db.auditLog.create({ data: { actorId: entry.actorId, action: entry.action, entityType: entry.entityType, entityId: entry.entityId, metadata: entry.metadata ?? null } });
  }
}
