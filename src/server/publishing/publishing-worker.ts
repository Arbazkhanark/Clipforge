import { randomUUID } from "node:crypto";
import { getPlan } from "../../lib/billing/catalog.ts";
import { buildPreflightReport } from "../preflight-service.ts";
import type { RequestContext } from "../context.ts";
import type { DuePublishingCandidate, PublishingAttemptRecord, PublishingAttemptUpdate, PublishingJobStage, Repository } from "../repository.ts";
import { buildPublishIdempotencyKey, isCycleFinished } from "../../lib/domain/cycle-state.ts";
import type { PreflightReport } from "../../lib/domain/preflight.ts";
import { evaluateInstagramEligibility } from "../../lib/integrations/instagram-eligibility.ts";
import type { MediaStorage } from "../storage/media-storage.ts";
import { prepareTemporaryPublishingAccess, prepareTemporaryPublishingCoverAccess, type TemporaryMediaAccessAdapter } from "../storage/temporary-media-access.ts";

export interface PublishingAdapterInput {
  attemptId: string;
  idempotencyKey: string;
  cycleId: string;
  cycleItemId: string;
  ownerId: string;
  socialAccountId: string;
  instagramAccountId?: string;
  mediaAssetId: string;
  caption: string;
  containerId?: string;
  renderOutputId?: string;
  selectedRenderOutputId?: string;
  videoUrl?: string;
  coverUrl?: string;
  coverSelected?: boolean;
  /** Optional existing Reel frame-selection setting, in milliseconds. No CycleItem field currently persists it. */
  thumbOffsetMs?: number;
}
export type ContainerCreationResult = { kind: "created"; containerId: string } | { kind: "definite_failure"; category: string } | { kind: "ambiguous" };
export type ContainerPollResult = { kind: "processing" } | { kind: "ready" } | { kind: "definite_failure"; category: string } | { kind: "ambiguous" };
export type PublishingResult = { kind: "confirmed"; instagramMediaId: string } | { kind: "definite_failure"; category: string } | { kind: "ambiguous" };
export type PublishingVerificationResult = { kind: "confirmed"; instagramMediaId: string } | { kind: "not_published" } | { kind: "unknown" };
export type PublishingQuotaResult = { kind: "available"; usage: number; total: number; durationSeconds: number } | { kind: "limit_reached"; usage: number; total: number; durationSeconds: number } | { kind: "unknown" };

/** Adapter boundaries are intentionally transport-agnostic. No token or lock token crosses them. */
export interface PublishingAdapters {
  createContainer(input: PublishingAdapterInput): Promise<ContainerCreationResult>;
  pollContainer(input: PublishingAdapterInput & { containerId: string }): Promise<ContainerPollResult>;
  publishContainer(input: PublishingAdapterInput & { containerId: string }): Promise<PublishingResult>;
  verifyPublishingResult(input: PublishingAdapterInput & { containerId?: string }): Promise<PublishingVerificationResult>;
  checkPublishingQuota(input: PublishingAdapterInput): Promise<PublishingQuotaResult>;
}

export interface MockPublishingAdapterScenario {
  containerCreation?: ContainerCreationResult;
  containerStatus?: ContainerPollResult;
  publishing?: PublishingResult;
  verification?: PublishingVerificationResult;
  /** Synthetic only. Never represents an observed account quota. */
  publishingQuota?: PublishingQuotaResult;
}

/** Local test adapter only. Defaults are non-success responses and performs no I/O. */
export function createMockPublishingAdapters(scenario: MockPublishingAdapterScenario = {}): PublishingAdapters {
  return {
    async createContainer(input) { return structuredClone(scenario.containerCreation ?? { kind: "definite_failure", category: "container_rejected" }); },
    async pollContainer(input) { return structuredClone(scenario.containerStatus ?? { kind: "processing" }); },
    async publishContainer(input) { return structuredClone(scenario.publishing ?? { kind: "ambiguous" }); },
    async verifyPublishingResult(input) { return structuredClone(scenario.verification ?? { kind: "unknown" }); },
    async checkPublishingQuota(input) { return structuredClone(scenario.publishingQuota ?? { kind: "available", usage: 0, total: 100, durationSeconds: 86_400 }); },
  };
}

