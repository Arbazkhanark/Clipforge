// PostgreSQL-backed publishing attempt persistence and concurrency tests.
// This file never loads dotenv files and never calls Meta/Instagram. The only
// worker orchestration re-entry uses createMockPublishingAdapters (no I/O).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildPublishIdempotencyKey } from "../src/lib/domain/cycle-state.ts";
import { createMockPublishingAdapters, createPublishingWorker } from "../src/server/publishing/publishing-worker.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type {
  ClaimPublishingAttemptInput,
  CreatePublishingAttemptInput,
  PublishingAttemptRecord,
  PublishingAttemptUpdate,
} from "../src/server/repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "54836";
const TEST_DATABASE_NAME = "clipforge_local_test";
const TEST_DATABASE_ROLE = "clipforge_test_admin";
const TEST_POSTGRES_VERSION = /^PostgreSQL 15\.8\b/;
const FIXED_NOW = new Date("2026-11-23T12:00:00.000Z");
const FUTURE = new Date("2100-01-01T00:00:00.000Z");
const EXPECTED_MIGRATIONS = [
  "20261106135723_init",
  "20261106162016_integrity_constraints",
  "20261106163300_google_identity",
  "20261106174500_instagram_account_details",
  "20261107040000_render_queue_and_local_outbox",
  "20261107050000_durable_publishing_attempts",
  "20261107060000_cycle_item_render_output_selection",
  "20261107070000_instagram_oauth_state",
  "20261107080000_recurring_razorpay_subscription_intents",
  "20261107090000_manual_payment_access",
  "20261107091000_recurring_auto_renew_consent",
  "20261107092000_subscription_continuation",
  "20261107100000_promotions_and_discounted_manual_payments",
  "20261109120000_durable_media_import_jobs",
  "20261111100000_production_migration_audit_corrections",
  "20261113133000_admin_registration",
  "20261113170000_collection_caption_cover_settings",
  "20261114100000_cycle_video_ordering_modes",
  "20261115120000_media_verification_jobs",
  "20261121120000_complimentary_access_hold",
  "20261121120000_edited_media_replacements",
  "20261122120000_admin_user_suspension",
  "20261127120000_cycle_soft_deletion",
] as const;

type TestClient = PrismaClientLike & { $disconnect(): Promise<void> };
type AccountFixture = { suffix: string; accountId: string; cycleId: string; itemId: string; mediaId: string };
type Fixture = {
  prefix: string;
  ownerId: string;
  userOwned: boolean;
  userIds: Set<string>;
  mediaIds: Set<string>;
  accountIds: Set<string>;
  cycleIds: Set<string>;
  itemIds: Set<string>;
  jobIds: Set<string>;
  accounts: Map<string, AccountFixture>;
};

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct) throw new Error("Both DATABASE_URL and DIRECT_URL are required for publishing PostgreSQL integration tests.");
  if (database !== direct) throw new Error("DATABASE_URL and DIRECT_URL must match exactly for publishing PostgreSQL integration tests.");
  if (process.env["NODE_ENV"] !== "test" || process.env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test") {
    throw new Error("NODE_ENV=test and CLIPFORGE_DEPLOYMENT_ENV=test are required for publishing PostgreSQL integration tests.");
  }
  if (process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== TEST_DATABASE_PORT) {
    throw new Error("CLIPFORGE_TEST_DATABASE_PORT must explicitly equal 54836 for publishing PostgreSQL integration tests.");
  }

  let parsed: URL;
  try { parsed = new URL(database); }
  catch { throw new Error("DATABASE_URL is not a valid isolated PostgreSQL test target."); }
  const schemas = parsed.searchParams.getAll("schema");
  const exactTarget = parsed.protocol === "postgresql:" && parsed.hostname === TEST_DATABASE_HOST &&
    parsed.port === TEST_DATABASE_PORT && parsed.pathname === `/${TEST_DATABASE_NAME}` && parsed.hash === "" &&
    [...parsed.searchParams.keys()].every((key) => key === "schema") &&
    (schemas.length === 0 || (schemas.length === 1 && schemas[0] === "public"));
  if (!exactTarget) throw new Error("Database URLs must target only 127.0.0.1:54836/clipforge_local_test.");
  if (isolatedDatabaseUrl() !== database) throw new Error("Database URLs failed the shared isolated-database guard.");
  return database;
}

