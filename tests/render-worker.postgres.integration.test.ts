// PostgreSQL integration tests for durable render jobs and output metadata.
// No dotenv files, storage providers, FFmpeg, workers, or external services are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { RenderJobRecord } from "../src/server/repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "54836";
const TEST_DATABASE_NAME = "clipforge_local_test";
const TEST_DATABASE_ROLE = "clipforge_test_admin";
const TEST_POSTGRES_VERSION = /^PostgreSQL 15\.8\b/;
const FIXED_NOW = new Date("2026-11-24T12:00:00.000Z");
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
type Fixture = {
  prefix: string;
  ownerId: string;
  otherOwnerId: string;
  ownedUserIds: Set<string>;
  ownedMediaIds: Set<string>;
  ownedJobIds: Set<string>;
  ownedDerivativeIds: Set<string>;
};

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct) throw new Error("Both DATABASE_URL and DIRECT_URL are required for render PostgreSQL integration tests.");
  if (database !== direct) throw new Error("DATABASE_URL and DIRECT_URL must match exactly for render PostgreSQL integration tests.");
  if (process.env["NODE_ENV"] !== "test" || process.env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test") {
    throw new Error("NODE_ENV=test and CLIPFORGE_DEPLOYMENT_ENV=test are required for render PostgreSQL integration tests.");
  }
  if (process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== TEST_DATABASE_PORT) {
    throw new Error("CLIPFORGE_TEST_DATABASE_PORT must explicitly equal 54836 for render PostgreSQL integration tests.");
  }

  let parsed: URL;
  try { parsed = new URL(database); }
  catch { throw new Error("DATABASE_URL is not a valid isolated PostgreSQL test target."); }
  const exactTarget = parsed.protocol === "postgresql:" && parsed.hostname === TEST_DATABASE_HOST &&
    parsed.port === TEST_DATABASE_PORT && parsed.pathname === `/${TEST_DATABASE_NAME}` &&
    parsed.search === "" && parsed.hash === "";
  if (!exactTarget) throw new Error("Database URLs must target only 127.0.0.1:54836/clipforge_local_test and contain no query or fragment.");
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
  const prefix = `renderpg-${randomUUID().replaceAll("-", "")}`;
  return {
    prefix,
    ownerId: `${prefix}-owner`,
    otherOwnerId: `${prefix}-other-owner`,
    ownedUserIds: new Set(),
    ownedMediaIds: new Set(),
    ownedJobIds: new Set(),
    ownedDerivativeIds: new Set(),
  };
}

async function createOwnedUser(db: TestClient, fixture: Fixture, userId: string): Promise<void> {
  await db.user.create({ data: { id: userId, email: `${userId}@clipforge.invalid`, passwordHash: "synthetic-not-a-password" } });
  fixture.ownedUserIds.add(userId);
}

async function createSourceMedia(db: TestClient, fixture: Fixture, ownerId = fixture.ownerId): Promise<string> {
  const mediaId = `${fixture.prefix}-${ownerId === fixture.ownerId ? "source" : "other-source"}`;
  await db.mediaAsset.create({ data: {
    id: mediaId, ownerId, kind: "video", status: "active", originalFilename: "synthetic.mp4",
    mimeType: "video/mp4", storageKey: `test/${fixture.prefix}/${mediaId}`, sizeBytes: 128n,
    metadataValidated: true,
  } });
  fixture.ownedMediaIds.add(mediaId);
  return mediaId;
}

function makeRenderJob(fixture: Fixture, mediaId: string, overrides: Partial<RenderJobRecord> = {}): RenderJobRecord {
  const settingsHash = "a".repeat(64);
  return {
    id: `${fixture.prefix}-job`, ownerId: fixture.ownerId, kind: "render", status: "queued",
    cycleItemId: null, mediaAssetId: mediaId, progressPercent: 0, attempts: 0,
    idempotencyKey: `render:${fixture.ownerId}:${mediaId}:${settingsHash}`, lockedBy: null,
    lockExpiresAt: null, errorMessage: null, createdAt: FIXED_NOW, finishedAt: null,
    settingsHash, payload: { version: 1, settings: "synthetic" }, pendingOutputId: null,
    outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
    ...overrides,
  };
}

function repository(client: TestClient): PrismaRepository { return new PrismaRepository(client, () => FIXED_NOW); }