export type PublishingWorkerResult =
  | { status: "disabled" | "busy" | "idle" | "skipped" | "cancelled" | "claimed" | "processing" | "failed" | "needs_manual_review" | "published" | "blocked"; itemId?: string; attemptId?: string; reason?: string };

export interface PublishingWorkerOptions {
  repo: Repository;
  adapters: PublishingAdapters;
  now: () => Date;
  newId: () => string;
  workerId?: string;
  leaseSeconds?: number;
  batchSize?: number;
  /** False by default. This is invoked manually; no scheduler starts it. */
  enabled?: boolean;
  /** Optional media storage used to verify that the selected output still exists. */
  storage?: MediaStorage | null;
  /** Optional temporary media access adapter to mint short-lived URLs for container creation. */
  mediaAccess?: TemporaryMediaAccessAdapter | null;
  /** Production adapter mode requires a provider-attested public URL; mock URLs never satisfy this. */
  requirePublicMedia?: boolean;
  /** When omitted, the existing server preflight is used and its unavailable public media URL blocks work. */
  context?: Pick<RequestContext, "repo" | "newId" | "config" | "media" | "publishingMediaAccess">;
  /** Injectable only for isolated orchestration tests or a future trusted service boundary. */
  preflight?: (candidate: DuePublishingCandidate, items: Awaited<ReturnType<Repository["getCycleItems"]>>, now: Date) => Promise<PreflightReport>;
  /** Cancellation is honored only before container creation begins. */
  cancellationRequested?: (candidate: DuePublishingCandidate, stage: "queued" | "claimed") => boolean | Promise<boolean>;
}

const SAFE_CATEGORIES = new Set(["account_ineligible", "permission_missing", "media_unavailable", "rate_limited", "container_rejected", "container_timeout", "publish_rejected", "publish_timeout", "api_error", "unknown"]);
const safeCategory = (category: string): string => SAFE_CATEGORIES.has(category) ? category : "unknown";
const ACTIVE_STAGES: PublishingJobStage[] = ["claimed", "container_creation_pending", "container_processing", "ready_to_publish", "publishing"];

export class PublishingWorker {
  private readonly options: PublishingWorkerOptions;
  private readonly workerId: string;
  private running = false;
  private cycleSettlementCursor: string | null = null;
  constructor(options: PublishingWorkerOptions) {
    this.options = options;
    this.workerId = options.workerId ?? randomUUID();
  }

  async runOnce(): Promise<PublishingWorkerResult> {
    if (this.options.enabled !== true) return { status: "disabled" };
    if (this.running) return { status: "busy" };
    this.running = true;
    try {
      const result = await this.runEnabledOnce();
      // Settlement is a separate retryable repository transaction. Its failure must not
      // change the result of a publish operation that may already have succeeded.
      await this.settleCompletedCycles().catch(() => undefined);
      return result;
    }
    catch { return { status: "blocked", reason: "The worker could not safely complete this pass." }; }
    finally { this.running = false; }
  }

  private async settleCompletedCycles(): Promise<void> {
    const limit = this.options.batchSize ?? 20;
    const cycles = await this.options.repo.listRunningCyclesForSettlement(this.cycleSettlementCursor, limit);
    if (cycles.length === 0) { this.cycleSettlementCursor = null; return; }
    this.cycleSettlementCursor = cycles.length < limit ? null : cycles[cycles.length - 1]!.id;
    for (const cycle of cycles) {
      const items = await this.options.repo.getCycleItems(cycle.id);
      if (!isCycleFinished(items)) continue;
      const plan = cycle.repeatBehavior === "automatic"
        ? getPlan(await this.options.repo.getPlanIdForUser(cycle.ownerId, this.options.now()))
        : null;
      await this.options.repo.completeSettledCycle({
        cycleId: cycle.id, ownerId: cycle.ownerId, now: this.options.now(),
        activeCycleLimit: plan?.limits.activeCampaigns ?? 0,
        newId: this.options.newId,
      });
    }
  }