const databaseUrl = resolveDatabaseUrl();
const skipReason = "Database URLs are not configured for the explicitly isolated local PostgreSQL test.";

async function assertDatabaseIdentityAndMigrations(db: TestClient): Promise<void> {
  const identity = await db.$queryRaw`SELECT current_database() AS "databaseName",
    inet_server_addr()::text AS "serverAddress", current_setting('port') AS "serverPort",
    current_user AS "currentRole", version() AS "serverVersion"` as Array<Record<string, unknown>>;
  assert.equal(identity.length, 1, "database identity query must return one row");
  assert.equal(identity[0]?.["databaseName"], TEST_DATABASE_NAME, "unexpected PostgreSQL database");
  assert.ok([TEST_DATABASE_HOST, `${TEST_DATABASE_HOST}/32`].includes(String(identity[0]?.["serverAddress"])), "unexpected PostgreSQL loopback address");
  assert.equal(String(identity[0]?.["serverPort"]), TEST_DATABASE_PORT, "unexpected PostgreSQL port");
  assert.equal(identity[0]?.["currentRole"], TEST_DATABASE_ROLE, "unexpected PostgreSQL role");
  assert.match(String(identity[0]?.["serverVersion"]), TEST_POSTGRES_VERSION, "expected isolated PostgreSQL 15.8");

  const migrationRows = await db.$queryRaw`SELECT "migration_name" AS "migrationName",
    "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
    FROM public."_prisma_migrations" ORDER BY "migration_name"` as Array<Record<string, unknown>>;
  assert.deepEqual(migrationRows.map((row) => row["migrationName"]), [...EXPECTED_MIGRATIONS], "expected exactly the verified 23 migrations");
  assert.ok(migrationRows.every((row) => row["finishedAt"] instanceof Date && row["rolledBackAt"] === null), "all expected migrations must be applied successfully");
}

function fixtureIds(): Fixture {
  const prefix = `pubi-${randomUUID().replaceAll("-", "")}`;
  const ownerId = `${prefix}-user`;
  return {
    prefix, ownerId, userOwned: false, userIds: new Set(), mediaIds: new Set(),
    accountIds: new Set(), cycleIds: new Set(), itemIds: new Set(), jobIds: new Set(), accounts: new Map(),
  };
}

async function seedAccount(db: TestClient, fixture: Fixture, suffix: string): Promise<AccountFixture> {
  const account: AccountFixture = {
    suffix,
    accountId: `${fixture.prefix}-${suffix}-account`,
    cycleId: `${fixture.prefix}-${suffix}-cycle`,
    itemId: `${fixture.prefix}-${suffix}-item`,
    mediaId: `${fixture.prefix}-${suffix}-media`,
  };
  await db.mediaAsset.create({ data: {
    id: account.mediaId, ownerId: fixture.ownerId, kind: "video", status: "active",
    originalFilename: `${suffix}.mp4`, mimeType: "video/mp4", storageKey: `test/${fixture.prefix}/${suffix}`,
    sizeBytes: 128n, metadataValidated: true,
  } });
  fixture.mediaIds.add(account.mediaId);

  await db.socialAccount.create({ data: {
    id: account.accountId, userId: fixture.ownerId, platform: "instagram",
    externalAccountId: `${fixture.prefix}-${suffix}-external`, status: "connected", accountType: "BUSINESS",
    grantedScopes: "instagram_business_basic instagram_business_content_publish",
    encryptedAccessToken: "synthetic-test-ciphertext", tokenExpiresAt: FUTURE,
  } });
  fixture.accountIds.add(account.accountId);

  await db.publishingCycle.create({ data: {
    id: account.cycleId, ownerId: fixture.ownerId, socialAccountId: account.accountId,
    name: `Synthetic ${suffix}`, status: "running", finalReviewConfirmed: true,
    timezone: "UTC", scheduleSettings: {},
  } });
  fixture.cycleIds.add(account.cycleId);

  await db.cycleItem.create({ data: {
    id: account.itemId, cycleId: account.cycleId, cycleOwnerId: fixture.ownerId,
    mediaAssetId: account.mediaId, sourceKind: "owned", sourceCollectionId: null,
    status: "scheduled", position: 1, version: 1, scheduledFor: new Date(FIXED_NOW.getTime() - 60_000),
    captionText: "Synthetic integration fixture",
  } });
  fixture.itemIds.add(account.itemId);
  fixture.accounts.set(suffix, account);
  return account;
}

