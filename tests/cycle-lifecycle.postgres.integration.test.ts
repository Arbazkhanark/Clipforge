// PostgreSQL integration coverage for publishing-cycle persistence and races.
// No dotenv files, workers, Redis, media storage, Meta/Instagram, or external APIs are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { CycleItem } from "../src/lib/domain/types.ts";
import { buildPublishIdempotencyKey } from "../src/lib/domain/cycle-state.ts";
import { createCycle, mixIntoCycle, startPublishingCycle } from "../src/server/handlers/cycles.ts";
import type { MediaServices, RequestContext } from "../src/server/context.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { CycleRecord } from "../src/server/repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const TEST_HOST = "127.0.0.1";
const TEST_PORT = "54836";
const TEST_DATABASE = "clipforge_local_test";
const TEST_ROLE = "clipforge_test_admin";
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
] as const;

type TestClient = PrismaClientLike & { $disconnect(): Promise<void> };
type Fixture = {
  prefix: string;
  ownerId: string;
  otherOwnerId: string;
  ownerAccountId: string;
  otherAccountId: string;
  mediaId: string;
  otherMediaId: string;
  collectionId: string;
  otherCollectionId: string;
  userIds: Set<string>;
  accountIds: Set<string>;
  mediaIds: Set<string>;
  derivativeIds: Set<string>;
  collectionIds: Set<string>;
  candidateCollectionItems: Map<string, { collectionId: string; mediaAssetId: string }>;
  collectionItemIds: Set<string>;
  candidateCycleIds: Set<string>;
  candidateCycleNames: Map<string, string>;
  cycleIds: Set<string>;
  candidateItemIds: Set<string>;
  itemIds: Set<string>;
  auditIds: Set<string>;
  candidatePublishingJobIds: Set<string>;
  publishingJobIds: Set<string>;
};

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct) throw new Error("Both DATABASE_URL and DIRECT_URL are required for cycle PostgreSQL integration tests.");
  if (database !== direct) throw new Error("DATABASE_URL and DIRECT_URL must match exactly for cycle PostgreSQL integration tests.");
  if (process.env["NODE_ENV"] !== "test" || process.env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test") {
    throw new Error("NODE_ENV=test and CLIPFORGE_DEPLOYMENT_ENV=test are required for cycle PostgreSQL integration tests.");
  }
  if (process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== TEST_PORT) {
    throw new Error("CLIPFORGE_TEST_DATABASE_PORT must explicitly equal 54836 for cycle PostgreSQL integration tests.");
  }

  let parsed: URL;
  try { parsed = new URL(database); }
  catch { throw new Error("DATABASE_URL is not a valid isolated PostgreSQL test target."); }
  const safeTarget = parsed.protocol === "postgresql:" && parsed.hostname === TEST_HOST && parsed.port === TEST_PORT &&
    parsed.pathname === `/${TEST_DATABASE}` && parsed.username === TEST_ROLE && parsed.search === "" && parsed.hash === "";
  if (!safeTarget) throw new Error("Database URLs must target only the clipforge_test_admin role at 127.0.0.1:54836/clipforge_local_test with no query or fragment.");
  if (isolatedDatabaseUrl() !== database) throw new Error("Database URLs failed the shared isolated-database guard.");
  return database;
}

const databaseUrl = resolveDatabaseUrl();
const skipReason = "Both database URLs are not configured for the explicitly isolated local PostgreSQL test.";

async function assertDatabaseIdentityAndMigrations(db: TestClient): Promise<void> {
  const identity = await db.$queryRaw`SELECT current_database() AS "databaseName",
    inet_server_addr()::text AS "serverAddress", current_setting('port') AS "serverPort",
    current_user AS "currentRole", version() AS "serverVersion"` as Array<Record<string, unknown>>;
  assert.equal(identity.length, 1, "database identity query must return one row");
  assert.equal(identity[0]?.["databaseName"], TEST_DATABASE, "unexpected PostgreSQL database");
  assert.ok([TEST_HOST, `${TEST_HOST}/32`].includes(String(identity[0]?.["serverAddress"])), "unexpected PostgreSQL loopback address");
  assert.equal(String(identity[0]?.["serverPort"]), TEST_PORT, "unexpected PostgreSQL port");
  assert.equal(identity[0]?.["currentRole"], TEST_ROLE, "unexpected PostgreSQL role");
  assert.match(String(identity[0]?.["serverVersion"]), /^PostgreSQL 15\.8\b/, "expected isolated PostgreSQL 15.8");

  const rows = await db.$queryRaw`SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt"
    FROM public."_prisma_migrations" ORDER BY "migration_name"` as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row["migrationName"]), [...EXPECTED_MIGRATIONS], "expected exactly the reviewed 22 migrations");
  assert.ok(rows.every((row) => row["finishedAt"] instanceof Date && row["rolledBackAt"] === null), "all expected migrations must be applied successfully");
}