  private async runEnabledOnce(): Promise<PublishingWorkerResult> {
    const { repo } = this.options;
    const now = this.options.now();
    const expired = await repo.listExpiredActivePublishingAttempts(now, this.options.batchSize ?? 20);
    const reviewed: { jobId: string; ownerId: string }[] = [];
    for (const attempt of expired) if (await repo.markExpiredPublishingAttemptForReview(attempt.jobId, attempt.ownerId, this.options.now())) reviewed.push(attempt);
    if (reviewed.length) return { status: "needs_manual_review", attemptId: reviewed[0]!.jobId };

    const held = await repo.listActivePublishingAttemptsForWorker(this.workerId, now, this.options.batchSize ?? 20);
    if (held.length) {
      const candidate = await this.loadCandidate(held[0]!);
      return candidate ? this.advance(held[0]!, candidate, now, true) : { status: "blocked", attemptId: held[0]!.id, reason: "The attempt relationships could not be verified." };
    }

    const candidates = await repo.listDuePublishingCandidates(now, this.options.batchSize ?? 20);
    for (const candidate of candidates) {
      if (candidate.cycle.ownerId !== candidate.item.cycleOwnerId || candidate.item.cycleId !== candidate.cycle.id || candidate.cycle.status !== "running" || candidate.item.status !== "scheduled" || !candidate.item.scheduledFor || candidate.item.scheduledFor > now) continue;
      const accountEligibility = candidate.account ? evaluateInstagramEligibility({ platform: candidate.account.platform, status: candidate.account.status, accountType: candidate.account.accountType, grantedScopes: candidate.account.grantedScopes, hasToken: candidate.account.hasToken, tokenExpiresAt: candidate.account.tokenExpiresAt, now }) : null;
      if (!accountEligibility?.eligible || candidate.account?.userId !== candidate.cycle.ownerId || candidate.account?.id !== candidate.cycle.socialAccountId) return { status: "blocked", itemId: candidate.item.id, reason: "Publishing prerequisites are not satisfied." };
      const preflight = await this.checkPrerequisites(candidate, now);
      if (!preflight.canStart) return { status: "blocked", itemId: candidate.item.id, reason: "Publishing prerequisites are not satisfied." };
      const renderCheck = await this.verifySelectedRenderOutput(candidate, now);
      if (!renderCheck.ok) return { status: "blocked", itemId: candidate.item.id, reason: renderCheck.reason };
      const attempts = await repo.listPublishingAttemptsForItem(candidate.cycle.ownerId, candidate.cycle.id, candidate.item.id);
      if (attempts.length) {
        const queued = attempts.length === 1 && attempts[0]!.stage === "queued" ? attempts[0] : undefined;
        if (!queued) continue; // Terminal or uncertain attempts never trigger an automatic retry.
        if (await this.options.cancellationRequested?.(candidate, "queued")) {
          const cancelled = await repo.cancelPublishingAttempt(queued.id, candidate.cycle.ownerId, this.options.now());
          return { status: cancelled ? "cancelled" : "skipped", itemId: candidate.item.id, attemptId: queued.id };
        }
        const claimNow = this.options.now();
        if (candidate.item.scheduledFor > claimNow) return { status: "skipped", itemId: candidate.item.id, attemptId: queued.id };
        const claimed = await repo.claimPublishingAttempt({ attemptId: queued.id, ownerId: candidate.cycle.ownerId, cycleId: candidate.cycle.id, cycleItemId: candidate.item.id, socialAccountId: candidate.cycle.socialAccountId, expectedItemVersion: candidate.item.version, workerId: this.workerId, now: claimNow, leaseSeconds: this.options.leaseSeconds ?? 90 });
        return claimed ? this.advance(claimed, candidate, claimNow, false) : { status: "skipped", itemId: candidate.item.id, attemptId: queued.id };
      }
      const key = buildPublishIdempotencyKey(candidate.item, 1);
      const created = await repo.createOrGetPublishingAttempt({ id: this.options.newId(), ownerId: candidate.cycle.ownerId, cycleId: candidate.cycle.id, cycleItemId: candidate.item.id, socialAccountId: candidate.cycle.socialAccountId, attemptNumber: 1, idempotencyKey: key, now });
      if (!created.job || (created.status !== "created" && created.status !== "existing") || created.job.stage !== "queued") return { status: "skipped", itemId: candidate.item.id };
      if (await this.options.cancellationRequested?.(candidate, "queued")) {
        const cancelled = await repo.cancelPublishingAttempt(created.job.id, candidate.cycle.ownerId, this.options.now());
        return { status: cancelled ? "cancelled" : "skipped", itemId: candidate.item.id, attemptId: created.job.id };
      }
      const claimNow = this.options.now();
      if (candidate.item.scheduledFor > claimNow) return { status: "skipped", itemId: candidate.item.id, attemptId: created.job.id };
      const claimed = await repo.claimPublishingAttempt({ attemptId: created.job.id, ownerId: candidate.cycle.ownerId, cycleId: candidate.cycle.id, cycleItemId: candidate.item.id, socialAccountId: candidate.cycle.socialAccountId, expectedItemVersion: candidate.item.version, workerId: this.workerId, now: claimNow, leaseSeconds: this.options.leaseSeconds ?? 90 });
      return claimed ? this.advance(claimed, candidate, claimNow, false) : { status: "skipped", itemId: candidate.item.id, attemptId: created.job.id };
    }
    return { status: "idle" };
  }