async function createJob(client: TestClient, fixture: Fixture, job: RenderJobRecord): Promise<RenderJobRecord> {
  const result = await repository(client).createRenderJob(job);
  if (result.status === "conflict") assert.fail("fixture render job must not conflict");
  if (result.status === "created") fixture.ownedJobIds.add(result.job.id);
  return result.job;
}

function makeBarrier(parties: number): () => Promise<void> {
  let ready = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    ready += 1;
    if (ready === parties) release();
    await gate;
  };
}

async function cleanupFixture(db: TestClient, fixture: Fixture): Promise<void> {
  const deleteIds = async (model: PrismaClientLike["processingJob"], ids: Set<string>) => {
    if (ids.size) await model.deleteMany({ where: { id: { in: [...ids] } } });
  };
  await deleteIds(db.processingJob, fixture.ownedJobIds);
  await deleteIds(db.mediaDerivative, fixture.ownedDerivativeIds);
  await deleteIds(db.mediaAsset, fixture.ownedMediaIds);
  await deleteIds(db.user, fixture.ownedUserIds);
}

async function withFixture<T>(clientCount: number, work: (clients: TestClient[], fixture: Fixture) => Promise<T>): Promise<T> {
  assert.ok(databaseUrl, skipReason);
  const clients: TestClient[] = [];
  const fixture = fixtureIds();
  try {
    for (let index = 0; index < clientCount; index += 1) clients.push(await createPrismaClient(databaseUrl) as TestClient);
    // Validate every independent session and migration state before any fixture insert.
    for (const client of clients) await assertDatabaseIdentityAndMigrations(client);
    await createOwnedUser(clients[0]!, fixture, fixture.ownerId);
    await createSourceMedia(clients[0]!, fixture);
    return await work(clients, fixture);
  } finally {
    let teardownError: unknown;
    try { if (clients[0]) await cleanupFixture(clients[0], fixture); }
    catch (error) { teardownError = error; }
    const closed = await Promise.allSettled(clients.map((client) => client.$disconnect()));
    const closeError = closed.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (teardownError) throw teardownError;
    if (closeError) throw closeError.reason;
  }
}

const testOptions = { skip: databaseUrl ? false : skipReason };

test("PostgreSQL render: concurrent identical job creation persists one idempotent job", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const mediaId = `${fixture.prefix}-source`;
    const firstInput = makeRenderJob(fixture, mediaId, { id: `${fixture.prefix}-candidate-a` });
    const secondInput = { ...firstInput, id: `${fixture.prefix}-candidate-b` };
    const barrier = makeBarrier(2);
    const results = await Promise.all([
      (async () => { await barrier(); return repository(first!).createRenderJob(firstInput); })(),
      (async () => { await barrier(); return repository(second!).createRenderJob(secondInput); })(),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
    for (const result of results) if (result.status === "created") fixture.ownedJobIds.add(result.job.id);
    const persisted = await first!.processingJob.findMany({ where: { idempotencyKey: firstInput.idempotencyKey } });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.["ownerId"], fixture.ownerId);
    assert.equal(persisted[0]?.["mediaAssetId"], mediaId);
    assert.equal(await first!.processingJob.count({ where: { ownerId: fixture.ownerId, kind: "render" } }), 1);
  });
});

test("PostgreSQL render: conflicting inputs cannot reuse an existing idempotency key", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const original = makeRenderJob(fixture, `${fixture.prefix}-source`);
    const created = await createJob(client!, fixture, original);
    const conflict = await repository(client!).createRenderJob({ ...original, id: `${fixture.prefix}-conflict`, settingsHash: "b".repeat(64), payload: { version: 1, settings: "different" } });
    assert.equal(conflict.status, "conflict");
    assert.equal(await client!.processingJob.count({ where: { idempotencyKey: original.idempotencyKey } }), 1);
    const persisted = await client!.processingJob.findUnique({ where: { id: created.id } });
    assert.equal(persisted?.["settingsHash"], original.settingsHash);
    assert.deepEqual(persisted?.["payload"], original.payload);
  });
});

