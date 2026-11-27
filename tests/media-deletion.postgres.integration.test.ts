// PostgreSQL integration coverage for permanent media deletion and cover-reference races.
// Uses only synthetic rows, the exact isolated local target, and no workers or external services.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import type { CycleItem } from "../src/lib/domain/types.ts";

const HOST = "127.0.0.1";
const PORT = "54836";
const DATABASE = "clipforge_local_test";
const ROLE = "clipforge_test_admin";
const NOW = new Date("2026-11-28T12:00:00.000Z");
const MIGRATIONS = readdirSync(new URL("../prisma/migrations/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(entry.name))
  .map((entry) => entry.name).sort();

type TestClient = PrismaClientLike & { $disconnect(): Promise<void> };
type Fixture = {
  prefix: string; ownerId: string; accountId: string; coverMediaId: string; sourceMediaId: string;
  userIds: Set<string>; accountIds: Set<string>; mediaIds: Set<string>; collectionIds: Set<string>;
  collectionItemIds: Set<string>; cycleIds: Set<string>; cycleItemIds: Set<string>; cleanupJobIds: Set<string>; auditIds: Set<string>;
};

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct || database !== direct) throw new Error("Both test database URLs must exist and match exactly.");
  if (process.env["NODE_ENV"] !== "test" || process.env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test" || process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== PORT) {
    throw new Error("Required isolated PostgreSQL test flags are missing or invalid.");
  }
  let parsed: URL;
  try { parsed = new URL(database); } catch { throw new Error("Database URL is not a valid isolated PostgreSQL target."); }
  if (parsed.protocol !== "postgresql:" || parsed.hostname !== HOST || parsed.port !== PORT || parsed.pathname !== `/${DATABASE}` || parsed.username !== ROLE || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Database URL is not the approved isolated PostgreSQL test target.");
  }
  if (isolatedDatabaseUrl() !== database) throw new Error("Database URL failed the shared isolated-database guard.");
  return database;
}

const databaseUrl = resolveDatabaseUrl();
const skipOptions = { skip: databaseUrl ? false : "Isolated PostgreSQL test URLs are not configured." };