  private async loadCandidate(attempt: PublishingAttemptRecord): Promise<DuePublishingCandidate | null> {
    const [cycle, items, account] = await Promise.all([this.options.repo.getCycle(attempt.cycleId), this.options.repo.getCycleItems(attempt.cycleId), this.options.repo.getSocialAccount(attempt.socialAccountId)]);
    const item = items.find((entry) => entry.id === attempt.cycleItemId);
    if (!cycle || !item || cycle.ownerId !== attempt.ownerId || item.cycleOwnerId !== attempt.ownerId || cycle.socialAccountId !== attempt.socialAccountId) return null;
    return { cycle, item, account };
  }

  private async checkPrerequisites(candidate: DuePublishingCandidate, now: Date): Promise<PreflightReport> {
    const items = await this.options.repo.getCycleItems(candidate.cycle.id);
    const preflightItems = items.map((item) => item.id === candidate.item.id && item.status === "publishing" ? { ...item, status: "scheduled" as const } : item);
    if (this.options.preflight) return this.options.preflight(candidate, preflightItems, now);
    if (!this.options.context) return { overall: "blocked", canStart: false, checks: [] };
    const context: RequestContext = { ...this.options.context, userId: candidate.cycle.ownerId, now, repo: this.options.repo };
    return buildPreflightReport(context, candidate.cycle.ownerId, candidate.cycle, preflightItems, candidate.cycle.finalReviewConfirmed);
  }

  private getStorage(): MediaStorage | null {
    if (this.options.storage !== undefined) return this.options.storage;
    return (this.options.context as RequestContext | undefined)?.media?.storage ?? null;
  }

  private getMediaAccess(): TemporaryMediaAccessAdapter | null {
    if (this.options.mediaAccess !== undefined) return this.options.mediaAccess;
    return (this.options.context as RequestContext | undefined)?.publishingMediaAccess ?? null;
  }