function newFixture(): Fixture {
  const prefix = `cyclepg-${randomUUID().replaceAll("-", "")}`;
  return {
    prefix, ownerId: `${prefix}-owner`, otherOwnerId: `${prefix}-other`, ownerAccountId: `${prefix}-account`, otherAccountId: `${prefix}-other-account`,
    mediaId: `${prefix}-media`, otherMediaId: `${prefix}-other-media`, collectionId: `${prefix}-collection`, otherCollectionId: `${prefix}-other-collection`,
    userIds: new Set(), accountIds: new Set(), mediaIds: new Set(), derivativeIds: new Set(), collectionIds: new Set(), candidateCollectionItems: new Map(), collectionItemIds: new Set(), candidateCycleIds: new Set(), candidateCycleNames: new Map(), cycleIds: new Set(), candidateItemIds: new Set(), itemIds: new Set(), auditIds: new Set(), candidatePublishingJobIds: new Set(), publishingJobIds: new Set(),
  };
}

function cycleRecord(fixture: Fixture, id: string, status: CycleRecord["status"] = "draft", repeatBehavior: CycleRecord["repeatBehavior"] = "never"): CycleRecord {
  return { id, ownerId: fixture.ownerId, socialAccountId: fixture.ownerAccountId, name: `Synthetic ${id}`, status,
    finalReviewConfirmed: status !== "draft", orderMode: "manual", repeatBehavior, timezone: "UTC", scheduleSettings: null, createdAt: FIXED_NOW };
}

function itemRecord(fixture: Fixture, cycleId: string, id: string, overrides: Partial<CycleItem> = {}): CycleItem {
  return { id, cycleId, cycleOwnerId: fixture.ownerId, mediaAssetId: fixture.mediaId, selectedRenderOutputId: null,
    sourceKind: "owned", sourceCollectionId: fixture.collectionId, status: "upcoming", position: 1, version: 1,
    scheduledFor: null, captionText: "Synthetic fixture", captionSource: "none", coverMediaId: null,
    coverIsCustom: false, coverState: "none", lockedBy: null, lockExpiresAt: null, reviewReason: null,
    externalPostId: null, publishedAt: null, ...overrides };
}

async function createCycleRow(client: TestClient, fixture: Fixture, id: string, status: CycleRecord["status"] = "draft", repeatBehavior: CycleRecord["repeatBehavior"] = "never"): Promise<void> {
  fixture.candidateCycleIds.add(id);
  fixture.candidateCycleNames.set(id, `Synthetic ${id}`);
  await client.publishingCycle.create({ data: {
    id, ownerId: fixture.ownerId, socialAccountId: fixture.ownerAccountId, name: `Synthetic ${id}`, status,
    finalReviewConfirmed: status !== "draft", orderMode: "manual", repeatBehavior, timezone: "UTC", scheduleSettings: {}, createdAt: FIXED_NOW,
  } });
  fixture.cycleIds.add(id);
}

async function createItemRow(client: TestClient, fixture: Fixture, item: CycleItem): Promise<void> {
  fixture.candidateItemIds.add(item.id);
  await client.cycleItem.create({ data: { ...item } });
  fixture.itemIds.add(item.id);
}

async function createBaseRows(client: TestClient, fixture: Fixture): Promise<void> {
  for (const [id, suffix] of [[fixture.ownerId, "owner"], [fixture.otherOwnerId, "other"]] as const) {
    await client.user.create({ data: { id, email: `${fixture.prefix}-${suffix}@clipforge.invalid`, passwordHash: "synthetic-test-fixture" } });
    fixture.userIds.add(id);
  }
  for (const [id, userId, suffix] of [
    [fixture.ownerAccountId, fixture.ownerId, "owner"],
    [fixture.otherAccountId, fixture.otherOwnerId, "other"],
  ] as const) {
    await client.socialAccount.create({ data: { id, userId, platform: "instagram", externalAccountId: `${fixture.prefix}-${suffix}-external`,
      status: "connected", accountType: "BUSINESS", grantedScopes: "instagram_business_basic instagram_business_content_publish",
      encryptedAccessToken: "synthetic-test-ciphertext", tokenExpiresAt: new Date("2100-01-01T00:00:00.000Z") } });
    fixture.accountIds.add(id);
  }
  for (const [id, ownerId, suffix] of [
    [fixture.mediaId, fixture.ownerId, "owner"],
    [fixture.otherMediaId, fixture.otherOwnerId, "other"],
  ] as const) {
    await client.mediaAsset.create({ data: { id, ownerId, kind: "video", status: "active", originalFilename: `${suffix}.mp4`,
      mimeType: "video/mp4", storageKey: `test/${fixture.prefix}/${suffix}`, sizeBytes: 64n, metadataValidated: true } });
    fixture.mediaIds.add(id);
  }
  for (const [id, ownerId, mediaId, suffix] of [
    [fixture.collectionId, fixture.ownerId, fixture.mediaId, "owner"],
    [fixture.otherCollectionId, fixture.otherOwnerId, fixture.otherMediaId, "other"],
  ] as const) {
    await client.videoCollection.create({ data: { id, ownerId, name: `Synthetic ${suffix}`, visibility: "private", archived: false, settingsVersion: 1 } });
    fixture.collectionIds.add(id);
    const membershipId = `${id}-membership`;
    fixture.candidateCollectionItems.set(membershipId, { collectionId: id, mediaAssetId: mediaId });
    await client.collectionItem.create({ data: { id: membershipId, collectionId: id, mediaAssetId: mediaId, position: 1, captionText: "" } });
    fixture.collectionItemIds.add(membershipId);
  }
}