function newFixture(): Fixture {
  const prefix = `media_delete_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return { prefix, ownerId: `${prefix}_owner`, accountId: `${prefix}_account`, coverMediaId: `${prefix}_cover`, sourceMediaId: `${prefix}_source`,
    userIds: new Set(), accountIds: new Set(), mediaIds: new Set(), collectionIds: new Set(), collectionItemIds: new Set(), cycleIds: new Set(), cycleItemIds: new Set(), cleanupJobIds: new Set(), auditIds: new Set() };
}

async function assertIdentityAndMigrations(db: TestClient): Promise<void> {
  const identity = await db.$queryRaw`SELECT current_database() AS "databaseName", inet_server_addr()::text AS "serverAddress", current_setting('port') AS "serverPort", current_user AS "currentRole", version() AS "serverVersion"` as Array<Record<string, unknown>>;
  assert.equal(identity.length, 1);
  assert.equal(identity[0]?.["databaseName"], DATABASE);
  assert.ok([HOST, `${HOST}/32`].includes(String(identity[0]?.["serverAddress"])));
  assert.equal(String(identity[0]?.["serverPort"]), PORT);
  assert.equal(identity[0]?.["currentRole"], ROLE);
  assert.match(String(identity[0]?.["serverVersion"]), /^PostgreSQL 15\.8\b/);
  const rows = await db.$queryRaw`SELECT "migration_name" AS "name", "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt", "logs" AS "logs" FROM public."_prisma_migrations" ORDER BY "migration_name"` as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row["name"]), MIGRATIONS, "database migration history must match every current migration directory");
  assert.ok(rows.every((row) => row["finishedAt"] instanceof Date && row["rolledBackAt"] === null && row["logs"] === null), "every migration must have completed without rollback or failure logs");
}

async function createFixture(db: TestClient, fixture: Fixture): Promise<void> {
  await db.user.create({ data: { id: fixture.ownerId, email: `${fixture.prefix}@example.invalid`, role: "user" } });
  fixture.userIds.add(fixture.ownerId);
  await db.socialAccount.create({ data: { id: fixture.accountId, userId: fixture.ownerId, platform: "instagram", externalAccountId: `${fixture.prefix}_external`, status: "connected" } });
  fixture.accountIds.add(fixture.accountId);
  for (const [id, filename] of [[fixture.coverMediaId, "cover.png"], [fixture.sourceMediaId, "source.png"]] as const) {
    await db.mediaAsset.create({ data: { id, ownerId: fixture.ownerId, kind: "image", status: "active", originalFilename: filename, mimeType: "image/png", storageKey: `private/${fixture.prefix}/${id}`, sizeBytes: 32n, metadataValidated: true } });
    fixture.mediaIds.add(id);
  }
}

async function cleanupFixture(db: TestClient, fixture: Fixture): Promise<void> {
  if (fixture.auditIds.size) await db.auditLog.deleteMany({ where: { id: { in: [...fixture.auditIds] } } });
  if (fixture.cleanupJobIds.size) await db.processingJob.deleteMany({ where: { id: { in: [...fixture.cleanupJobIds] }, ownerId: fixture.ownerId, kind: "cleanup" } });
  if (fixture.cycleItemIds.size) await db.cycleItem.deleteMany({ where: { id: { in: [...fixture.cycleItemIds] } } });
  if (fixture.cycleIds.size) await db.publishingCycle.deleteMany({ where: { id: { in: [...fixture.cycleIds] }, ownerId: fixture.ownerId } });
  if (fixture.collectionItemIds.size) await db.collectionItem.deleteMany({ where: { id: { in: [...fixture.collectionItemIds] } } });
  if (fixture.collectionIds.size) await db.videoCollection.deleteMany({ where: { id: { in: [...fixture.collectionIds] }, ownerId: fixture.ownerId } });
  if (fixture.mediaIds.size) await db.mediaAsset.deleteMany({ where: { id: { in: [...fixture.mediaIds] }, ownerId: fixture.ownerId } });
  if (fixture.accountIds.size) await db.socialAccount.deleteMany({ where: { id: { in: [...fixture.accountIds] }, userId: fixture.ownerId } });
  if (fixture.userIds.size) await db.user.deleteMany({ where: { id: { in: [...fixture.userIds] } } });
}

async function withFixture(clientCount: number, work: (clients: TestClient[], fixture: Fixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl, "isolated local PostgreSQL target is required");
  const clients: TestClient[] = [];
  const fixture = newFixture();
  try {
    for (let i = 0; i < clientCount; i += 1) clients.push(await createPrismaClient(databaseUrl) as TestClient);
    for (const client of clients) await assertIdentityAndMigrations(client);
    await createFixture(clients[0]!, fixture);
    await work(clients, fixture);
  } finally {
    try { if (clients[0]) await cleanupFixture(clients[0], fixture); }
    finally { await Promise.allSettled(clients.map((client) => client.$disconnect())); }
  }
}

async function createCollection(db: TestClient, fixture: Fixture, options: { archived: boolean; sharedCoverMediaId: string | null; withItemCover?: boolean }): Promise<string> {
  const id = `${fixture.prefix}_collection_${randomUUID().slice(0, 8)}`;
  await db.videoCollection.create({ data: { id, ownerId: fixture.ownerId, name: "Synthetic cover collection", visibility: "private", archived: options.archived, sharedCoverMediaId: options.sharedCoverMediaId, settingsVersion: 1 } });
  fixture.collectionIds.add(id);
  if (options.withItemCover) {
    const itemId = `${fixture.prefix}_collection_item_${randomUUID().slice(0, 8)}`;
    await db.collectionItem.create({ data: { id: itemId, collectionId: id, mediaAssetId: fixture.sourceMediaId, position: 0, captionText: "synthetic", coverMediaId: fixture.coverMediaId } });
    fixture.collectionItemIds.add(itemId);
  }
  return id;
}

async function createCycle(db: TestClient, fixture: Fixture, options: { status: "draft" | "running" | "stopped"; deletedAt: Date | null; coverMediaId: string | null; published?: boolean }): Promise<{ cycleId: string; itemId: string }> {
  const cycleId = `${fixture.prefix}_cycle_${randomUUID().slice(0, 8)}`;
  await db.publishingCycle.create({ data: { id: cycleId, ownerId: fixture.ownerId, socialAccountId: fixture.accountId, name: "Synthetic publishing cycle", status: options.status, finalReviewConfirmed: true, orderMode: "manual", repeatBehavior: "never", timezone: "UTC", scheduleSettings: {}, deletedAt: options.deletedAt } });
  fixture.cycleIds.add(cycleId);
  const itemId = `${fixture.prefix}_cycle_item_${randomUUID().slice(0, 8)}`;
  await db.cycleItem.create({ data: { id: itemId, cycleId, cycleOwnerId: fixture.ownerId, mediaAssetId: fixture.sourceMediaId, sourceKind: "owned", position: 0, status: options.published ? "published" : "upcoming", coverMediaId: options.coverMediaId, coverIsCustom: options.coverMediaId !== null, coverState: options.coverMediaId ? "saved_internally" : "none", ...(options.published ? { externalPostId: `${fixture.prefix}_post`, publishedAt: NOW } : {}) } });
  fixture.cycleItemIds.add(itemId);
  return { cycleId, itemId };
}

function barrier(parties: number): () => Promise<void> {
  let arrived = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return async () => { arrived += 1; if (arrived === parties) release(); await gate; };
}

test("PostgreSQL media deletion: archived collection and soft-deleted cycle covers are cleaned or retained safely", skipOptions, async () => withFixture(1, async ([client], fixture) => {
  const collectionId = await createCollection(client!, fixture, { archived: true, sharedCoverMediaId: fixture.coverMediaId, withItemCover: true });
  const { cycleId, itemId } = await createCycle(client!, fixture, { status: "stopped", deletedAt: NOW, coverMediaId: fixture.coverMediaId, published: true });
  const result = await new PrismaRepository(client!, () => NOW).requestPermanentMediaDeletion({ id: `${fixture.prefix}_cleanup`, mediaId: fixture.coverMediaId, ownerId: fixture.ownerId, expectedCollectionIds: [], now: NOW });
  assert.equal(result.status, "queued");
  if (result.status !== "queued") return;
  fixture.cleanupJobIds.add(result.job.id);
  const audits = await client!.auditLog.findMany({ where: { actorId: fixture.ownerId, action: "media.permanent_deletion_queued", entityType: "MediaAsset", entityId: fixture.coverMediaId }, select: { id: true } });
  for (const audit of audits) fixture.auditIds.add(String(audit["id"]));
  const archived = await client!.videoCollection.findUnique({ where: { id: collectionId } });
  const collectionItem = await client!.collectionItem.findFirst({ where: { collectionId, mediaAssetId: fixture.sourceMediaId } });
  const history = await client!.cycleItem.findUnique({ where: { id: itemId } });
  assert.equal(archived?.["sharedCoverMediaId"], null);
  assert.equal(collectionItem?.["coverMediaId"], null);
  assert.equal(collectionItem?.["captionText"], "synthetic");
  assert.equal(history?.["coverMediaId"], fixture.coverMediaId, "soft-deleted publishing history is preserved");
  assert.equal(history?.["externalPostId"], `${fixture.prefix}_post`);
  assert.equal(await new PrismaRepository(client!, () => NOW).canCleanupMediaAsset(fixture.coverMediaId), true);
  assert.ok(fixture.cycleIds.has(cycleId));
}));

test("PostgreSQL media deletion: active collection and cycle covers remain blockers with exact resource names", skipOptions, async () => withFixture(1, async ([client], fixture) => {
  const collectionId = await createCollection(client!, fixture, { archived: false, sharedCoverMediaId: fixture.coverMediaId });
  const { cycleId } = await createCycle(client!, fixture, { status: "running", deletedAt: null, coverMediaId: fixture.coverMediaId });
  const result = await new PrismaRepository(client!, () => NOW).requestPermanentMediaDeletion({ id: `${fixture.prefix}_cleanup`, mediaId: fixture.coverMediaId, ownerId: fixture.ownerId, expectedCollectionIds: [], now: NOW });
  assert.equal(result.status, "cover_in_use");
  if (result.status !== "cover_in_use") return;
  assert.deepEqual(result.dependencies.map(({ type, id, name }) => ({ type, id, name })), [
    { type: "collection", id: collectionId, name: "Synthetic cover collection" },
    { type: "cycle", id: cycleId, name: "Synthetic publishing cycle" },
  ]);
  assert.equal((await client!.mediaAsset.findUnique({ where: { id: fixture.coverMediaId } }))?.["status"], "active");
  assert.equal(await client!.processingJob.count({ where: { ownerId: fixture.ownerId, kind: "cleanup", mediaAssetId: fixture.coverMediaId } }), 0);
}));

test("PostgreSQL media deletion: independent clients serialize shared-cover assignment against deletion", skipOptions, async () => withFixture(2, async ([deleteClient, assignClient], fixture) => {
  const collectionId = await createCollection(deleteClient!, fixture, { archived: false, sharedCoverMediaId: null });
  const gate = barrier(2);
  const deletion = async () => { await gate(); return new PrismaRepository(deleteClient!, () => NOW).requestPermanentMediaDeletion({ id: `${fixture.prefix}_cleanup`, mediaId: fixture.coverMediaId, ownerId: fixture.ownerId, expectedCollectionIds: [], now: NOW }); };
  const assignment = async () => { await gate(); return new PrismaRepository(assignClient!, () => NOW).saveCollectionSharedSettings({ collectionId, ownerId: fixture.ownerId, actorId: fixture.ownerId, affected: 0, expectedVersion: 1, coverMode: "shared", sharedCoverMediaId: fixture.coverMediaId }); };
  const [deleted, assigned] = await Promise.all([deletion(), assignment()]);
  const persisted = await deleteClient!.videoCollection.findUnique({ where: { id: collectionId }, select: { sharedCoverMediaId: true } });
  const media = await deleteClient!.mediaAsset.findUnique({ where: { id: fixture.coverMediaId }, select: { status: true } });
  if (deleted.status === "queued") {
    fixture.cleanupJobIds.add(deleted.job.id);
    const audits = await deleteClient!.auditLog.findMany({ where: { actorId: fixture.ownerId, action: "media.permanent_deletion_queued", entityType: "MediaAsset", entityId: fixture.coverMediaId }, select: { id: true } });
    for (const audit of audits) fixture.auditIds.add(String(audit["id"]));
    assert.equal(assigned, false);
    assert.equal(persisted?.["sharedCoverMediaId"], null);
    assert.equal(media?.["status"], "deleted");
  } else {
    assert.equal(deleted.status, "cover_in_use");
    assert.equal(assigned, true);
    assert.equal(persisted?.["sharedCoverMediaId"], fixture.coverMediaId);
    assert.equal(media?.["status"], "active");
  }
}));

test("PostgreSQL media deletion: independent clients serialize cycle-cover assignment against deletion", skipOptions, async () => withFixture(2, async ([deleteClient, assignClient], fixture) => {
  const { cycleId, itemId } = await createCycle(deleteClient!, fixture, { status: "draft", deletedAt: null, coverMediaId: null });
  const gate = barrier(2);
  const deletion = async () => { await gate(); return new PrismaRepository(deleteClient!, () => NOW).requestPermanentMediaDeletion({ id: `${fixture.prefix}_cleanup`, mediaId: fixture.coverMediaId, ownerId: fixture.ownerId, expectedCollectionIds: [], now: NOW }); };
  const assignment = async () => {
    await gate();
    const item: CycleItem = { id: itemId, cycleId, cycleOwnerId: fixture.ownerId, mediaAssetId: fixture.sourceMediaId, selectedRenderOutputId: null, sourceKind: "owned", sourceCollectionId: null, status: "upcoming", position: 0, version: 2, scheduledFor: null, captionText: "", captionSource: "none", coverMediaId: fixture.coverMediaId, coverIsCustom: true, coverState: "saved_internally", lockedBy: null, lockExpiresAt: null, reviewReason: null, externalPostId: null, publishedAt: null };
    return new PrismaRepository(assignClient!, () => NOW).saveCycleItemsIfVersionMatches([{ item, expectedVersion: 1 }]);
  };
  const [deleted, assignments] = await Promise.all([deletion(), assignment()]);
  const persistedItem = await deleteClient!.cycleItem.findUnique({ where: { id: itemId }, select: { coverMediaId: true } });
  const media = await deleteClient!.mediaAsset.findUnique({ where: { id: fixture.coverMediaId }, select: { status: true } });
  if (deleted.status === "queued") {
    fixture.cleanupJobIds.add(deleted.job.id);
    const audits = await deleteClient!.auditLog.findMany({ where: { actorId: fixture.ownerId, action: "media.permanent_deletion_queued", entityType: "MediaAsset", entityId: fixture.coverMediaId }, select: { id: true } });
    for (const audit of audits) fixture.auditIds.add(String(audit["id"]));
    assert.deepEqual(assignments, [{ itemId, saved: false }]);
    assert.equal(persistedItem?.["coverMediaId"], null);
    assert.equal(media?.["status"], "deleted");
  } else {
    assert.equal(deleted.status, "cover_in_use");
    assert.deepEqual(assignments, [{ itemId, saved: true }]);
    assert.equal(persistedItem?.["coverMediaId"], fixture.coverMediaId);
    assert.equal(media?.["status"], "active");
  }
}));