  private async verifySelectedRenderOutput(
    candidate: DuePublishingCandidate,
    now: Date,
  ): Promise<
    | { ok: true; output: { id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string }; videoUrl?: string; coverUrl?: string }
    | { ok: false; category: string; reason: string }
  > {
    const { item, cycle } = candidate;
    // 1. Explicit selection required
    if (!item.selectedRenderOutputId) {
      return { ok: false, category: "media_unavailable", reason: "Cycle item has no selected render output." };
    }
    // 2. Never fall back to original uploaded media
    if (item.selectedRenderOutputId === item.mediaAssetId) {
      return { ok: false, category: "media_unavailable", reason: "Original media cannot be used directly as publishing output." };
    }
    // 3. Output derivative must exist
    const output = await this.options.repo.getRenderOutput(item.selectedRenderOutputId);
    if (!output) {
      return { ok: false, category: "media_unavailable", reason: "Selected render output was not found." };
    }
    // 4. Output derivative must belong to the exact cycle owner
    if (output.ownerId !== cycle.ownerId || output.ownerId !== item.cycleOwnerId) {
      return { ok: false, category: "media_unavailable", reason: "Selected render output owner does not match the cycle owner." };
    }
    // 5. Output derivative must belong to the exact source media asset
    if (output.sourceMediaId !== item.mediaAssetId) {
      return { ok: false, category: "media_unavailable", reason: "Selected render output source does not match the cycle item source media." };
    }
    // 6. Usable size check
    if (!Number.isFinite(output.sizeBytes) || output.sizeBytes <= 0) {
      return { ok: false, category: "media_unavailable", reason: "Selected render output has invalid size." };
    }
    // 7. Storage availability check (when storage is configured)
    const storage = this.getStorage();
    if (storage) {
      const metadata = await storage.getPrivateMetadata(output.storageKey).catch(() => null);
      if (!metadata || metadata.sizeBytes <= 0 || metadata.sizeBytes !== output.sizeBytes) {
        return { ok: false, category: "media_unavailable", reason: "Selected render output file is unavailable in storage." };
      }
    }
    // 8. Temporary media access check (when configured)
    const mediaAccess = this.getMediaAccess();
    let videoUrl: string | undefined;
    if (mediaAccess) {
      const prepared = await prepareTemporaryPublishingAccess(this.options.repo, storage, mediaAccess, {
        ownerId: cycle.ownerId,
        cycleId: cycle.id,
        cycleItemId: item.id,
        now,
      });
      if (prepared.status !== "temporary_media_access_ready") {
        return { ok: false, category: "media_unavailable", reason: `Temporary media access is not ready: ${prepared.status}.` };
      }
      if (this.options.requirePublicMedia && (mediaAccess.mode !== "provider" || !prepared.publiclyReachable || !isPublicProviderUrl(prepared.url))) {
        return { ok: false, category: "media_unavailable", reason: "Selected render output has no provider-attested public URL." };
      }
      videoUrl = prepared.url;
    } else if (this.options.requirePublicMedia) {
      return { ok: false, category: "media_unavailable", reason: "Temporary public media access is not configured." };
    }

    let coverUrl: string | undefined;
    if (item.coverMediaId) {
      const coverAccess = await prepareTemporaryPublishingCoverAccess(this.options.repo, storage, mediaAccess, { ownerId: cycle.ownerId, cycleId: cycle.id, cycleItemId: item.id, now });
      if (coverAccess.status !== "temporary_cover_access_ready") return { ok: false, category: "media_unavailable", reason: `The selected Reel cover is not ready: ${coverAccess.status}.` };
      if (this.options.requirePublicMedia && (mediaAccess?.mode !== "provider" || !coverAccess.publiclyReachable || !isPublicProviderUrl(coverAccess.url))) return { ok: false, category: "media_unavailable", reason: "The selected Reel cover has no provider-attested public URL." };
      coverUrl = coverAccess.url;
    }

    return { ok: true, output, videoUrl, ...(coverUrl ? { coverUrl } : {}) };
  }