async function trackCycleAudits(db: TestClient, fixture: Fixture, cycleId: string, actions: string[]): Promise<void> {
  if (!fixture.cycleIds.has(cycleId) || actions.length === 0) return;
  const rows = await db.auditLog.findMany({ where: { entityId: cycleId, action: { in: actions } } });
  for (const row of rows) {
    if (row["entityType"] === "PublishingCycle") fixture.auditIds.add(String(row["id"]));
  }
}

async function cleanupFixture(db: TestClient, fixture: Fixture): Promise<void> {
  for (const [id, expected] of fixture.candidateCollectionItems) {
    const row = await db.collectionItem.findUnique({ where: { id } });
    if (row?.["collectionId"] === expected.collectionId && row["mediaAssetId"] === expected.mediaAssetId && fixture.collectionIds.has(expected.collectionId) && fixture.mediaIds.has(expected.mediaAssetId)) fixture.collectionItemIds.add(id);
  }
  // Resolve an ambiguous create response only by re-reading and validating the
  // complete fixture ownership tuple. A planned ID alone is never sufficient.
  for (const id of fixture.candidateCycleIds) {
    const row = await db.publishingCycle.findUnique({ where: { id } });
    if (row?.["ownerId"] === fixture.ownerId && row["socialAccountId"] === fixture.ownerAccountId && row["name"] === fixture.candidateCycleNames.get(id)) fixture.cycleIds.add(id);
  }
  for (const id of fixture.candidateItemIds) {
    const row = await db.cycleItem.findUnique({ where: { id } });
    if (row && fixture.cycleIds.has(String(row["cycleId"])) && row["cycleOwnerId"] === fixture.ownerId && fixture.mediaIds.has(String(row["mediaAssetId"])) && fixture.collectionIds.has(String(row["sourceCollectionId"]))) fixture.itemIds.add(id);
  }
  for (const id of fixture.candidatePublishingJobIds) {
    const row = await db.publishingJob.findUnique({ where: { id } });
    if (row && row["ownerId"] === fixture.ownerId && fixture.cycleIds.has(String(row["cycleId"])) && fixture.itemIds.has(String(row["cycleItemId"])) && fixture.accountIds.has(String(row["socialAccountId"]))) fixture.publishingJobIds.add(id);
  }
  if (fixture.cycleIds.size) {
    const auditRows = await db.auditLog.findMany({ where: { entityType: "PublishingCycle", entityId: { in: [...fixture.cycleIds] }, action: { in: ["cycle.created", "cycle.started", "cycle.paused", "cycle.resumed", "cycle.stopped", "cycle.schedule_saved", "cycle.videos_mixed", "cycle.completed", "cycle.repeat_queued"] } } });
    for (const row of auditRows) fixture.auditIds.add(String(row["id"]));
  }
  if (fixture.publishingJobIds.size || fixture.cycleIds.size || fixture.itemIds.size) {
    await db.publishingJob.deleteMany({ where: { OR: [
      ...(fixture.publishingJobIds.size ? [{ id: { in: [...fixture.publishingJobIds] } }] : []),
      ...(fixture.cycleIds.size ? [{ cycleId: { in: [...fixture.cycleIds] } }] : []),
      ...(fixture.itemIds.size ? [{ cycleItemId: { in: [...fixture.itemIds] } }] : []),
    ] } });
  }
  if (fixture.auditIds.size) await db.auditLog.deleteMany({ where: { id: { in: [...fixture.auditIds] } } });
  if (fixture.itemIds.size) await db.cycleItem.deleteMany({ where: { id: { in: [...fixture.itemIds] } } });
  if (fixture.cycleIds.size) await db.publishingCycle.deleteMany({ where: { id: { in: [...fixture.cycleIds] } } });
  if (fixture.derivativeIds.size) await db.mediaDerivative.deleteMany({ where: { id: { in: [...fixture.derivativeIds] } } });
  if (fixture.collectionIds.size) {
    await db.collectionPermission.deleteMany({ where: { collectionId: { in: [...fixture.collectionIds] } } });
    if (fixture.collectionItemIds.size) await db.collectionItem.deleteMany({ where: { id: { in: [...fixture.collectionItemIds] } } });
    await db.videoCollection.deleteMany({ where: { id: { in: [...fixture.collectionIds] } } });
  }
  if (fixture.mediaIds.size) await db.mediaAsset.deleteMany({ where: { id: { in: [...fixture.mediaIds] } } });
  if (fixture.accountIds.size) await db.socialAccount.deleteMany({ where: { id: { in: [...fixture.accountIds] } } });
  if (fixture.userIds.size) await db.user.deleteMany({ where: { id: { in: [...fixture.userIds] } } });
}

