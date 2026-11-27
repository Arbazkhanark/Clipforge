import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPublishIdempotencyKey } from "../src/lib/domain/cycle-state.ts";
import { makeItem, makeMedia, NOW } from "./helpers.ts";
import { changeCycleStatus, deletePublishingCycle } from "../src/server/handlers/cycles.ts";
import type { RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";

function setup(itemStatus: "upcoming" | "scheduled" | "published" = "scheduled") {
  const repo = new MemoryRepository();
  const cycleId = "cycle-delete-1";
  const itemId = "cycle-delete-item-1";
  repo.cycles.set(cycleId, { id: cycleId, ownerId: "owner-1", socialAccountId: "account-1", name: "Campaign cleanup", status: "running", finalReviewConfirmed: true });
  repo.items.set(itemId, makeItem({ id: itemId, cycleId, cycleOwnerId: "owner-1", mediaAssetId: "media-1", status: itemStatus, scheduledFor: itemStatus === "scheduled" ? new Date(NOW.getTime() - 1000) : null, ...(itemStatus === "published" ? { externalPostId: "ig-post-kept", publishedAt: NOW } : {}) }));
  repo.media.set("media-1", makeMedia({ id: "media-1", ownerId: "owner-1" }));
  repo.socialAccounts.set("account-1", { id: "account-1", userId: "owner-1", platform: "instagram", status: "connected", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: new Date(NOW.getTime() + 86_400_000) });
  const context = (userId: string | null): RequestContext => ({ userId, repo, now: NOW, newId: () => "unused", config: { coverSupport: "supported" } } as RequestContext);
  const createQueuedAttempt = async () => repo.createOrGetPublishingAttempt({ id: "cycle-delete-attempt-1", ownerId: "owner-1", cycleId, cycleItemId: itemId, socialAccountId: "account-1", attemptNumber: 1, idempotencyKey: buildPublishIdempotencyKey({ cycleId, id: itemId }, 1), now: NOW });
  return { repo, cycleId, itemId, context, createQueuedAttempt };
}

test("cycle delete is owner-only, requires confirmation, and rejects invalid ids without writes", async () => {
  const { repo, context } = setup();
  await assert.rejects(() => deletePublishingCycle(context(null), { cycleId: "cycle-delete-1", confirm: true }), (error: unknown) => error instanceof AppError && error.status === 401);
  await assert.rejects(() => deletePublishingCycle(context("other-user"), { cycleId: "cycle-delete-1", confirm: true }), (error: unknown) => error instanceof AppError && error.status === 404);
  await assert.rejects(() => deletePublishingCycle(context("owner-1"), { cycleId: "../bad", confirm: true }), (error: unknown) => error instanceof AppError && error.status === 422);
  await assert.rejects(() => deletePublishingCycle(context("owner-1"), { cycleId: "cycle-delete-1", confirm: false }), (error: unknown) => error instanceof AppError && error.status === 422);
  assert.equal(repo.cycles.get("cycle-delete-1")?.deletedAt, undefined);
  assert.equal(repo.audit.length, 0);
});

test("cycle delete cancels queued work, preserves published history and media, and is idempotent under concurrent requests", async () => {
  const { repo, cycleId, itemId, context, createQueuedAttempt } = setup("scheduled");
  const queued = await createQueuedAttempt();
  assert.equal(queued.status, "created");
  const [first, second] = await Promise.all([
    deletePublishingCycle(context("owner-1"), { cycleId, confirm: true }),
    deletePublishingCycle(context("owner-1"), { cycleId, confirm: true }),
  ]);
  assert.deepEqual([first.deleted, second.deleted], [true, true]);
  assert.ok([first.alreadyDeleted, second.alreadyDeleted].includes(true));
  assert.equal(repo.cycles.get(cycleId)?.status, "stopped");
  assert.equal(repo.cycles.get(cycleId)?.deletedAt?.getTime(), NOW.getTime());
  assert.equal(repo.items.get(itemId)?.status, "cancelled");
  assert.equal(repo.publishingJobs.get("cycle-delete-attempt-1")?.stage, "cancelled");
  assert.equal(repo.media.has("media-1"), true);
  assert.equal((await repo.listCyclesForOwner("owner-1")).some((cycle) => cycle.id === cycleId), false);
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.deleted" && entry.entityId === cycleId).length, 1);

  const publishedSetup = setup("published");
  const publishedAttempt = await publishedSetup.createQueuedAttempt();
  assert.equal(publishedAttempt.status, "created");
  publishedSetup.repo.publishingJobs.set("cycle-delete-attempt-1", { ...publishedAttempt.job!, stage: "published", outcome: "success", instagramMediaId: "ig-post-kept", finishedAt: NOW });
  const deleted = await deletePublishingCycle(publishedSetup.context("owner-1"), { cycleId: publishedSetup.cycleId, confirm: true });
  assert.equal(deleted.deleted, true);
  assert.equal(publishedSetup.repo.publishingJobs.get("cycle-delete-attempt-1")?.instagramMediaId, "ig-post-kept");
  assert.equal(publishedSetup.repo.items.get(publishedSetup.itemId)?.externalPostId, "ig-post-kept");
  assert.equal(publishedSetup.repo.media.has("media-1"), true);
});

test("cycle delete blocks live leases and ambiguous publishing outcomes with actionable safe reasons", async () => {
  const active = setup("scheduled");
  await active.createQueuedAttempt();
  const claimed = await active.repo.claimPublishingAttempt({ attemptId: "cycle-delete-attempt-1", ownerId: "owner-1", cycleId: active.cycleId, cycleItemId: active.itemId, socialAccountId: "account-1", expectedItemVersion: 1, workerId: "worker-1", now: NOW, leaseSeconds: 60 });
  assert.ok(claimed?.lockToken);
  await assert.rejects(() => deletePublishingCycle(active.context("owner-1"), { cycleId: active.cycleId, confirm: true }), (error: unknown) => error instanceof AppError && error.status === 409 && /active lease/.test(error.message));
  assert.equal(active.repo.cycles.get(active.cycleId)?.deletedAt, undefined);
  assert.equal(active.repo.publishingJobs.get(claimed!.id)?.stage, "claimed");

  const ambiguous = setup("published");
  await ambiguous.createQueuedAttempt();
  const attempt = ambiguous.repo.publishingJobs.get("cycle-delete-attempt-1")!;
  ambiguous.repo.publishingJobs.set(attempt.id, { ...attempt, stage: "needs_manual_review", outcome: "ambiguous" });
  ambiguous.repo.items.set(ambiguous.itemId, { ...ambiguous.repo.items.get(ambiguous.itemId)!, status: "needs_review" });
  await assert.rejects(() => deletePublishingCycle(ambiguous.context("owner-1"), { cycleId: ambiguous.cycleId, confirm: true }), (error: unknown) => error instanceof AppError && error.status === 409 && /unresolved publishing outcome/.test(error.message));
  assert.equal(ambiguous.repo.cycles.get(ambiguous.cycleId)?.deletedAt, undefined);
});

test("expired pre-publish claim can be cancelled and stale worker actions cannot continue after deletion", async () => {
  const fixture = setup("scheduled");
  await fixture.createQueuedAttempt();
  const claimed = await fixture.repo.claimPublishingAttempt({ attemptId: "cycle-delete-attempt-1", ownerId: "owner-1", cycleId: fixture.cycleId, cycleItemId: fixture.itemId, socialAccountId: "account-1", expectedItemVersion: 1, workerId: "worker-1", now: NOW, leaseSeconds: 1 });
  assert.ok(claimed?.lockToken);
  const deletionTime = new Date(NOW.getTime() + 2000);
  assert.equal((await fixture.repo.deletePublishingCycle(fixture.cycleId, "owner-1", deletionTime)), "deleted");
  assert.equal(await fixture.repo.transitionPublishingAttempt({ jobId: claimed!.id, ownerId: "owner-1", workerId: "worker-1", lockToken: claimed!.lockToken!, expectedStage: "claimed", nextStage: "container_creation_pending", now: deletionTime }), false);
  assert.equal(await fixture.repo.claimPublishingAttempt({ attemptId: "cycle-delete-attempt-1", ownerId: "owner-1", cycleId: fixture.cycleId, cycleItemId: fixture.itemId, socialAccountId: "account-1", expectedItemVersion: 1, workerId: "worker-2", now: deletionTime, leaseSeconds: 60 }), null);
  assert.equal(fixture.repo.publishingJobs.get("cycle-delete-attempt-1")?.stage, "cancelled");
  assert.equal(fixture.repo.items.get(fixture.itemId)?.status, "cancelled");
  assert.equal(await fixture.repo.heartbeatPublishingAttempt(claimed!.id, "owner-1", "worker-1", claimed!.lockToken!, deletionTime, 60), false);
  assert.equal(await fixture.repo.cancelClaimedPublishingAttempt(claimed!.id, "owner-1", "worker-1", claimed!.lockToken!, deletionTime), false);
  assert.equal(await fixture.repo.getCycle(fixture.cycleId), null);
  await assert.rejects(() => changeCycleStatus(fixture.context("owner-1"), { cycleId: fixture.cycleId, action: "resume" }), (error: unknown) => error instanceof AppError && error.status === 404);
});

test("cycle deletion preserves failed attempt diagnostics and does not mutate unrelated cycles", async () => {
  const fixture = setup("scheduled");
  const attempt = await fixture.createQueuedAttempt();
  assert.equal(attempt.status, "created");
  fixture.repo.publishingJobs.set(attempt.job!.id, { ...attempt.job!, stage: "failed", outcome: "definite_failure", errorCategory: "instagram_rejected", errorDetails: "safe retained diagnostic", finishedAt: NOW });
  fixture.repo.items.set(fixture.itemId, { ...fixture.repo.items.get(fixture.itemId)!, status: "failed" });
  fixture.repo.cycles.set("other-cycle", { id: "other-cycle", ownerId: "owner-1", socialAccountId: "account-1", name: "Keep this cycle", status: "draft", finalReviewConfirmed: false });

  assert.deepEqual(await deletePublishingCycle(fixture.context("owner-1"), { cycleId: fixture.cycleId, confirm: true }), { deleted: true });
  assert.equal(fixture.repo.publishingJobs.get(attempt.job!.id)?.stage, "failed");
  assert.equal(fixture.repo.publishingJobs.get(attempt.job!.id)?.errorDetails, "safe retained diagnostic");
  assert.equal(fixture.repo.items.get(fixture.itemId)?.status, "failed");
  assert.equal(fixture.repo.cycles.get("other-cycle")?.deletedAt, undefined);
  assert.equal(fixture.repo.media.has("media-1"), true);
});