test("PostgreSQL render: independent workers cannot both claim one explicitly selected job", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const job = await createJob(first!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const barrier = makeBarrier(2);
    const results = await Promise.all([
      (async () => { await barrier(); return repository(first!).claimNextRenderJob({ workerId: "render-worker-a", now: FIXED_NOW, leaseSeconds: 60, jobId: job.id }); })(),
      (async () => { await barrier(); return repository(second!).claimNextRenderJob({ workerId: "render-worker-b", now: FIXED_NOW, leaseSeconds: 60, jobId: job.id }); })(),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.find(Boolean)!;
    assert.ok(winner.lockToken);
    const persisted = await first!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["status"], "running");
    assert.equal(persisted?.["lockToken"], winner.lockToken);
    assert.equal(persisted?.["lockedBy"], winner.lockedBy);
    assert.equal(persisted?.["attempts"], 1);
    assert.ok(persisted?.["pendingOutputId"]);
  });
});

test("PostgreSQL render: heartbeat renews only for the current owner and token", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const job = await createJob(client!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const claimed = await repository(client!).claimNextRenderJob({ workerId: "heartbeat-owner", now: FIXED_NOW, leaseSeconds: 60, jobId: job.id });
    assert.ok(claimed?.lockToken);
    const oldExpiry = claimed.lockExpiresAt!.getTime();
    assert.equal(await repository(client!).heartbeatRenderJob(job.id, fixture.ownerId, claimed.lockToken!, new Date(FIXED_NOW.getTime() + 5_000), 120), true);
    assert.equal(await repository(client!).heartbeatRenderJob(job.id, `${fixture.ownerId}-wrong`, claimed.lockToken!, FIXED_NOW, 300), false);
    assert.equal(await repository(client!).heartbeatRenderJob(job.id, fixture.ownerId, "wrong-token", FIXED_NOW, 300), false);
    const persisted = await client!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal((persisted?.["lockExpiresAt"] as Date).getTime(), FIXED_NOW.getTime() + 125_000);
    assert.ok((persisted?.["lockExpiresAt"] as Date).getTime() > oldExpiry);
    assert.equal(persisted?.["lockToken"], claimed.lockToken);
    assert.equal(persisted?.["lockedBy"], "heartbeat-owner");
  });
});

test("PostgreSQL render: expired job is reclaimed with a new fence and pending output; stale worker is rejected", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const job = await createJob(first!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const oldClaim = await repository(first!).claimNextRenderJob({ workerId: "interrupted-worker", now: FIXED_NOW, leaseSeconds: 10, jobId: job.id });
    assert.ok(oldClaim?.lockToken && oldClaim.pendingOutputId);
    const expiredAt = new Date(FIXED_NOW.getTime() + 11_000);
    const expireOnlyFixture = await first!.processingJob.updateMany({
      where: { id: job.id, ownerId: fixture.ownerId, kind: "render", status: "running", lockToken: oldClaim.lockToken },
      data: { lockExpiresAt: new Date(expiredAt.getTime() - 1) },
    });
    assert.equal(expireOnlyFixture.count, 1);

    const reclaimed = await repository(second!).claimNextRenderJob({ workerId: "recovery-worker", now: expiredAt, leaseSeconds: 60, jobId: job.id });
    assert.ok(reclaimed?.lockToken && reclaimed.pendingOutputId);
    assert.notEqual(reclaimed.lockToken, oldClaim.lockToken);
    assert.notEqual(reclaimed.pendingOutputId, oldClaim.pendingOutputId);
    assert.equal(reclaimed.attempts, oldClaim.attempts + 1);
    assert.equal(await repository(first!).updateRenderJobProgress(job.id, fixture.ownerId, oldClaim.lockToken!, 50), false);
    assert.equal(await repository(first!).heartbeatRenderJob(job.id, fixture.ownerId, oldClaim.lockToken!, expiredAt, 60), false);
    assert.equal(await repository(first!).completeRenderJob(job.id, fixture.ownerId, oldClaim.lockToken!, expiredAt, `${fixture.prefix}-stale-output`), false);
    assert.equal(await repository(first!).failRenderJob(job.id, fixture.ownerId, oldClaim.lockToken!, expiredAt, "stale failure"), false);
    assert.equal(await repository(first!).cancelRenderJob(job.id, fixture.ownerId, oldClaim.lockToken!, expiredAt), false);

    const persisted = await first!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["status"], "running");
    assert.equal(persisted?.["lockedBy"], "recovery-worker");
    assert.equal(persisted?.["lockToken"], reclaimed.lockToken);
    assert.equal(persisted?.["attempts"], 2);
    assert.equal(persisted?.["outputDerivativeId"], null);
    assert.equal(await second!.processingJob.count({ where: { id: job.id } }), 1);
  });
});