async function withFixture<T>(clientCount: number, work: (clients: TestClient[], fixture: Fixture) => Promise<T>): Promise<T> {
  assert.ok(databaseUrl, skipReason);
  const clients: TestClient[] = [];
  const fixture = newFixture();
  try {
    for (let index = 0; index < clientCount; index += 1) clients.push(await createPrismaClient(databaseUrl) as TestClient);
    for (const client of clients) await assertDatabaseIdentityAndMigrations(client);
    await createBaseRows(clients[0]!, fixture);
    return await work(clients, fixture);
  } finally {
    try {
      if (clients[0]) await cleanupFixture(clients[0], fixture);
    } finally {
      await Promise.allSettled(clients.map((client) => client.$disconnect()));
    }
  }
}

function repository(client: TestClient): PrismaRepository { return new PrismaRepository(client, () => FIXED_NOW); }

function makeBarrier(parties: number): () => Promise<void> {
  let ready = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => { ready += 1; if (ready === parties) release(); await gate; };
}

function context(client: TestClient, fixture: Fixture, userId = fixture.ownerId, barrier?: () => Promise<void>, ids: string[] = []): RequestContext {
  const repo = repository(client);
  let idIndex = 0;
  const wrapped = new Proxy(repo, { get(target, property, receiver) {
    if (property === "addCycleItems" && barrier) return async (...args: Parameters<PrismaRepository["addCycleItems"]>) => { await barrier(); return target.addCycleItems(...args); };
    if (property === "transitionCycleStatus" && barrier) return async (...args: Parameters<PrismaRepository["transitionCycleStatus"]>) => { await barrier(); return target.transitionCycleStatus(...args); };
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { userId, now: FIXED_NOW, repo: wrapped, newId: () => ids[idIndex++] ?? `${fixture.prefix}-generated-${randomUUID()}`,
    config: { coverSupport: "supported" },
    // Preflight only asks for private object metadata. This deterministic in-memory
    // adapter never opens a file or contacts S3; no worker or publisher is invoked.
    media: { storage: { kind: "memory", getPrivateMetadata: async () => ({ sizeBytes: 64, storageKind: "memory" }) } as unknown as MediaServices["storage"], probe: null, maxUploadBytes: 1024 },
    publishingMediaAccess: {} as NonNullable<RequestContext["publishingMediaAccess"]> };
}

function clientWithAuditFailure(client: TestClient): PrismaClientLike {
  const wrapTx = (tx: PrismaClientLike): PrismaClientLike => new Proxy(tx, { get(target, property, receiver) {
    if (property === "auditLog") return new Proxy(target.auditLog, { get(delegate, method, modelReceiver) {
      if (method === "create") return async () => { throw new Error("injected synthetic audit failure"); };
      const value = Reflect.get(delegate, method, delegate) as unknown;
      return typeof value === "function" ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(client, { get(target, property, receiver) {
    if (property === "$transaction") return <T>(callback: (tx: PrismaClientLike) => Promise<T>) => target.$transaction((tx) => callback(wrapTx(tx)));
    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

const testOptions = { skip: databaseUrl ? false : skipReason };

test("PostgreSQL cycles: production create handler persists cycle, collection-derived item, and audit", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const ids = [`${fixture.prefix}-created-cycle`, `${fixture.prefix}-created-item`];
    fixture.candidateCycleIds.add(ids[0]!);
    fixture.candidateCycleNames.set(ids[0]!, "Synthetic cycle");
    fixture.candidateItemIds.add(ids[1]!);
    const created = await createCycle(context(client!, fixture, fixture.ownerId, undefined, ids), {
      name: "Synthetic cycle", socialAccountId: fixture.ownerAccountId, collectionIds: [fixture.collectionId],
    });
    fixture.cycleIds.add(created.cycleId);
    const cycle = await client!.publishingCycle.findUnique({ where: { id: created.cycleId } });
    const items = await client!.cycleItem.findMany({ where: { cycleId: created.cycleId } });
    const audits = await client!.auditLog.findMany({ where: { entityId: created.cycleId, action: "cycle.created" } });
    await trackCycleAudits(client!, fixture, created.cycleId, ["cycle.created"]);
    assert.equal(cycle?.["ownerId"], fixture.ownerId);
    assert.equal(cycle?.["status"], "draft");
    assert.equal(items.length, 1);
    fixture.itemIds.add(String(items[0]?.["id"]));
    assert.equal(items[0]?.["mediaAssetId"], fixture.mediaId);
    assert.equal(items[0]?.["sourceCollectionId"], fixture.collectionId);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.["actorId"], fixture.ownerId);
  });
});

test("PostgreSQL cycles: a private collection owned by another user cannot be used", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const before = await client!.publishingCycle.count({ where: { ownerId: fixture.ownerId } });
    await assert.rejects(() => createCycle(context(client!, fixture), {
      name: "Unauthorized synthetic cycle", socialAccountId: fixture.ownerAccountId, collectionIds: [fixture.otherCollectionId],
    }), (error: unknown) => typeof error === "object" && error !== null && "status" in error && (error as { status: number }).status === 403);
    await assert.rejects(() => createCycle(context(client!, fixture), {
      name: "Wrong-account synthetic cycle", socialAccountId: fixture.otherAccountId, collectionIds: [fixture.collectionId],
    }), (error: unknown) => typeof error === "object" && error !== null && "status" in error && (error as { status: number }).status === 404);
    assert.equal(await client!.publishingCycle.count({ where: { ownerId: fixture.ownerId } }), before);
    assert.equal(await client!.cycleItem.count({ where: { cycleOwnerId: fixture.ownerId } }), 0);
  });
});

test("PostgreSQL cycles: independent production start requests have one winner", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const id = `${fixture.prefix}-start-race`;
    await createCycleRow(first!, fixture, id);
    const derivativeId = `${fixture.prefix}-start-output`;
    await first!.mediaDerivative.create({ data: { id: derivativeId, mediaAssetId: fixture.mediaId, ownerId: fixture.ownerId, kind: "render",
      storageKey: `test/${fixture.prefix}/render-output`, sizeBytes: 64n, settingsHash: "a".repeat(64) } });
    fixture.derivativeIds.add(derivativeId);
    const item = itemRecord(fixture, id, `${id}-item`, { selectedRenderOutputId: derivativeId });
    await createItemRow(first!, fixture, item);
    const barrier = makeBarrier(2);
    const results = await Promise.allSettled([
      startPublishingCycle(context(first!, fixture, fixture.ownerId, barrier), { cycleId: id, confirmFinalReview: true }),
      startPublishingCycle(context(second!, fixture, fixture.ownerId, barrier), { cycleId: id, confirmFinalReview: true }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected" && typeof rejected.reason === "object" && rejected.reason !== null && "status" in rejected.reason && (rejected.reason as { status: number }).status === 409);
    assert.equal((await second!.publishingCycle.findUnique({ where: { id } }))?.["status"], "running");
    await trackCycleAudits(first!, fixture, id, ["cycle.started"]);
    assert.equal(await second!.auditLog.count({ where: { entityId: id, action: "cycle.started" } }), 1);
  });
});

test("PostgreSQL cycles: active-cycle limit is serialized across independent create transactions", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const barrier = makeBarrier(2);
    const candidates = [`${fixture.prefix}-limit-a`, `${fixture.prefix}-limit-b`];
    candidates.forEach((id) => { fixture.candidateCycleIds.add(id); fixture.candidateCycleNames.set(id, `Synthetic ${id}`); });
    const makeCycle = (id: string) => cycleRecord(fixture, id);
    const [a, b] = await Promise.all([
      (async () => { await barrier(); return repository(first!).createCycleWithinLimit(makeCycle(candidates[0]!), 1); })(),
      (async () => { await barrier(); return repository(second!).createCycleWithinLimit(makeCycle(candidates[1]!), 1); })(),
    ]);
    if (a) fixture.cycleIds.add(candidates[0]!);
    if (b) fixture.cycleIds.add(candidates[1]!);
    assert.deepEqual([a, b].sort(), [false, true]);
    assert.equal(await first!.publishingCycle.count({ where: { ownerId: fixture.ownerId, status: { in: ["draft", "running", "paused"] } } }), 1);
  });
});

test("PostgreSQL cycles: stale schedule item version rolls back the schedule write", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const cycleId = `${fixture.prefix}-schedule`;
    await createCycleRow(client!, fixture, cycleId);
    const item = itemRecord(fixture, cycleId, `${cycleId}-item`);
    await createItemRow(client!, fixture, item);
    const requested = { timeZone: "UTC", intervalMinutes: 60, postsPerInterval: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], windowStart: "09:00", windowEnd: "17:00", dailyMax: null, endDate: null, startDate: "2026-11-25", orderMode: "manual" as const, shuffleSeed: null };
    const saved = await repository(client!).saveCycleSchedule(cycleId, fixture.ownerId, requested, [
      { item: { ...item, status: "scheduled", scheduledFor: new Date("2026-11-25T09:00:00.000Z"), version: 2 }, expectedVersion: 99 },
    ]);
    assert.equal(saved, false);
    const persistedCycle = await client!.publishingCycle.findUnique({ where: { id: cycleId } });
    const persistedItem = await client!.cycleItem.findUnique({ where: { id: item.id } });
    assert.deepEqual(persistedCycle?.["scheduleSettings"], {});
    assert.equal(persistedItem?.["status"], "upcoming");
    assert.equal(persistedItem?.["version"], 1);
    assert.equal(persistedItem?.["scheduledFor"], null);
  });
});

