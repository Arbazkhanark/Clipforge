import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { itemToRow } from "../src/server/prisma/mappers.ts";
import { makeCycle, makeItem, NOW } from "./helpers.ts";
import { buildPublishIdempotencyKey } from "../src/lib/domain/cycle-state.ts";
import type { ClaimPublishingAttemptInput, CreatePublishingAttemptInput, PublishingJobStage, Repository } from "../src/server/repository.ts";

const EXPIRES = new Date(NOW.getTime() + 3_600_000);
const createInput: CreatePublishingAttemptInput = { id: "attempt1", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", socialAccountId: "acct1", attemptNumber: 1, idempotencyKey: buildPublishIdempotencyKey({ cycleId: "cycle1", id: "item1" }, 1), now: NOW };
const claimInput: ClaimPublishingAttemptInput = { attemptId: "attempt1", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", socialAccountId: "acct1", expectedItemVersion: 1, workerId: "worker-a", now: NOW, leaseSeconds: 60 };

async function memorySetup(): Promise<MemoryRepository> {
  const repo = new MemoryRepository();
  await repo.createCycle({ ...makeCycle({ id: "cycle1", ownerId: "bob", status: "running" }), name: "Cycle", socialAccountId: "acct1" });
  repo.items.set("item1", makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1000) }));
  repo.socialAccounts.set("acct1", { id: "acct1", userId: "bob", platform: "instagram", status: "connected", hasToken: true, accountType: "BUSINESS", grantedScopes: ["instagram_business_basic", "instagram_business_content_publish"], tokenExpiresAt: EXPIRES });
  return repo;
}

async function prismaSetup(): Promise<{ repo: PrismaRepository; client: FakePrismaClient }> {
  const client = new FakePrismaClient();
  await client.socialAccount.create({ data: { id: "acct1", userId: "bob", status: "connected", platform: "instagram", externalAccountId: "external", accountType: "BUSINESS", grantedScopes: "instagram_business_basic instagram_business_content_publish", encryptedAccessToken: "ciphertext-only", tokenExpiresAt: EXPIRES } });
  await client.publishingCycle.create({ data: { id: "cycle1", ownerId: "bob", socialAccountId: "acct1", status: "running", name: "Cycle", finalReviewConfirmed: true } });
  await client.cycleItem.create({ data: itemToRow(makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1000) })) });
  return { repo: new PrismaRepository(client), client };
}

async function seedAttempt(repo: Repository): Promise<void> {
  assert.equal((await repo.createOrGetPublishingAttempt(createInput)).status, "created");
}