function repository(client: TestClient): PrismaRepository { return new PrismaRepository(client, () => FIXED_NOW); }

async function createAttempt(client: TestClient, fixture: Fixture, account: AccountFixture, attemptNumber = 1): Promise<PublishingAttemptRecord> {
  const input: CreatePublishingAttemptInput = {
    id: `${fixture.prefix}-${account.suffix}-attempt-${attemptNumber}`,
    ownerId: fixture.ownerId, cycleId: account.cycleId, cycleItemId: account.itemId,
    socialAccountId: account.accountId, attemptNumber,
    idempotencyKey: buildPublishIdempotencyKey({ cycleId: account.cycleId, id: account.itemId }, attemptNumber),
    now: FIXED_NOW,
  };
  const result = await repository(client).createOrGetPublishingAttempt(input);
  assert.ok(result.job, "attempt creation must return its persisted record");
  if (result.status === "created") fixture.jobIds.add(result.job.id);
  return result.job;
}

async function claim(client: TestClient, fixture: Fixture, account: AccountFixture, attemptId: string, workerId: string, now = FIXED_NOW, leaseSeconds = 60) {
  const input: ClaimPublishingAttemptInput = {
    attemptId, ownerId: fixture.ownerId, cycleId: account.cycleId, cycleItemId: account.itemId,
    socialAccountId: account.accountId, expectedItemVersion: 1, workerId, now, leaseSeconds,
  };
  return repository(client).claimPublishingAttempt(input);
}

async function transition(client: TestClient, input: PublishingAttemptUpdate): Promise<boolean> {
  return repository(client).transitionPublishingAttempt(input);
}

async function advanceToPublishing(client: TestClient, attempt: PublishingAttemptRecord, ownerId: string): Promise<void> {
  assert.ok(attempt.lockToken);
  const stages: PublishingAttemptUpdate[] = [
    { jobId: attempt.id, ownerId, workerId: attempt.workerId!, lockToken: attempt.lockToken!, expectedStage: "claimed", nextStage: "container_creation_pending", now: FIXED_NOW, leaseSeconds: 60 },
    { jobId: attempt.id, ownerId, workerId: attempt.workerId!, lockToken: attempt.lockToken!, expectedStage: "container_creation_pending", nextStage: "container_processing", now: FIXED_NOW, leaseSeconds: 60, containerId: "synthetic-container" },
    { jobId: attempt.id, ownerId, workerId: attempt.workerId!, lockToken: attempt.lockToken!, expectedStage: "container_processing", nextStage: "ready_to_publish", now: FIXED_NOW, leaseSeconds: 60 },
    { jobId: attempt.id, ownerId, workerId: attempt.workerId!, lockToken: attempt.lockToken!, expectedStage: "ready_to_publish", nextStage: "publishing", now: FIXED_NOW, leaseSeconds: 60 },
  ];
  for (const stage of stages) assert.equal(await transition(client, stage), true, `expected transition to ${stage.nextStage}`);
}

async function cleanupFixture(client: TestClient, fixture: Fixture): Promise<void> {
  const deleteOwned = async (model: PrismaClientLike["publishingJob"], ids: Set<string>) => {
    if (ids.size) await model.deleteMany({ where: { id: { in: [...ids] } } });
  };
  await deleteOwned(client.publishingJob, fixture.jobIds);
  await deleteOwned(client.cycleItem, fixture.itemIds);
  await deleteOwned(client.publishingCycle, fixture.cycleIds);
  await deleteOwned(client.socialAccount, fixture.accountIds);
  await deleteOwned(client.mediaAsset, fixture.mediaIds);
  if (fixture.userOwned) await deleteOwned(client.user, fixture.userIds);
}

// A fixture-aware wrapper is declared separately so partial setup retains only
// IDs whose corresponding create call resolved successfully.
async function withOwnedFixture<T>(clientCount: number, work: (clients: TestClient[], fixture: Fixture) => Promise<T>): Promise<T> {
  const clients: TestClient[] = [];
  const fixture = fixtureIds();
  try {
    for (let index = 0; index < clientCount; index += 1) clients.push(await createPrismaClient(databaseUrl!) as TestClient);
    for (const client of clients) await assertDatabaseIdentityAndMigrations(client);
    const setup = clients[0]!;
    await setup.user.create({ data: { id: fixture.ownerId, email: `${fixture.ownerId}@clipforge.invalid`, passwordHash: "synthetic-not-a-password" } });
    fixture.userOwned = true;
    fixture.userIds.add(fixture.ownerId);
    await seedAccount(setup, fixture, "one");
    return await work(clients, fixture);
  } finally {
    try {
      if (clients[0]) await cleanupFixture(clients[0], fixture);
    } finally {
      await Promise.allSettled(clients.map((client) => client.$disconnect()));
    }
  }
}