test("PostgreSQL cycles: pause versus a publisher claim preserves persisted ownership state", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const cycleId = `${fixture.prefix}-pause-claim`;
    await createCycleRow(first!, fixture, cycleId, "running");
    const item = itemRecord(fixture, cycleId, `${cycleId}-item`, { status: "scheduled", scheduledFor: new Date(FIXED_NOW.getTime() - 1_000) });
    await createItemRow(first!, fixture, item);
    const attemptId = `${fixture.prefix}-attempt`;
    fixture.candidatePublishingJobIds.add(attemptId);
    const attempt = await repository(first!).createOrGetPublishingAttempt({ id: attemptId, ownerId: fixture.ownerId, cycleId, cycleItemId: item.id,
      socialAccountId: fixture.ownerAccountId, attemptNumber: 1, idempotencyKey: buildPublishIdempotencyKey({ cycleId, id: item.id }, 1), now: FIXED_NOW });
    assert.equal(attempt.status, "created");
    fixture.publishingJobIds.add(attempt.job!.id);
    const barrier = makeBarrier(2);
    const [paused, claim] = await Promise.all([
      (async () => { await barrier(); return repository(first!).transitionCycleStatus(cycleId, "running", "paused", true); })(),
      (async () => { await barrier(); return repository(second!).claimPublishingAttempt({ attemptId, ownerId: fixture.ownerId, cycleId,
        cycleItemId: item.id, socialAccountId: fixture.ownerAccountId, expectedItemVersion: 1, workerId: `${fixture.prefix}-worker`, now: FIXED_NOW, leaseSeconds: 60 }); })(),
    ]);
    assert.equal(paused, true);
    assert.equal((await second!.publishingCycle.findUnique({ where: { id: cycleId } }))?.["status"], "paused");
    const persistedItem = await second!.cycleItem.findUnique({ where: { id: item.id } });
    const persistedJob = await second!.publishingJob.findUnique({ where: { id: attemptId } });
    if (!claim) {
      assert.equal(persistedItem?.["status"], "scheduled");
      assert.equal(persistedJob?.["stage"], "queued");
    } else {
      assert.ok(claim.lockToken);
      assert.equal(persistedItem?.["status"], "publishing");
      assert.equal(persistedJob?.["stage"], "claimed");
      assert.equal(persistedJob?.["lockToken"], claim.lockToken);
    }
    assert.equal(await repository(second!).transitionCycleStatus(cycleId, "paused", "running", true), true, "resume is a persisted compare-and-set");
    assert.equal((await first!.publishingCycle.findUnique({ where: { id: cycleId } }))?.["status"], "running");
  });
});

