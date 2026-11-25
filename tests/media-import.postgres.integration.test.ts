// PostgreSQL-backed media-import repository and worker integration tests.
// The isolated-database guard rejects every target except the explicit loopback
// test database before createPrismaClient can open a connection.
// Worker-function coverage uses only runNextMediaImportJob with an explicit fixture
// jobId and MemoryMediaStorage; no worker process or unspecified job claim is run.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeCollection, makeMedia } from "./helpers.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { runNextMediaImportJob } from "../src/server/media-import/import-worker.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { mediaKeyFor } from "../src/server/storage/media-storage.ts";
import type { MediaImportJobRecord } from "../src/server/repository.ts";

const databaseSkip = "DATABASE_URL is not configured for the isolated local test database";
const TEST_DATABASE_NAME = "clipforge_local_test";
const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "54836";
const TEST_DATABASE_ROLE = "clipforge_test_admin";
const TEST_POSTGRES_VERSION = /^PostgreSQL 15\.8\b/;
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
] as const;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const SOURCE_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const SOURCE_HASH = createHash("sha256").update(SOURCE_BYTES).digest("hex");

function isolatedMediaImportTestDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct) throw new Error("Both DATABASE_URL and DIRECT_URL are required for media-import PostgreSQL integration tests.");
  if (database !== direct) throw new Error("DATABASE_URL and DIRECT_URL must identify the same isolated media-import test database.");
  if (process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== TEST_DATABASE_PORT) {
    throw new Error("CLIPFORGE_TEST_DATABASE_PORT must match the dedicated media-import test port.");
  }

  let parsed: URL;
  try {
    parsed = new URL(database);
  } catch {
    throw new Error("DATABASE_URL is not a valid isolated media-import test target.");
  }
  const queryKeys = [...parsed.searchParams.keys()];
  if (parsed.protocol !== "postgresql:" || parsed.hostname !== TEST_DATABASE_HOST || parsed.port !== TEST_DATABASE_PORT ||
      parsed.pathname !== `/${TEST_DATABASE_NAME}` || parsed.hash !== "" || queryKeys.some((key) => key !== "schema")) {
    throw new Error("Database URLs must target only the dedicated loopback media-import test database.");
  }

  // Keep the shared guard in force for every other database-backed test.
  const guarded = isolatedDatabaseUrl();
  if (guarded !== database) throw new Error("Database URLs failed the isolated test database guard.");
  return database;
}

const databaseUrl = isolatedMediaImportTestDatabaseUrl();

type TestPrismaClient = PrismaClientLike & { $disconnect(): Promise<void> };

type ImportFixture = {
  prefix: string;
  ownerId: string;
  importerId: string;
  sourceMediaId: string;
  collectionId: string;
  collectionItemId: string;
  permissionId: string;
  mediaIds: Set<string>;
  jobIds: Set<string>;
  storage: MemoryMediaStorage;
  repo: PrismaRepository;
};