  private input(
    job: PublishingAttemptRecord,
    candidate: DuePublishingCandidate,
    extra: { renderOutputId?: string; videoUrl?: string; coverUrl?: string; thumbOffsetMs?: number } = {},
  ): PublishingAdapterInput {
    const renderOutputId = extra.renderOutputId ?? candidate.item.selectedRenderOutputId ?? undefined;
    return {
      attemptId: job.id,
      idempotencyKey: job.idempotencyKey,
      cycleId: job.cycleId,
      cycleItemId: job.cycleItemId,
      ownerId: candidate.cycle.ownerId,
      socialAccountId: candidate.cycle.socialAccountId,
      ...(candidate.account?.externalAccountId ? { instagramAccountId: candidate.account.externalAccountId } : {}),
      mediaAssetId: candidate.item.mediaAssetId,
      caption: candidate.item.captionText,
      ...(renderOutputId ? { renderOutputId, selectedRenderOutputId: renderOutputId } : {}),
      ...(extra.videoUrl ? { videoUrl: extra.videoUrl } : {}),
      ...(extra.coverUrl ? { coverUrl: extra.coverUrl } : {}),
      coverSelected: candidate.item.coverMediaId !== null,
      ...(extra.thumbOffsetMs === undefined ? {} : { thumbOffsetMs: extra.thumbOffsetMs }),
      ...(job.containerId ? { containerId: job.containerId } : {}),
    };
  }

  private async transition(job: PublishingAttemptRecord, candidate: DuePublishingCandidate, now: Date, nextStage: PublishingJobStage, extra: Partial<PublishingAttemptUpdate> = {}): Promise<boolean> {
    if (!job.lockToken || !job.workerId) return false;
    return this.options.repo.transitionPublishingAttempt({ jobId: job.id, ownerId: job.ownerId, workerId: job.workerId, lockToken: job.lockToken, expectedStage: job.stage, nextStage, now: this.options.now(), leaseSeconds: this.options.leaseSeconds ?? 90, ...extra });
  }

  private async needsReview(job: PublishingAttemptRecord, candidate: DuePublishingCandidate, now: Date, category: string): Promise<PublishingWorkerResult> {
    const saved = await this.transition(job, candidate, now, "needs_manual_review", { errorCategory: safeCategory(category) });
    if (saved) return { status: "needs_manual_review", itemId: job.cycleItemId, attemptId: job.id };
    const reviewed = await this.options.repo.markExpiredPublishingAttemptForReview(job.id, job.ownerId, this.options.now());
    return reviewed ? { status: "needs_manual_review", itemId: job.cycleItemId, attemptId: job.id } : { status: "skipped", itemId: job.cycleItemId, attemptId: job.id };
  }