test("PostgreSQL cycles: stop racing settlement yields one durable terminal state", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const cycleId = `${fixture.prefix}-stop-settle`;
    await createCycleRow(first!, fixture, cycleId, "running");
    const item = itemRecord(fixture, cycleId, `${cycleId}-item`, { status: "cancelled" });
    await createItemRow(first!, fixture, item);
    const barrier = makeBarrier(2);
    const [stopped, settled] = await Promise.all([
      (async () => { await barrier(); return repository(first!).stopCycle(cycleId, fixture.ownerId, "running", true, []); })(),
      (async () => { await barrier(); return repository(second!).completeSettledCycle({ cycleId, ownerId: fixture.ownerId, now: FIXED_NOW, activeCycleLimit: 5, newId: () => `${fixture.prefix}-unused-repeat` }); })(),
    ]);
    assert.ok(stopped || settled === "completed", "stop or settlement must commit a terminal transition");
    const persisted = await first!.publishingCycle.findUnique({ where: { id: cycleId } });
    await trackCycleAudits(first!, fixture, cycleId, ["cycle.completed"]);
    assert.ok(["stopped", "completed"].includes(String(persisted?.["status"])));
    if (persisted?.["status"] === "stopped") assert.equal(settled, "not_ready");
    if (persisted?.["status"] === "completed") assert.equal(stopped, false);
  });
});