function fixtureIds(): ImportFixture {
  const prefix = `mi-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  return {
    prefix,
    ownerId: `${prefix}-owner`,
    importerId: `${prefix}-importer`,
    sourceMediaId: `${prefix}-source`,
    collectionId: `${prefix}-collection`,
    collectionItemId: `${prefix}-collection-item`,
    permissionId: `${prefix}-permission`,
    mediaIds: new Set([`${prefix}-source`]),
    jobIds: new Set(),
    storage: new MemoryMediaStorage(),
    repo: undefined as unknown as PrismaRepository,
  };
}

async function assertLocalDatabaseIdentity(db: TestPrismaClient): Promise<void> {
  const identity = await db.$queryRaw`SELECT current_database() AS "databaseName",
    inet_server_addr()::text AS "serverAddress",
    current_setting('port') AS "serverPort",
    current_user AS "currentRole",
    version() AS "serverVersion"` as Array<Record<string, unknown>>;
  assert.equal(identity.length, 1, "database identity query must return one row");
  assert.equal(identity[0]?.["databaseName"], TEST_DATABASE_NAME, "refusing an unexpected PostgreSQL database");
  assert.ok([TEST_DATABASE_HOST, `${TEST_DATABASE_HOST}/32`].includes(String(identity[0]?.["serverAddress"])), "refusing a server not bound to the expected loopback address");
  assert.equal(String(identity[0]?.["serverPort"]), TEST_DATABASE_PORT, "refusing an unexpected PostgreSQL port");
  assert.equal(identity[0]?.["currentRole"], TEST_DATABASE_ROLE, "refusing an unexpected PostgreSQL role");
  assert.match(String(identity[0]?.["serverVersion"]), TEST_POSTGRES_VERSION, "expected the isolated PostgreSQL 15.8 cluster");

  const migrationRows = await db.$queryRaw`SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
    FROM public."_prisma_migrations"
    ORDER BY "migration_name"` as Array<Record<string, unknown>>;
  assert.deepEqual(migrationRows.map((row) => row["migrationName"]), [...EXPECTED_MIGRATIONS], "all expected migrations must be recorded, with no missing or unexpected migrations");
  assert.ok(migrationRows.every((row) => row["finishedAt"] instanceof Date && row["rolledBackAt"] === null), "all expected migrations must be applied successfully and not rolled back");
}

async function seedFixture(db: TestPrismaClient, fixture: ImportFixture): Promise<void> {
  fixture.repo = new PrismaRepository(db, () => NOW);
  await db.user.create({ data: { id: fixture.ownerId, email: `${fixture.ownerId}@clipforge.invalid` } });
  await db.user.create({ data: { id: fixture.importerId, email: `${fixture.importerId}@clipforge.invalid` } });

  const storageKey = mediaKeyFor(fixture.ownerId, fixture.sourceMediaId);
  const source = makeMedia({
    id: fixture.sourceMediaId,
    ownerId: fixture.ownerId,
    kind: "video",
    status: "active",
    sizeBytes: SOURCE_BYTES.byteLength,
    title: "Synthetic media-import integration fixture",
    mimeType: "video/mp4",
    validation: "verified",
    checksumSha256: SOURCE_HASH,
    createdAt: NOW,
  });
  assert.equal(await fixture.repo.addMediaIfStorageWithin(source, { storageKey, thumbnailKey: null }, 1024), true);

  await db.videoCollection.create({ data: {
    id: fixture.collectionId,
    ownerId: fixture.ownerId,
    name: "Synthetic media-import collection",
    visibility: "private",
    archived: false,
  } });
  await db.collectionItem.create({ data: {
    id: fixture.collectionItemId,
    collectionId: fixture.collectionId,
    mediaAssetId: fixture.sourceMediaId,
    position: 0,
    captionText: "",
    coverMediaId: null,
    version: 1,
  } });
  await db.collectionPermission.create({ data: {
    id: fixture.permissionId,
    collectionId: fixture.collectionId,
    granteeId: fixture.importerId,
    capabilities: ["view", "import_copy"],
    status: "active",
    expiresAt: null,
    grantedById: fixture.ownerId,
    revokedAt: null,
  } });
  fixture.storage.objects.set(storageKey, SOURCE_BYTES.slice());
}

async function enqueue(fixture: ImportFixture, repo: PrismaRepository, label: string): Promise<{
  jobId: string;
  resultMediaAssetId: string;
  idempotencyKey: string;
  result: Awaited<ReturnType<PrismaRepository["createOrGetMediaImportJob"]>>;
}> {
  const jobId = `${fixture.prefix}-job-${label}`;
  const resultMediaAssetId = `${fixture.prefix}-result-${label}`;
  const idempotencyKey = `import:${fixture.importerId}:${fixture.sourceMediaId}`;
  fixture.jobIds.add(jobId);
  fixture.mediaIds.add(resultMediaAssetId);
  const result = await repo.createOrGetMediaImportJob({
    id: jobId,
    importerId: fixture.importerId,
    sourceMediaId: fixture.sourceMediaId,
    sourceCollectionId: fixture.collectionId,
    resultMediaAssetId,
    idempotencyKey,
    now: NOW,
  });
  return { jobId, resultMediaAssetId, idempotencyKey, result };
}

async function cleanupFixture(db: TestPrismaClient, fixture: ImportFixture): Promise<void> {
  const jobIds = [...fixture.jobIds];
  const mediaIds = [...fixture.mediaIds];

  // Repository-created audit IDs are generated by Prisma. Resolve only rows
  // attached to this fixture's exact job IDs and actors, then delete by IDs.
  const auditRows = jobIds.length === 0 ? [] : await db.auditLog.findMany({
    where: { entityId: { in: jobIds }, actorId: { in: [fixture.ownerId, fixture.importerId] } },
    select: { id: true },
  });
  const auditIds = auditRows.map((row) => String(row["id"]));

  if (jobIds.length > 0) await db.mediaImportJob.deleteMany({ where: { id: { in: jobIds } } });
  if (auditIds.length > 0) await db.auditLog.deleteMany({ where: { id: { in: auditIds } } });
  await db.collectionPermission.deleteMany({ where: { id: fixture.permissionId } });
  await db.collectionItem.deleteMany({ where: { id: fixture.collectionItemId } });
  await db.videoCollection.deleteMany({ where: { id: fixture.collectionId } });

  const resultIds = mediaIds.filter((id) => id !== fixture.sourceMediaId);
  if (resultIds.length > 0) await db.mediaAsset.deleteMany({ where: { id: { in: resultIds } } });
  await db.mediaAsset.deleteMany({ where: { id: fixture.sourceMediaId } });
  await db.user.deleteMany({ where: { id: { in: [fixture.ownerId, fixture.importerId] } } });
  fixture.storage.staged.clear();
  fixture.storage.objects.clear();
}

async function withFixture(
  clientCount: 1 | 2,
  run: (clients: TestPrismaClient[], fixture: ImportFixture) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl, databaseSkip);
  const clients: TestPrismaClient[] = [];
  let fixture: ImportFixture | null = null;
  try {
    for (let index = 0; index < clientCount; index += 1) {
      clients.push(await createPrismaClient(databaseUrl) as TestPrismaClient);
    }
    // Check each independent connection before the first fixture write.
    for (const client of clients) await assertLocalDatabaseIdentity(client);
    fixture = fixtureIds();
    await seedFixture(clients[0]!, fixture);
    await run(clients, fixture);
  } finally {
    try {
      if (fixture && clients[0]) await cleanupFixture(clients[0], fixture);
    } finally {
      const closeResults = await Promise.allSettled(clients.map((client) => client.$disconnect()));
      const closeFailure = closeResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (closeFailure) throw closeFailure.reason;
    }
  }
}

function importedAsset(fixture: ImportFixture, job: MediaImportJobRecord) {
  return makeMedia({
    id: job.resultMediaAssetId,
    ownerId: fixture.importerId,
    kind: "video",
    status: "active",
    sizeBytes: SOURCE_BYTES.byteLength,
    title: "Synthetic media-import integration fixture",
    mimeType: "video/mp4",
    validation: "verified",
    importedFromId: fixture.sourceMediaId,
    checksumSha256: SOURCE_HASH,
    createdAt: NOW,
  });
}

function withOneCompletionAuditFailure(client: TestPrismaClient): { db: PrismaClientLike; failed: () => boolean } {
  let failed = false;
  const wrapTransactionClient = (tx: PrismaClientLike): PrismaClientLike => new Proxy(tx as object, {
    get(target, property) {
      if (property === "auditLog") {
        const delegate = Reflect.get(target, property, target) as object;
        return new Proxy(delegate, {
          get(auditTarget, auditProperty) {
            const method = Reflect.get(auditTarget, auditProperty, auditTarget);
            if (auditProperty === "create") {
              return async (args: { data: Record<string, unknown> }) => {
                if (!failed && args.data["action"] === "media.import_completed") {
                  failed = true;
                  throw new Error("synthetic completion-audit failure");
                }
                return (method as (value: unknown) => Promise<unknown>).call(auditTarget, args);
              };
            }
            return typeof method === "function" ? method.bind(auditTarget) : method;
          },
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClientLike;

  const db = new Proxy(client as object, {
    get(target, property) {
      if (property === "$transaction") {
        return (work: (tx: PrismaClientLike) => Promise<unknown>) => client.$transaction((tx) => work(wrapTransactionClient(tx)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PrismaClientLike;
  return { db, failed: () => failed };
}

const skipOptions = databaseUrl ? { timeout: 30_000 } : { skip: databaseSkip, timeout: 30_000 };

test("PostgreSQL: two independent clients cannot both claim one pending media-import job", skipOptions, async () => {
  await withFixture(2, async ([firstDb, secondDb], fixture) => {
    const firstRepo = fixture.repo;
    const secondRepo = new PrismaRepository(secondDb!, () => NOW);
    const queued = await enqueue(fixture, firstRepo, "claim-race");
    assert.equal(queued.result.status, "created");

    const [firstClaim, secondClaim] = await Promise.all([
      firstRepo.claimNextMediaImportJob({ workerId: `${fixture.prefix}-worker-a`, now: NOW, leaseSeconds: 60, jobId: queued.jobId }),
      secondRepo.claimNextMediaImportJob({ workerId: `${fixture.prefix}-worker-b`, now: NOW, leaseSeconds: 60, jobId: queued.jobId }),
    ]);
    const claims = [firstClaim, secondClaim].filter((claim) => claim !== null);
    assert.equal(claims.length, 1, "exactly one PostgreSQL transaction must claim the job");
    assert.equal(claims[0]?.attempts, 1);
    const stored = await firstDb!.mediaImportJob.findUnique({ where: { id: queued.jobId } });
    assert.equal(stored?.["attempts"], 1);
    assert.equal(stored?.["lockToken"], claims[0]?.lockToken);
  });
});

test("PostgreSQL: concurrent direct inserts enforce the MediaImportJob idempotency unique constraint", skipOptions, async () => {
  await withFixture(2, async ([firstDb, secondDb], fixture) => {
    const idempotencyKey = `import:${fixture.importerId}:${fixture.sourceMediaId}`;
    const candidateIds = [`${fixture.prefix}-unique-a`, `${fixture.prefix}-unique-b`];
    const resultIds = [`${fixture.prefix}-unique-result-a`, `${fixture.prefix}-unique-result-b`];
    for (const id of candidateIds) fixture.jobIds.add(id);
    for (const id of resultIds) fixture.mediaIds.add(id);

    let arrived = 0;
    let release!: () => void;
    let barrierTimeout: ReturnType<typeof setTimeout>;
    const bothTransactionsReady = new Promise<void>((resolve, reject) => {
      barrierTimeout = setTimeout(() => reject(new Error("Both independent insert transactions did not reach the race barrier.")), 5_000);
      release = () => { clearTimeout(barrierTimeout); resolve(); };
    });
    const insertDirectly = (db: TestPrismaClient, index: 0 | 1) => db.$transaction(async (tx) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothTransactionsReady;
      return tx.mediaImportJob.create({ data: {
        id: candidateIds[index],
        importerId: fixture.importerId,
        sourceMediaId: fixture.sourceMediaId,
        sourceCollectionId: fixture.collectionId,
        status: "pending",
        idempotencyKey,
        newObjectKey: mediaKeyFor(fixture.importerId, resultIds[index]!),
        stagingObjectKey: null,
        lockedBy: null,
        lockToken: null,
        leaseExpiresAt: null,
        attempts: 0,
        attemptStorageKeys: [],
        resultMediaAssetId: resultIds[index],
        failureReason: null,
        createdAt: NOW,
        updatedAt: NOW,
      } });
    });

    const inserts = await Promise.allSettled([insertDirectly(firstDb!, 0), insertDirectly(secondDb!, 1)]);
    const committed = inserts.filter((result) => result.status === "fulfilled");
    const rejected = inserts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(committed.length, 1, "exactly one independent transaction must commit the shared idempotency key");
    assert.equal(rejected.length, 1, "the competing insert must lose at the database unique constraint");
    assert.equal((rejected[0]!.reason as { code?: unknown }).code, "P2002", "the losing insert must be Prisma's unique-constraint error");
    assert.equal(await firstDb!.mediaImportJob.count({ where: { idempotencyKey } }), 1);
    assert.equal(await firstDb!.mediaImportJob.count({ where: { id: { in: candidateIds } } }), 1);
  });
});

test("PostgreSQL: heartbeat renews only a matching, unexpired lease", skipOptions, async () => {
  await withFixture(1, async ([db], fixture) => {
    const queued = await enqueue(fixture, fixture.repo, "heartbeat");
    assert.equal(queued.result.status, "created");
    const claim = await fixture.repo.claimNextMediaImportJob({ workerId: `${fixture.prefix}-worker`, now: NOW, leaseSeconds: 20, jobId: queued.jobId });
    assert.ok(claim);
    const originalExpiry = claim!.leaseExpiresAt!.getTime();

    assert.equal(await fixture.repo.heartbeatMediaImportJob({ jobId: queued.jobId, lockToken: claim!.lockToken!, now: new Date(NOW.getTime() + 5_000), leaseSeconds: 20 }), true);
    const renewed = await db!.mediaImportJob.findUnique({ where: { id: queued.jobId } });
    assert.equal((renewed?.["leaseExpiresAt"] as Date).getTime(), NOW.getTime() + 25_000);
    assert.ok((renewed?.["leaseExpiresAt"] as Date).getTime() > originalExpiry);
    assert.equal(await fixture.repo.heartbeatMediaImportJob({ jobId: queued.jobId, lockToken: `${claim!.lockToken}-wrong`, now: new Date(NOW.getTime() + 6_000), leaseSeconds: 20 }), false);
    assert.equal(await fixture.repo.heartbeatMediaImportJob({ jobId: queued.jobId, lockToken: claim!.lockToken!, now: new Date(NOW.getTime() + 25_000), leaseSeconds: 20 }), false, "a lease is expired at its exact expiry timestamp");
  });
});

test("PostgreSQL: expired lease reclaim fences stale transitions and finalization", skipOptions, async () => {
  await withFixture(2, async ([firstDb, secondDb], fixture) => {
    const oldRepo = fixture.repo;
    const newRepo = new PrismaRepository(secondDb!, () => NOW);
    const queued = await enqueue(fixture, oldRepo, "reclaim");
    assert.equal(queued.result.status, "created");
    const oldClaim = await oldRepo.claimNextMediaImportJob({ workerId: `${fixture.prefix}-worker-old`, now: NOW, leaseSeconds: 1, jobId: queued.jobId });
    assert.ok(oldClaim);

    const oldExpiry = new Date(NOW.getTime() + 1_000);
    const expired = await firstDb!.mediaImportJob.updateMany({
      where: { id: queued.jobId, lockToken: oldClaim!.lockToken },
      data: { leaseExpiresAt: oldExpiry },
    });
    assert.equal(expired.count, 1, "only the fixture job's lease is advanced to the deterministic expiry boundary");

    const reclaimTime = oldExpiry;
    const newClaim = await newRepo.claimNextMediaImportJob({ workerId: `${fixture.prefix}-worker-new`, now: reclaimTime, leaseSeconds: 60, jobId: queued.jobId });
    assert.ok(newClaim, "an expired lease should be reclaimable");
    assert.notEqual(newClaim!.lockToken, oldClaim!.lockToken);
    assert.notEqual(newClaim!.stagingObjectKey, oldClaim!.stagingObjectKey);
    assert.equal(newClaim!.attempts, 2);
    assert.deepEqual(newClaim!.attemptStorageKeys, [oldClaim!.stagingObjectKey, newClaim!.stagingObjectKey]);

    assert.equal(await oldRepo.heartbeatMediaImportJob({ jobId: queued.jobId, lockToken: oldClaim!.lockToken!, now: reclaimTime, leaseSeconds: 60 }), false);
    assert.equal(await oldRepo.markMediaImportVerifying({ jobId: queued.jobId, lockToken: oldClaim!.lockToken!, now: reclaimTime }), false);
    assert.equal(await oldRepo.failMediaImportJob({ jobId: queued.jobId, lockToken: oldClaim!.lockToken!, now: reclaimTime, reason: "stale test claimant" }), false);
    assert.equal(await newRepo.markMediaImportVerifying({ jobId: queued.jobId, lockToken: newClaim!.lockToken!, now: reclaimTime }), true);

    let stagedCommitCalls = 0;
    const staleFinalization = await oldRepo.finalizeMediaImportJob({
      jobId: queued.jobId,
      lockToken: oldClaim!.lockToken!,
      importerId: fixture.importerId,
      now: reclaimTime,
      media: importedAsset(fixture, newClaim!),
      storageKey: newClaim!.newObjectKey,
      commitStagedObject: async () => { stagedCommitCalls += 1; },
    });
    assert.equal(staleFinalization, "stale");
    assert.equal(stagedCommitCalls, 0, "stale finalization must not commit an output object");
    assert.equal(await firstDb!.mediaAsset.count({ where: { id: queued.resultMediaAssetId } }), 0);
    assert.equal(await firstDb!.auditLog.count({ where: { action: "media.import_completed", entityId: queued.jobId } }), 0);
    const current = await firstDb!.mediaImportJob.findUnique({ where: { id: queued.jobId } });
    assert.equal(current?.["status"], "verifying");
    assert.equal(current?.["lockToken"], newClaim!.lockToken);
  });
});

test("PostgreSQL: concurrent idempotent requests and targeted workers produce one result asset", skipOptions, async () => {
  await withFixture(2, async ([firstDb, secondDb], fixture) => {
    const firstRepo = fixture.repo;
    const secondRepo = new PrismaRepository(secondDb!, () => NOW);
    const [firstRequest, secondRequest] = await Promise.all([
      enqueue(fixture, firstRepo, "idempotency-a"),
      enqueue(fixture, secondRepo, "idempotency-b"),
    ]);
    const results = [firstRequest.result, secondRequest.result];
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "existing").length, 1);
    const existing = results.find((result) => result.status === "existing");
    const created = results.find((result) => result.status === "created");
    assert.ok(existing?.status === "existing" && created?.status === "created");
    assert.equal(existing.job.id, created.job.id);
    fixture.jobIds.add(existing.job.id);
    fixture.mediaIds.add(existing.job.resultMediaAssetId);
    assert.equal(await firstDb!.mediaImportJob.count({ where: { idempotencyKey: firstRequest.idempotencyKey } }), 1);

    const noTimer = () => () => undefined;
    const [workerA, workerB] = await Promise.all([
      runNextMediaImportJob({ repo: firstRepo, storage: fixture.storage, workerId: `${fixture.prefix}-worker-a`, now: () => NOW, jobId: existing.job.id, scheduleHeartbeat: noTimer }),
      runNextMediaImportJob({ repo: secondRepo, storage: fixture.storage, workerId: `${fixture.prefix}-worker-b`, now: () => NOW, jobId: existing.job.id, scheduleHeartbeat: noTimer }),
    ]);
    assert.deepEqual([workerA, workerB].sort(), ["idle", "succeeded"]);
    assert.equal(await firstDb!.mediaAsset.count({ where: { id: existing.job.resultMediaAssetId } }), 1);
    assert.equal(await firstDb!.auditLog.count({ where: { action: "media.import_completed", entityId: existing.job.id } }), 1);
    const finished = await firstDb!.mediaImportJob.findUnique({ where: { id: existing.job.id } });
    assert.equal(finished?.["status"], "succeeded");
    assert.equal(fixture.storage.objects.get(existing.job.newObjectKey)?.byteLength, SOURCE_BYTES.byteLength);
  });
});

test("PostgreSQL: rollback retry adopts only an exact-hash deterministic output", skipOptions, async () => {
  await withFixture(1, async ([db], fixture) => {
    const queued = await enqueue(fixture, fixture.repo, "rollback");
    assert.equal(queued.result.status, "created");
    assert.equal(queued.result.job.newObjectKey, mediaKeyFor(fixture.importerId, queued.result.job.resultMediaAssetId));
    let commitCount = 0;
    const storageCommit = fixture.storage.commit.bind(fixture.storage);
    fixture.storage.commit = async (stagingKey, finalKey) => {
      commitCount += 1;
      await storageCommit(stagingKey, finalKey);
    };

    const failure = withOneCompletionAuditFailure(db!);
    const failingRepo = new PrismaRepository(failure.db, () => NOW);
    const firstAttempt = await runNextMediaImportJob({
      repo: failingRepo,
      storage: fixture.storage,
      workerId: `${fixture.prefix}-worker-failing-audit`,
      now: () => NOW,
      jobId: queued.jobId,
      scheduleHeartbeat: () => () => undefined,
    });
    assert.equal(firstAttempt, "failed");
    assert.equal(failure.failed(), true, "the synthetic failure must occur after output commit, inside the real Prisma transaction");
    assert.equal(commitCount, 1);
    assert.deepEqual(fixture.storage.objects.get(queued.result.job.newObjectKey), SOURCE_BYTES);
    assert.equal(await db!.mediaAsset.count({ where: { id: queued.resultMediaAssetId } }), 0, "database rollback must remove the uncommitted result asset");
    assert.equal(await db!.auditLog.count({ where: { action: "media.import_completed", entityId: queued.jobId } }), 0);
    assert.equal((await db!.mediaImportJob.findUnique({ where: { id: queued.jobId } }))?.["status"], "failed");

    assert.equal(await fixture.repo.retryMediaImportJob(fixture.importerId, queued.jobId, new Date(NOW.getTime() + 1_000)), true);
    const corruptBytes = new Uint8Array(SOURCE_BYTES.length).fill(99);
    fixture.storage.objects.set(queued.result.job.newObjectKey, corruptBytes);
    const rejectedCorruptOutput = await runNextMediaImportJob({
      repo: fixture.repo,
      storage: fixture.storage,
      workerId: `${fixture.prefix}-worker-corrupt-retry`,
      now: () => new Date(NOW.getTime() + 2_000),
      jobId: queued.jobId,
      scheduleHeartbeat: () => () => undefined,
    });
    assert.equal(rejectedCorruptOutput, "failed", "same-size but wrong-hash output must not be adopted");
    assert.equal(await db!.mediaAsset.count({ where: { id: queued.resultMediaAssetId } }), 0);
    assert.equal(commitCount, 1, "the corrupt deterministic key must not be overwritten");

    fixture.storage.objects.set(queued.result.job.newObjectKey, SOURCE_BYTES.slice());
    assert.equal(await fixture.repo.retryMediaImportJob(fixture.importerId, queued.jobId, new Date(NOW.getTime() + 3_000)), true);
    const adopted = await runNextMediaImportJob({
      repo: fixture.repo,
      storage: fixture.storage,
      workerId: `${fixture.prefix}-worker-valid-retry`,
      now: () => new Date(NOW.getTime() + 4_000),
      jobId: queued.jobId,
      scheduleHeartbeat: () => () => undefined,
    });
    assert.equal(adopted, "succeeded");
    assert.equal(commitCount, 1, "an exact verified existing output is adopted without a second commit");
    assert.equal(await db!.mediaAsset.count({ where: { id: queued.resultMediaAssetId } }), 1);
    assert.equal(await db!.auditLog.count({ where: { action: "media.import_completed", entityId: queued.jobId } }), 1);
    const completed = await db!.mediaImportJob.findUnique({ where: { id: queued.jobId } });
    assert.equal(completed?.["status"], "succeeded");
    assert.equal(createHash("sha256").update(fixture.storage.objects.get(queued.result.job.newObjectKey)!).digest("hex"), SOURCE_HASH);
  });
});

test("PostgreSQL: fixture cleanup removes only registered rows in foreign-key-safe order", skipOptions, async () => {
  await withFixture(1, async ([db], firstFixture) => {
    const secondFixture = fixtureIds();
    try {
      await seedFixture(db!, secondFixture);
      const firstJob = await enqueue(firstFixture, firstFixture.repo, "cleanup-scoped");
      assert.equal(firstJob.result.status, "created");

      await cleanupFixture(db!, firstFixture);
      assert.equal(await db!.user.count({ where: { id: firstFixture.ownerId } }), 0);
      assert.equal(await db!.mediaImportJob.count({ where: { id: firstJob.jobId } }), 0);
      assert.equal(await db!.user.count({ where: { id: secondFixture.ownerId } }), 1, "cleanup must preserve another fixture's user");
      assert.equal(await db!.mediaAsset.count({ where: { id: secondFixture.sourceMediaId } }), 1, "cleanup must preserve another fixture's media");
      assert.equal(await db!.videoCollection.count({ where: { id: secondFixture.collectionId } }), 1, "cleanup must preserve another fixture's collection");
    } finally {
      await cleanupFixture(db!, secondFixture);
    }
  });
});