  private async advance(job: PublishingAttemptRecord, candidate: DuePublishingCandidate, now: Date, resumed: boolean): Promise<PublishingWorkerResult> {
    const currentCycle = await this.options.repo.getCycle(job.cycleId);
    if (!currentCycle || currentCycle.ownerId !== job.ownerId || currentCycle.socialAccountId !== job.socialAccountId || currentCycle.status !== "running") {
      if (job.stage === "claimed") {
        await this.options.repo.cancelClaimedPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now());
        return { status: "cancelled", itemId: job.cycleItemId, attemptId: job.id };
      }
      return this.needsReview(job, candidate, now, "account_ineligible");
    }
    const prerequisites = await this.checkPrerequisites({ ...candidate, cycle: currentCycle }, this.options.now());
    if (!prerequisites.canStart) {
      if (job.stage === "claimed") {
        await this.options.repo.cancelClaimedPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now());
        return { status: "blocked", itemId: job.cycleItemId, attemptId: job.id, reason: "Publishing prerequisites are not satisfied." };
      }
      return this.needsReview(job, candidate, now, "account_ineligible");
    }
    const renderCheck = await this.verifySelectedRenderOutput({ ...candidate, cycle: currentCycle }, this.options.now());
    if (!renderCheck.ok) {
      if (job.stage === "claimed") {
        await this.options.repo.cancelClaimedPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now());
        return { status: "blocked", itemId: job.cycleItemId, attemptId: job.id, reason: renderCheck.reason };
      }
      return this.needsReview(job, candidate, now, renderCheck.category);
    }
    const adapters = this.options.adapters;
    let stage = job.stage;
    if (stage === "claimed") {
      if (await this.options.cancellationRequested?.(candidate, "claimed")) {
        const cancelled = await this.options.repo.cancelClaimedPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now());
        return { status: cancelled ? "cancelled" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      if (!(await this.transition(job, candidate, now, "container_creation_pending"))) return { status: "skipped", itemId: job.cycleItemId, attemptId: job.id };
      stage = "container_creation_pending";
    } else if (stage === "container_creation_pending" && resumed) {
      // The create request may already have reached the provider. Never issue it twice.
      return this.needsReview(job, candidate, now, "container_timeout");
    }

    if (stage === "container_creation_pending") {
      let result: ContainerCreationResult;
      try {
        result = await adapters.createContainer(this.input(job, candidate, {
          renderOutputId: renderCheck.output.id,
          videoUrl: renderCheck.videoUrl,
          coverUrl: renderCheck.coverUrl,
        }));
      } catch {
        return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      }
      if (result.kind === "ambiguous") return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      if (result.kind === "definite_failure") {
        const saved = await this.transition({ ...job, stage }, candidate, now, "failed", { errorCategory: safeCategory(result.category) });
        return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      if (!result.containerId.trim()) return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      const withContainer = { ...job, stage, containerId: result.containerId };
      const saved = await this.transition({ ...job, stage }, candidate, now, "container_processing", { containerId: result.containerId });
      if (!saved) return { status: "skipped", itemId: job.cycleItemId, attemptId: job.id };
      job = withContainer; stage = "container_processing";
    }

    if (stage === "container_processing") {
      if (!job.containerId) return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      let result: ContainerPollResult;
      try {
        result = await adapters.pollContainer({
          ...this.input(job, candidate, {
            renderOutputId: renderCheck.output.id,
            videoUrl: renderCheck.videoUrl,
            coverUrl: renderCheck.coverUrl,
          }),
          containerId: job.containerId,
        });
      } catch {
        return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      }
      if (result.kind === "processing") {
        const heartbeat = await this.options.repo.heartbeatPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now(), this.options.leaseSeconds ?? 90);
        return { status: heartbeat ? "processing" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      if (result.kind === "ambiguous") return this.needsReview({ ...job, stage }, candidate, now, "container_timeout");
      if (result.kind === "definite_failure") {
        const saved = await this.transition({ ...job, stage }, candidate, now, "failed", { errorCategory: safeCategory(result.category) });
        return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      const saved = await this.transition({ ...job, stage }, candidate, now, "ready_to_publish");
      if (!saved) return { status: "skipped", itemId: job.cycleItemId, attemptId: job.id };
      stage = "ready_to_publish"; job = { ...job, stage };
    }

    if (stage === "ready_to_publish") {
      const publishCandidate = await this.loadCandidate(job);
      if (!publishCandidate || publishCandidate.cycle.status !== "running") {
        const saved = await this.transition({ ...job, stage }, candidate, now, "failed", { errorCategory: "account_ineligible" });
        return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      const publishPrerequisites = await this.checkPrerequisites(publishCandidate, this.options.now());
      if (!publishPrerequisites.canStart) {
        const saved = await this.transition({ ...job, stage }, publishCandidate, this.options.now(), "failed", { errorCategory: "account_ineligible" });
        return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      const publishRenderCheck = await this.verifySelectedRenderOutput(publishCandidate, this.options.now());
      if (!publishRenderCheck.ok) {
        const saved = await this.transition({ ...job, stage }, publishCandidate, this.options.now(), "failed", { errorCategory: safeCategory(publishRenderCheck.category) });
        return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
      }
      let quota: PublishingQuotaResult;
      try {
        quota = await adapters.checkPublishingQuota(this.input({ ...job, stage }, publishCandidate, { renderOutputId: publishRenderCheck.output.id, videoUrl: publishRenderCheck.videoUrl, coverUrl: publishRenderCheck.coverUrl }));
      } catch { quota = { kind: "unknown" }; }
      const quotaVerifiedAvailable = quota.kind === "available" && Number.isSafeInteger(quota.usage) && quota.usage >= 0 && Number.isSafeInteger(quota.total) && quota.total > 0 && Number.isSafeInteger(quota.durationSeconds) && quota.durationSeconds > 0 && quota.usage < quota.total;
      if (!quotaVerifiedAvailable) {
        // A quota miss/unavailable check is not a publish failure. Keep the ready container
        // leased and retry the read-only check on a later pass; never call media_publish.
        const heartbeat = await this.options.repo.heartbeatPublishingAttempt(job.id, job.ownerId, this.workerId, job.lockToken ?? "", this.options.now(), this.options.leaseSeconds ?? 90);
        return { status: heartbeat ? "blocked" : "skipped", itemId: job.cycleItemId, attemptId: job.id, reason: quota.kind === "limit_reached" || (quota.kind === "available" && quota.usage >= quota.total) ? "Instagram's verified publishing quota is currently full." : "Instagram's publishing quota could not be verified." };
      }
      const saved = await this.transition({ ...job, stage }, publishCandidate, this.options.now(), "publishing");
      if (!saved) return { status: "skipped", itemId: job.cycleItemId, attemptId: job.id };
      stage = "publishing"; job = { ...job, stage };
      return this.publishOrVerify(job, publishCandidate, this.options.now(), false, {
        renderOutputId: publishRenderCheck.output.id,
        videoUrl: publishRenderCheck.videoUrl,
        coverUrl: publishRenderCheck.coverUrl,
      });
    }
    if (stage === "publishing") {
      return this.publishOrVerify({ ...job, stage }, candidate, now, true, {
        renderOutputId: renderCheck.output.id,
        videoUrl: renderCheck.videoUrl,
      });
    }
    return { status: "claimed", itemId: job.cycleItemId, attemptId: job.id };
  }

  private async publishOrVerify(
    job: PublishingAttemptRecord,
    candidate: DuePublishingCandidate,
    now: Date,
    verifyOnly: boolean,
    extra: { renderOutputId?: string; videoUrl?: string; coverUrl?: string; thumbOffsetMs?: number } = {},
  ): Promise<PublishingWorkerResult> {
    const adapters = this.options.adapters;
    if (verifyOnly) return this.verify(job, candidate, now, extra);
    let result: PublishingResult;
    try {
      result = await adapters.publishContainer({
        ...this.input(job, candidate, extra),
        containerId: job.containerId!,
      });
    } catch {
      return this.verify(job, candidate, now, extra);
    }
    if (result.kind === "confirmed" && result.instagramMediaId) {
      const saved = await this.transition(job, candidate, now, "published", { instagramMediaId: result.instagramMediaId });
      return { status: saved ? "published" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
    }
    if (result.kind === "definite_failure") {
      const saved = await this.transition(job, candidate, now, "failed", { errorCategory: safeCategory(result.category) });
      return { status: saved ? "failed" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
    }
    return this.verify(job, candidate, now, extra);
  }

  private async verify(
    job: PublishingAttemptRecord,
    candidate: DuePublishingCandidate,
    now: Date,
    extra: { renderOutputId?: string; videoUrl?: string; coverUrl?: string; thumbOffsetMs?: number } = {},
  ): Promise<PublishingWorkerResult> {
    let result: PublishingVerificationResult;
    try {
      result = await this.options.adapters.verifyPublishingResult({
        ...this.input(job, candidate, extra),
        ...(job.containerId ? { containerId: job.containerId } : {}),
      });
    } catch {
      return this.needsReview({ ...job, stage: "publishing" }, candidate, now, "publish_timeout");
    }
    if (result.kind === "confirmed" && result.instagramMediaId) {
      const saved = await this.transition({ ...job, stage: "publishing" }, candidate, now, "published", { instagramMediaId: result.instagramMediaId });
      return { status: saved ? "published" : "skipped", itemId: job.cycleItemId, attemptId: job.id };
    }
    // Even a verifier that says not_published does not trigger an automatic second publish.
    return this.needsReview({ ...job, stage: "publishing" }, candidate, now, "publish_timeout");
  }
}

function isPublicProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hostname.endsWith(".invalid") && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1";
  } catch { return false; }
}

export function createPublishingWorker(options: Omit<PublishingWorkerOptions, "workerId"> & { workerId?: string }): PublishingWorker {
  return new PublishingWorker({ ...options, workerId: options.workerId ?? randomUUID() });
}