const testOptions = { skip: databaseUrl ? false : skipReason };

test("PostgreSQL publishing: concurrent same-attempt creation is idempotent", testOptions, async () => {
  await withOwnedFixture(2, async ([first, second], fixture) => {
    const account = fixture.accounts.get("one")!;
    const makeInput = (clientId: string): CreatePublishingAttemptInput => ({
      id: `${fixture.prefix}-${clientId}-attempt`, ownerId: fixture.ownerId, cycleId: account.cycleId,
      cycleItemId: account.itemId, socialAccountId: account.accountId, attemptNumber: 1,
      idempotencyKey: buildPublishIdempotencyKey({ cycleId: account.cycleId, id: account.itemId }, 1), now: FIXED_NOW,
    });
    const results = await Promise.all([
      repository(first!).createOrGetPublishingAttempt(makeInput("client-a")),
      repository(second!).createOrGetPublishingAttempt(makeInput("client-b")),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
    for (const result of results) if (result.status === "created" && result.job) fixture.jobIds.add(result.job.id);
    const rows = await first!.publishingJob.findMany({ where: { idempotencyKey: makeInput("client-a").idempotencyKey } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["cycleItemId"], account.itemId);
    assert.equal(await first!.publishingJob.count({ where: { cycleItemId: account.itemId } }), 1);
    assert.equal((await repository(second!).createOrGetPublishingAttempt({
      ...makeInput("conflicting-owner"), ownerId: `${fixture.ownerId}-other`,
    })).status, "conflict", "the same idempotency key cannot be adopted under a different owner");
    assert.equal(await first!.publishingJob.count({ where: { cycleItemId: account.itemId } }), 1);
  });
});

test("PostgreSQL publishing: independent workers cannot both claim one attempt", testOptions, async () => {
  await withOwnedFixture(2, async ([first, second], fixture) => {
    const account = fixture.accounts.get("one")!;
    const attempt = await createAttempt(first!, fixture, account);
    const results = await Promise.all([
      claim(first!, fixture, account, attempt.id, "worker-a"),
      claim(second!, fixture, account, attempt.id, "worker-b"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.find(Boolean)!;
    assert.ok(winner.lockToken);
    const persisted = await first!.publishingJob.findUnique({ where: { id: attempt.id } });
    assert.equal(persisted?.["stage"], "claimed");
    assert.equal(persisted?.["lockToken"], winner.lockToken);
    assert.ok(["worker-a", "worker-b"].includes(String(persisted?.["workerId"])));
    assert.equal((await first!.cycleItem.findUnique({ where: { id: account.itemId } }))?.["status"], "publishing");
  });
});

test("PostgreSQL publishing: heartbeat renews only for the current owner and token", testOptions, async () => {
  await withOwnedFixture(1, async ([client], fixture) => {
    const account = fixture.accounts.get("one")!;
    const attempt = await createAttempt(client!, fixture, account);
    const held = await claim(client!, fixture, account, attempt.id, "heartbeat-worker");
    assert.ok(held?.lockToken);
    const originalLease = held.leaseExpiresAt!.getTime();
    assert.equal(await repository(client!).heartbeatPublishingAttempt(attempt.id, fixture.ownerId, "heartbeat-worker", held.lockToken!, new Date(FIXED_NOW.getTime() + 10_000), 120), true);
    assert.equal(await repository(client!).heartbeatPublishingAttempt(attempt.id, fixture.ownerId, "heartbeat-worker", "wrong-token", new Date(FIXED_NOW.getTime() + 20_000), 300), false);
    const persisted = await client!.publishingJob.findUnique({ where: { id: attempt.id } });
    assert.equal((persisted?.["leaseExpiresAt"] as Date).getTime(), FIXED_NOW.getTime() + 130_000);
    assert.ok((persisted?.["leaseExpiresAt"] as Date).getTime() > originalLease);
    assert.equal(persisted?.["lockToken"], held.lockToken);
  });
});

test("PostgreSQL publishing: expired attempt moves to review and stale worker is fenced", testOptions, async () => {
  await withOwnedFixture(1, async ([client], fixture) => {
    const account = fixture.accounts.get("one")!;
    const attempt = await createAttempt(client!, fixture, account);
    const held = await claim(client!, fixture, account, attempt.id, "expired-worker", FIXED_NOW, 1);
    assert.ok(held?.lockToken);
    const expiredAt = new Date(FIXED_NOW.getTime() + 2_000);
    assert.equal(await repository(client!).markExpiredPublishingAttemptForReview(attempt.id, fixture.ownerId, expiredAt), true);
    assert.equal(await transition(client!, {
      jobId: attempt.id, ownerId: fixture.ownerId, workerId: "expired-worker", lockToken: held.lockToken!,
      expectedStage: "claimed", nextStage: "failed", now: expiredAt,
    }), false);
    assert.equal(await claim(client!, fixture, account, attempt.id, "replacement-worker", expiredAt), null);
    const persisted = await client!.publishingJob.findUnique({ where: { id: attempt.id } });
    const item = await client!.cycleItem.findUnique({ where: { id: account.itemId } });
    assert.equal(persisted?.["stage"], "needs_manual_review");
    assert.equal(persisted?.["outcome"], "ambiguous");
    assert.equal(persisted?.["lockToken"], null);
    assert.equal(item?.["status"], "needs_review");
    assert.equal(item?.["reviewReason"], "worker_lost_during_publish");
  });
});

test("PostgreSQL publishing: a definite failure is persisted and a later numbered attempt is unique", testOptions, async () => {
  await withOwnedFixture(1, async ([client], fixture) => {
    const account = fixture.accounts.get("one")!;
    const first = await createAttempt(client!, fixture, account, 1);
    const held = await claim(client!, fixture, account, first.id, "failure-worker");
    assert.ok(held?.lockToken);
    assert.equal(await transition(client!, {
      jobId: first.id, ownerId: fixture.ownerId, workerId: "failure-worker", lockToken: held.lockToken!,
      expectedStage: "claimed", nextStage: "failed", now: FIXED_NOW, errorCategory: "publish_rejected",
    }), true);
    const second = await createAttempt(client!, fixture, account, 2);
    assert.equal(second.attemptNumber, 2);
    assert.equal(second.stage, "queued");
    assert.equal((await client!.publishingJob.findUnique({ where: { id: first.id } }))?.["stage"], "failed");
    assert.equal(await client!.publishingJob.count({ where: { cycleItemId: account.itemId } }), 2);
    assert.equal((await createAttempt(client!, fixture, account, 2)).id, second.id);
  });
});

test("PostgreSQL publishing: claimed cancellation races safely with the next worker stage", testOptions, async () => {
  // Cancellation is intentionally unsupported after container creation starts;
  // this races the supported claimed-stage cancellation against stage advance.
  await withOwnedFixture(2, async ([first, second], fixture) => {
    const account = fixture.accounts.get("one")!;
    const attempt = await createAttempt(first!, fixture, account);
    const held = await claim(first!, fixture, account, attempt.id, "race-worker");
    assert.ok(held?.lockToken);
    const [cancelled, advanced] = await Promise.all([
      repository(first!).cancelClaimedPublishingAttempt(attempt.id, fixture.ownerId, "race-worker", held.lockToken!, FIXED_NOW),
      transition(second!, {
        jobId: attempt.id, ownerId: fixture.ownerId, workerId: "race-worker", lockToken: held.lockToken!,
        expectedStage: "claimed", nextStage: "container_creation_pending", now: FIXED_NOW, leaseSeconds: 60,
      }),
    ]);
    assert.equal(Number(cancelled) + Number(advanced), 1, "exactly one conditional transactional transition must win");
    const persisted = await first!.publishingJob.findUnique({ where: { id: attempt.id } });
    const item = await first!.cycleItem.findUnique({ where: { id: account.itemId } });
    assert.ok(["cancelled", "container_creation_pending"].includes(String(persisted?.["stage"])));
    if (cancelled) {
      assert.equal(persisted?.["stage"], "cancelled");
      assert.equal(item?.["status"], "scheduled");
      assert.equal(item?.["lockedBy"], null);
    } else {
      assert.equal(persisted?.["stage"], "container_creation_pending");
      assert.equal(item?.["status"], "publishing");
      assert.equal(item?.["lockedBy"], "race-worker");
    }
  });
});

test("PostgreSQL publishing: claims on distinct accounts remain independent", testOptions, async () => {
  await withOwnedFixture(2, async ([first, second], fixture) => {
    const primary = fixture.accounts.get("one")!;
    const other = await seedAccount(first!, fixture, "two");
    const firstAttempt = await createAttempt(first!, fixture, primary);
    const secondAttempt = await createAttempt(first!, fixture, other);
    const results = await Promise.all([
      claim(first!, fixture, primary, firstAttempt.id, "account-one-worker"),
      claim(second!, fixture, other, secondAttempt.id, "account-two-worker"),
    ]);
    assert.ok(results[0]?.lockToken);
    assert.ok(results[1]?.lockToken);
    assert.notEqual(results[0]?.socialAccountId, results[1]?.socialAccountId);
    assert.equal((await first!.publishingJob.findUnique({ where: { id: firstAttempt.id } }))?.["workerId"], "account-one-worker");
    assert.equal((await first!.publishingJob.findUnique({ where: { id: secondAttempt.id } }))?.["workerId"], "account-two-worker");
  });
});

test("PostgreSQL publishing: ambiguous outcome survives re-entry without replaying the mock adapter", testOptions, async () => {
  await withOwnedFixture(2, async ([first, restarted], fixture) => {
    const account = fixture.accounts.get("one")!;
    const attempt = await createAttempt(first!, fixture, account);
    const held = await claim(first!, fixture, account, attempt.id, "ambiguous-worker");
    assert.ok(held?.lockToken);
    await advanceToPublishing(first!, held, fixture.ownerId);

    let publishCalls = 0;
    const mockAdapters = createMockPublishingAdapters({ publishing: { kind: "ambiguous" }, verification: { kind: "unknown" } });
    const adapters = {
      ...mockAdapters,
      async publishContainer(input: Parameters<typeof mockAdapters.publishContainer>[0]) {
        publishCalls += 1;
        return mockAdapters.publishContainer(input);
      },
    };
    const outcome = await adapters.publishContainer({
      attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey, cycleId: account.cycleId,
      cycleItemId: account.itemId, ownerId: fixture.ownerId, socialAccountId: account.accountId,
      mediaAssetId: account.mediaId, caption: "Synthetic only", containerId: "synthetic-container",
    });
    assert.deepEqual(outcome, { kind: "ambiguous" });
    assert.deepEqual(await adapters.verifyPublishingResult({
      attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey, cycleId: account.cycleId,
      cycleItemId: account.itemId, ownerId: fixture.ownerId, socialAccountId: account.accountId,
      mediaAssetId: account.mediaId, caption: "Synthetic only", containerId: "synthetic-container",
    }), { kind: "unknown" });
    assert.equal(await transition(first!, {
      jobId: attempt.id, ownerId: fixture.ownerId, workerId: "ambiguous-worker", lockToken: held.lockToken!,
      expectedStage: "publishing", nextStage: "needs_manual_review", now: FIXED_NOW,
      errorCategory: "publish_timeout",
    }), true);

    const restartedRepo = repository(restarted!);
    const persistedAttempts = await restartedRepo.listPublishingAttemptsForItem(fixture.ownerId, account.cycleId, account.itemId);
    assert.equal(persistedAttempts.length, 1);
    assert.equal(persistedAttempts[0]?.stage, "needs_manual_review");
    assert.equal(persistedAttempts[0]?.outcome, "ambiguous");
    assert.equal(await claim(restarted!, fixture, account, attempt.id, "restart-worker", new Date(FIXED_NOW.getTime() + 60_000)), null);

    const reentry = createPublishingWorker({
      repo: restartedRepo, enabled: true, workerId: "restart-worker", now: () => new Date(FIXED_NOW.getTime() + 60_000),
      newId: () => `${fixture.prefix}-unexpected-attempt`, adapters,
    });
    const result = await reentry.runOnce();
    assert.notEqual(result.status, "published");
    assert.equal(publishCalls, 1, "re-entry must not invoke a second publish request");
    assert.equal(await restarted!.publishingJob.count({ where: { cycleItemId: account.itemId } }), 1);
    assert.equal((await restarted!.cycleItem.findUnique({ where: { id: account.itemId } }))?.["status"], "needs_review");
  });
});