test("PostgreSQL render: definite failure remains terminal and does not create a duplicate retry row", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const job = await createJob(client!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const claimed = await repository(client!).claimNextRenderJob({ workerId: "failure-worker", now: FIXED_NOW, leaseSeconds: 60, jobId: job.id });
    assert.ok(claimed?.lockToken);
    assert.equal(await repository(client!).failRenderJob(job.id, fixture.ownerId, claimed.lockToken!, FIXED_NOW, "synthetic definite failure"), true);
    const replay = await repository(client!).createRenderJob({ ...job, id: `${fixture.prefix}-retry-candidate` });
    assert.equal(replay.status, "existing");
    assert.equal(replay.job.id, job.id);
    assert.equal(await repository(client!).claimNextRenderJob({ workerId: "retry-worker", now: new Date(FIXED_NOW.getTime() + 60_000), leaseSeconds: 60, jobId: job.id }), null);
    const persisted = await client!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["status"], "failed");
    assert.equal(persisted?.["lockToken"], null);
    assert.equal(persisted?.["attempts"], 1);
    assert.equal(await client!.processingJob.count({ where: { idempotencyKey: job.idempotencyKey } }), 1);
  });
});

test("PostgreSQL render: cancellation and completion race has one persisted terminal winner", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const job = await createJob(first!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const claimed = await repository(first!).claimNextRenderJob({ workerId: "terminal-race-worker", now: FIXED_NOW, leaseSeconds: 60, jobId: job.id });
    assert.ok(claimed?.lockToken);
    const barrier = makeBarrier(2);
    const [completed, cancelled] = await Promise.all([
      (async () => { await barrier(); return repository(first!).completeRenderJob(job.id, fixture.ownerId, claimed.lockToken!, FIXED_NOW, `${fixture.prefix}-synthetic-output`); })(),
      (async () => { await barrier(); return repository(second!).cancelRenderJob(job.id, fixture.ownerId, claimed.lockToken!, FIXED_NOW); })(),
    ]);
    assert.equal(Number(completed) + Number(cancelled), 1);
    const persisted = await first!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["status"], completed ? "succeeded" : "cancelled");
    assert.equal(persisted?.["lockToken"], null);
    assert.equal(persisted?.["lockedBy"], null);
    assert.equal(persisted?.["outputDerivativeId"], completed ? `${fixture.prefix}-synthetic-output` : null);
  });
});