for (const mode of ["memory", "fake-prisma"] as const) {
  test(`${mode}: attempt creation is idempotent and validates owner/cycle/item/account relationships`, async () => {
    const repo = mode === "memory" ? await memorySetup() : (await prismaSetup()).repo;
    const first = await repo.createOrGetPublishingAttempt(createInput);
    const again = await repo.createOrGetPublishingAttempt({ ...createInput, id: "different-id" });
    assert.equal(first.status, "created"); assert.equal(again.status, "existing");
    const secondAttempt = { ...createInput, id: "attempt2", attemptNumber: 2, idempotencyKey: buildPublishIdempotencyKey({ cycleId: "cycle1", id: "item1" }, 2) };
    assert.equal((await repo.createOrGetPublishingAttempt(secondAttempt)).status, "created");
    assert.equal((await repo.createOrGetPublishingAttempt({ ...secondAttempt, id: "duplicate-attempt" })).status, "existing");
    assert.equal((await repo.createOrGetPublishingAttempt({ ...createInput, id: "evil", ownerId: "mallory" })).status, "conflict");
    assert.equal((await repo.createOrGetPublishingAttempt({ ...createInput, id: "wrong-cycle", cycleId: "missing" })).status, "conflict");
  });

  test(`${mode}: a claim requires an eligible running cycle and due owned item`, async () => {
    const repo = mode === "memory" ? await memorySetup() : (await prismaSetup()).repo;
    await seedAttempt(repo);
    assert.equal(await repo.claimPublishingAttempt({ ...claimInput, ownerId: "mallory" }), null);
    assert.equal(await repo.claimPublishingAttempt({ ...claimInput, expectedItemVersion: 99 }), null);
    const claimed = await repo.claimPublishingAttempt(claimInput);
    assert.equal(claimed?.stage, "claimed"); assert.ok(claimed?.lockToken); assert.ok(claimed?.leaseExpiresAt);
    assert.equal(await repo.claimPublishingAttempt(claimInput), null);
  });

  test(`${mode}: worker stage changes enforce owner, worker, current token, stage and live lease`, async () => {
    const repo = mode === "memory" ? await memorySetup() : (await prismaSetup()).repo;
    await seedAttempt(repo); const claimed = await repo.claimPublishingAttempt(claimInput); assert.ok(claimed?.lockToken);
    assert.equal(await repo.heartbeatPublishingAttempt("attempt1", "bob", "worker-a", "wrong-token", NOW, 120), false);
    assert.equal(await repo.heartbeatPublishingAttempt("attempt1", "bob", "worker-a", claimed!.lockToken!, NOW, 120), true);
    const transition = { jobId: "attempt1", ownerId: "bob", workerId: "worker-a", lockToken: claimed!.lockToken!, expectedStage: "claimed" as const, nextStage: "container_creation_pending" as const, now: NOW, leaseSeconds: 120 };
    assert.equal(await repo.transitionPublishingAttempt({ ...transition, lockToken: "stale" }), false);
    assert.equal(await repo.transitionPublishingAttempt({ ...transition, ownerId: "other" }), false);
    assert.equal(await repo.transitionPublishingAttempt({ ...transition, nextStage: "cancelled" }), false);
    assert.equal(await repo.transitionPublishingAttempt(transition), true);
    assert.equal(await repo.transitionPublishingAttempt({ ...transition, expectedStage: "claimed", nextStage: "container_processing" }), false);
    assert.equal(await repo.transitionPublishingAttempt({ ...transition, expectedStage: "container_creation_pending", nextStage: "container_processing", now: new Date(NOW.getTime() + 500_000) }), false);
  });

  test(`${mode}: confirmed publish persists media id; ambiguous result becomes manual review and cannot be claimed`, async () => {
    const repo = mode === "memory" ? await memorySetup() : (await prismaSetup()).repo;
    await seedAttempt(repo); const job = await repo.claimPublishingAttempt(claimInput); assert.ok(job?.lockToken);
    const stages = ["container_creation_pending", "container_processing", "ready_to_publish", "publishing"] as const;
    let stage: PublishingJobStage = "claimed";
    for (const nextStage of stages) { assert.equal(await repo.transitionPublishingAttempt({ jobId: job!.id, ownerId: "bob", workerId: "worker-a", lockToken: job!.lockToken!, expectedStage: stage, nextStage, now: NOW, leaseSeconds: 60, ...(nextStage === "container_processing" ? { containerId: "container-safe-id" } : {}) }), true); stage = nextStage; }
    assert.equal(await repo.transitionPublishingAttempt({ jobId: job.id, ownerId: "bob", workerId: "worker-a", lockToken: job.lockToken!, expectedStage: "publishing", nextStage: "published", now: NOW, instagramMediaId: "ig-media-confirmed" }), true);
    const result = await repo.createOrGetPublishingAttempt(createInput); assert.equal(result.job?.stage, "published"); assert.equal(result.job?.instagramMediaId, "ig-media-confirmed");
  });

  test(`${mode}: expired lease can only be cleared into manual review; stale worker token is rejected`, async () => {
    const repo = mode === "memory" ? await memorySetup() : (await prismaSetup()).repo;
    await seedAttempt(repo); const job = await repo.claimPublishingAttempt(claimInput); assert.ok(job?.lockToken);
    const expired = new Date(NOW.getTime() + 61_000);
    assert.equal(await repo.markExpiredPublishingAttemptForReview(job!.id, "bob", expired), true);
    assert.equal(await repo.transitionPublishingAttempt({ jobId: job!.id, ownerId: "bob", workerId: "worker-a", lockToken: job!.lockToken!, expectedStage: "claimed", nextStage: "container_creation_pending", now: expired }), false);
    assert.equal((await repo.createOrGetPublishingAttempt(createInput)).job?.stage, "needs_manual_review");
  });
}

test("memory: ambiguous outcome is terminal for automatic claims and safe cancellation is limited to pre-container work", async () => {
  const repo = await memorySetup(); await seedAttempt(repo); const claimed = await repo.claimPublishingAttempt(claimInput); assert.ok(claimed?.lockToken);
    assert.equal(await repo.transitionPublishingAttempt({ jobId: claimed!.id, ownerId: "bob", workerId: "worker-a", lockToken: claimed!.lockToken!, expectedStage: "claimed", nextStage: "needs_manual_review", now: NOW, errorCategory: "token=do-not-store", errorDetails: "Bearer secret-token response body https://private.invalid" }), true);
  assert.equal((await repo.publishingJobs.get("attempt1"))?.stage, "needs_manual_review");
    assert.equal((await repo.publishingJobs.get("attempt1"))?.errorCategory, "unknown");
    assert.equal((await repo.publishingJobs.get("attempt1"))?.errorDetails, "The publishing attempt needs review.");
  assert.equal(await repo.claimPublishingAttempt(claimInput), null);
  assert.equal(await repo.cancelPublishingAttempt("attempt1", "bob", NOW), false);
  assert.equal(await repo.createOrGetPublishingAttempt({ ...createInput, id: "attempt2", attemptNumber: 2, idempotencyKey: buildPublishIdempotencyKey({ cycleId: "cycle1", id: "item1" }, 2) }).then((r) => r.status), "created");
  assert.equal(await repo.cancelPublishingAttempt("attempt2", "bob", NOW), true);
  assert.equal((await repo.publishingJobs.get("attempt2"))?.stage, "cancelled");
});

test("fake Prisma simulates concurrent account claims; it does not verify PostgreSQL row locks", async () => {
  const { repo, client } = await prismaSetup(); await seedAttempt(repo);
  const second = makeItem({ id: "item2", cycleId: "cycle1", cycleOwnerId: "bob", status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1000) });
  await client.cycleItem.create({ data: itemToRow(second) });
  await repo.createOrGetPublishingAttempt({ ...createInput, id: "attempt2", cycleItemId: "item2", attemptNumber: 1, idempotencyKey: "publish:cycle1:item2:1" });
  const results = await Promise.all([repo.claimPublishingAttempt(claimInput), repo.claimPublishingAttempt({ ...claimInput, attemptId: "attempt2", cycleItemId: "item2" })]);
  assert.equal(results.filter(Boolean).length, 1);
});