test("PostgreSQL cycles: settlement is idempotent and automatic repeat creates one next cycle", testOptions, async () => {
  await withFixture(2, async ([first, second], fixture) => {
    const cycleId = `${fixture.prefix}-repeat`;
    await createCycleRow(first!, fixture, cycleId, "running", "automatic");
    const item = itemRecord(fixture, cycleId, `${cycleId}-item`, { status: "cancelled" });
    await createItemRow(first!, fixture, item);
    const generatedCycleId = `${fixture.prefix}-repeat-next`;
    const generatedItemId = `${fixture.prefix}-repeat-next-item`;
    fixture.candidateCycleIds.add(generatedCycleId);
    fixture.candidateCycleNames.set(generatedCycleId, `Synthetic ${cycleId}`);
    fixture.candidateItemIds.add(generatedItemId);
    const nextId = (() => { let index = 0; return () => [generatedCycleId, generatedItemId][index++] ?? `${fixture.prefix}-unexpected`; })();
    const firstResult = await repository(first!).completeSettledCycle({ cycleId, ownerId: fixture.ownerId, now: FIXED_NOW, activeCycleLimit: 5, newId: nextId });
    assert.equal(firstResult, "repeat_queued");
    fixture.cycleIds.add(generatedCycleId);
    fixture.itemIds.add(generatedItemId);
    await trackCycleAudits(first!, fixture, cycleId, ["cycle.completed", "cycle.repeat_queued"]);
    const secondResult = await repository(second!).completeSettledCycle({ cycleId, ownerId: fixture.ownerId, now: FIXED_NOW, activeCycleLimit: 5, newId: () => `${fixture.prefix}-duplicate` });
    assert.equal(secondResult, "already_completed");
    assert.equal(await first!.publishingCycle.count({ where: { id: generatedCycleId, ownerId: fixture.ownerId } }), 1);
    assert.equal(await first!.cycleItem.count({ where: { id: generatedItemId, cycleId: generatedCycleId, mediaAssetId: fixture.mediaId } }), 1);
    assert.equal(await first!.auditLog.count({ where: { entityId: cycleId, action: "cycle.repeat_queued" } }), 1);
  });
});

test("PostgreSQL cycles: audit failure rolls back settlement and retry commits once", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const cycleId = `${fixture.prefix}-rollback`;
    await createCycleRow(client!, fixture, cycleId, "running");
    const item = itemRecord(fixture, cycleId, `${cycleId}-item`, { status: "cancelled" });
    await createItemRow(client!, fixture, item);
    const failingRepository = new PrismaRepository(clientWithAuditFailure(client!), () => FIXED_NOW);
    await assert.rejects(() => failingRepository.completeSettledCycle({ cycleId, ownerId: fixture.ownerId, now: FIXED_NOW, activeCycleLimit: 5, newId: () => `${fixture.prefix}-unused` }), /injected synthetic audit failure/);
    assert.equal((await client!.publishingCycle.findUnique({ where: { id: cycleId } }))?.["status"], "running");
    assert.equal(await client!.auditLog.count({ where: { entityId: cycleId, action: "cycle.completed" } }), 0);
    assert.equal(await repository(client!).completeSettledCycle({ cycleId, ownerId: fixture.ownerId, now: FIXED_NOW, activeCycleLimit: 5, newId: () => `${fixture.prefix}-unused-retry` }), "completed");
    assert.equal((await client!.publishingCycle.findUnique({ where: { id: cycleId } }))?.["status"], "completed");
    assert.equal(await client!.auditLog.count({ where: { entityId: cycleId, action: "cycle.completed" } }), 1);
  });
});