test("PostgreSQL render: interrupted job re-entry adopts one verified database output and completes once", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const mediaId = `${fixture.prefix}-source`;
    const job = await createJob(first!, fixture, makeRenderJob(fixture, mediaId));
    const oldClaim = await repository(first!).claimNextRenderJob({ workerId: "lost-output-worker", now: FIXED_NOW, leaseSeconds: 5, jobId: job.id });
    assert.ok(oldClaim?.lockToken && oldClaim.pendingOutputId);
    const expiredAt = new Date(FIXED_NOW.getTime() + 6_000);
    assert.equal((await first!.processingJob.updateMany({
      where: { id: job.id, ownerId: fixture.ownerId, kind: "render", status: "running", lockToken: oldClaim.lockToken },
      data: { lockExpiresAt: new Date(expiredAt.getTime() - 1) },
    })).count, 1);
    const recovered = await repository(second!).claimNextRenderJob({ workerId: "output-recovery-worker", now: expiredAt, leaseSeconds: 60, jobId: job.id });
    assert.ok(recovered?.lockToken && recovered.pendingOutputId);

    const staleOutput = await repository(first!).saveRenderOutput({
      id: oldClaim.pendingOutputId!, sourceMediaId: mediaId, ownerId: fixture.ownerId,
      storageKey: `render/${fixture.ownerId}/${oldClaim.pendingOutputId}`, sizeBytes: 256,
      settingsHash: job.settingsHash!, createdAt: FIXED_NOW,
    }, 1_000_000, { id: job.id, ownerId: fixture.ownerId, lockToken: oldClaim.lockToken! });
    assert.deepEqual(staleOutput, { status: "stale_job" });
    assert.equal(await first!.mediaDerivative.count({ where: { mediaAssetId: mediaId, ownerId: fixture.ownerId, kind: "render" } }), 0);

    const outputInput = {
      sourceMediaId: mediaId, ownerId: fixture.ownerId, sizeBytes: 256,
      settingsHash: job.settingsHash!, createdAt: FIXED_NOW,
    };
    const barrier = makeBarrier(2);
    const saves = await Promise.all([
      (async () => { await barrier(); return repository(first!).saveRenderOutput({ ...outputInput, id: recovered.pendingOutputId!, storageKey: `render/${fixture.ownerId}/${recovered.pendingOutputId}` }, 1_000_000, { id: job.id, ownerId: fixture.ownerId, lockToken: recovered.lockToken! }); })(),
      (async () => { await barrier(); return repository(second!).saveRenderOutput({ ...outputInput, id: `${fixture.prefix}-competing-output`, storageKey: `render/${fixture.ownerId}/${fixture.prefix}-competing-output` }, 1_000_000, { id: job.id, ownerId: fixture.ownerId, lockToken: recovered.lockToken! }); })(),
    ]);
    assert.deepEqual(saves.map((result) => result.status).sort(), ["duplicate", "saved"]);
    const saved = saves.find((result) => result.status === "saved");
    if (!saved || saved.status !== "saved") assert.fail("exactly one render output must be saved");
    const duplicate = saves.find((result) => result.status === "duplicate");
    if (!duplicate || duplicate.status !== "duplicate") assert.fail("the competing output must resolve as a duplicate");
    const outputId = saved.id;
    fixture.ownedDerivativeIds.add(outputId);
    assert.equal(duplicate.id, outputId);
    assert.equal(await first!.mediaDerivative.count({ where: { mediaAssetId: mediaId, ownerId: fixture.ownerId, kind: "render", settingsHash: job.settingsHash } }), 1);

    assert.equal(await repository(first!).completeRenderJob(job.id, fixture.ownerId, recovered.lockToken!, expiredAt, outputId), true);
    assert.equal(await repository(second!).completeRenderJob(job.id, fixture.ownerId, recovered.lockToken!, expiredAt, outputId), false);
    const persisted = await first!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["status"], "succeeded");
    assert.equal(persisted?.["outputDerivativeId"], outputId);
    assert.equal((await repository(first!).findRenderOutput(fixture.ownerId, mediaId, job.settingsHash!))?.id, outputId);
    assert.deepEqual((await repository(first!).listRenderOutputsForOwner(fixture.ownerId)).map((row) => row.id), [outputId]);
    assert.deepEqual(await repository(second!).listRenderOutputsForOwner(fixture.otherOwnerId), []);
    const derivative = await first!.mediaDerivative.findUnique({ where: { id: outputId } });
    assert.equal(derivative?.["ownerId"], fixture.ownerId);
    assert.equal(derivative?.["mediaAssetId"], mediaId);
  });
});

test("PostgreSQL render: another owner cannot read or mutate a fixture job", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    await createOwnedUser(client!, fixture, fixture.otherOwnerId);
    const job = await createJob(client!, fixture, makeRenderJob(fixture, `${fixture.prefix}-source`));
    const repo = repository(client!);
    assert.equal(await repo.getRenderJobForOwner(job.id, fixture.otherOwnerId), null);
    assert.equal(await repo.getRenderJobByIdempotencyKey(job.idempotencyKey, fixture.otherOwnerId), null);
    assert.deepEqual(await repo.listRenderJobsForOwner(fixture.otherOwnerId), []);
    assert.equal(await repo.heartbeatRenderJob(job.id, fixture.otherOwnerId, "any-token", FIXED_NOW, 60), false);
    assert.equal(await repo.updateRenderJobProgress(job.id, fixture.otherOwnerId, "any-token", 50), false);
    assert.equal(await repo.completeRenderJob(job.id, fixture.otherOwnerId, "any-token", FIXED_NOW, "foreign-output"), false);
    assert.equal(await repo.failRenderJob(job.id, fixture.otherOwnerId, "any-token", FIXED_NOW, "foreign failure"), false);
    assert.equal(await repo.cancelRenderJob(job.id, fixture.otherOwnerId, "any-token", FIXED_NOW), false);
    const persisted = await client!.processingJob.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.["ownerId"], fixture.ownerId);
    assert.equal(persisted?.["status"], "queued");
    assert.equal(persisted?.["progressPercent"], 0);
    assert.equal(persisted?.["lockToken"], null);
    assert.equal(await client!.processingJob.count({ where: { id: job.id } }), 1);
  });
});