test("PostgreSQL cycles: concurrent unconfirmed same-media insertions are rejected", testOptions, async () => {
  // The handler checks duplicate intent before calling addCycleItems. Both callers
  // wait at the repository boundary after that read, so the barrier exposes whether
  // the repository's parent-row lock also rechecks duplicate media (no DB constraint
  // currently declares cycleId + mediaAssetId unique).
  await withFixture(2, async ([first, second], fixture) => {
    const cycleId = `${fixture.prefix}-duplicate-media`;
    await createCycleRow(first!, fixture, cycleId);
    const barrier = makeBarrier(2);
    const idsA = [`${fixture.prefix}-duplicate-a`, `${fixture.prefix}-duplicate-item-a`];
    const idsB = [`${fixture.prefix}-duplicate-b`, `${fixture.prefix}-duplicate-item-b`];
    fixture.candidateItemIds.add(idsA[0]!);
    fixture.candidateItemIds.add(idsB[0]!);
    const [resultA, resultB] = await Promise.allSettled([
      mixIntoCycle(context(first!, fixture, fixture.ownerId, barrier, idsA), { cycleId, videos: [{ mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false }] }),
      mixIntoCycle(context(second!, fixture, fixture.ownerId, barrier, idsB), { cycleId, videos: [{ mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false }] }),
    ]);
    await trackCycleAudits(first!, fixture, cycleId, ["cycle.videos_mixed"]);
    const persisted = await first!.cycleItem.findMany({ where: { cycleId, mediaAssetId: fixture.mediaId } });
    for (const row of persisted) fixture.itemIds.add(String(row["id"]));
    const fulfilled = [resultA, resultB].filter((result) => result.status === "fulfilled");
    const rejected = [resultA, resultB].filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "only one unconfirmed request may add the media");
    assert.equal(rejected.length, 1, "the serialized stale duplicate must be rejected as a conflict");
    assert.equal(fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value.added : 0, 1);
    assert.equal(rejected[0]?.status === "rejected" && typeof rejected[0].reason === "object" && rejected[0].reason !== null && "status" in rejected[0].reason ? (rejected[0].reason as { status: number }).status : 0, 409);
    assert.equal(persisted.length, 1, "concurrent requests must not persist duplicate media rows");
  });
});

test("PostgreSQL cycles: explicitly confirmed repeat remains supported", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const cycleId = `${fixture.prefix}-confirmed-repeat`;
    await createCycleRow(client!, fixture, cycleId);
    const prior = itemRecord(fixture, cycleId, `${cycleId}-prior`);
    await createItemRow(client!, fixture, prior);
    const addedId = `${fixture.prefix}-confirmed-repeat-added`;
    fixture.candidateItemIds.add(addedId);
    const result = await mixIntoCycle(context(client!, fixture, fixture.ownerId, undefined, [addedId]), {
      cycleId, videos: [{ mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false }],
      confirmedDuplicateMediaIds: [fixture.mediaId],
    });
    assert.equal(result.added, 1);
    const persisted = await client!.cycleItem.findMany({ where: { cycleId, mediaAssetId: fixture.mediaId, status: { not: "cancelled" } } });
    for (const row of persisted) fixture.itemIds.add(String(row["id"]));
    assert.equal(persisted.length, 2, "the caller-confirmed duplicate is retained as a second cycle item");
  });
});

test("PostgreSQL cycles: confirmed duplicate media in one request persists both items in order", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const cycleId = `${fixture.prefix}-confirmed-batch-repeat`;
    await createCycleRow(client!, fixture, cycleId);
    const itemIds = [`${fixture.prefix}-confirmed-batch-first`, `${fixture.prefix}-confirmed-batch-second`];
    for (const id of itemIds) fixture.candidateItemIds.add(id);

    const result = await mixIntoCycle(context(client!, fixture, fixture.ownerId, undefined, itemIds), {
      cycleId,
      videos: [
        { mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false },
        { mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false },
      ],
      confirmedDuplicateMediaIds: [fixture.mediaId],
    });

    assert.equal(result.added, 2);
    assert.deepEqual(result.rejected, []);
    const persisted = await client!.cycleItem.findMany({
      where: { cycleId, mediaAssetId: fixture.mediaId, status: { not: "cancelled" } },
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    for (const row of persisted) fixture.itemIds.add(String(row["id"]));
    assert.equal(persisted.length, 2, "both explicitly confirmed occurrences must be persisted");
    assert.deepEqual(persisted.map((row) => row["id"]), itemIds);
    assert.deepEqual(persisted.map((row) => row["position"]), [1, 2]);
  });
});

test("PostgreSQL cycles: a cancelled prior item does not block an unconfirmed re-add", testOptions, async () => {
  await withFixture(1, async ([client], fixture) => {
    const cycleId = `${fixture.prefix}-cancelled-readd`;
    await createCycleRow(client!, fixture, cycleId);
    const cancelled = itemRecord(fixture, cycleId, `${cycleId}-cancelled`, { status: "cancelled" });
    await createItemRow(client!, fixture, cancelled);
    const addedId = `${fixture.prefix}-cancelled-readd-new`;
    fixture.candidateItemIds.add(addedId);
    const result = await mixIntoCycle(context(client!, fixture, fixture.ownerId, undefined, [addedId]), {
      cycleId, videos: [{ mediaAssetId: fixture.mediaId, collectionId: fixture.collectionId, isImportedCopy: false }],
    });
    assert.equal(result.added, 1);
    const persisted = await client!.cycleItem.findMany({ where: { cycleId, mediaAssetId: fixture.mediaId } });
    for (const row of persisted) fixture.itemIds.add(String(row["id"]));
    assert.deepEqual(persisted.map((row) => row["status"]).sort(), ["cancelled", "upcoming"]);
  });
});
