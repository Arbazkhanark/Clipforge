// Database-mode collections, media metadata, and cycles. Persistence cases run only for the isolated local database.
// A refused database is reported and is not replaced with the in-memory repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppError } from "../src/server/errors.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { createDatabaseRuntime } from "../src/server/runtime.ts";
import { getCollectionDetail, getCycleDetail, getMediaDetail } from "../src/server/queries.ts";
import type { RequestContext } from "../src/server/context.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { makeItem, makeMedia } from "./helpers.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const databaseUrlAtStart = isolatedDatabaseUrl();
const hasDatabase = Boolean(databaseUrlAtStart);

test("a database content failure is reported and does not fall back to memory", async () => {
  const runtime = createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => { throw new Error("connection refused"); });
  const memory = new MemoryRepository();
  await assert.rejects(() => runtime.repo.listCollectionsForOwner("ann"), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
  await assert.rejects(() => runtime.repo.createCycle({ id: "c", ownerId: "ann", status: "draft", finalReviewConfirmed: false, name: "C", socialAccountId: "a" }), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
  assert.deepEqual(await memory.listCollectionsForOwner("ann"), []);
  assert.deepEqual(await memory.listCyclesForOwner("ann"), []);
});

test("database mode writes collections through the database client, not a memory repository", async () => {
  const client = new FakePrismaClient();
  const runtime = createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => client);
  await client.user.create({ data: { id: "ann", email: "ann@example.test" } });
  await client.mediaAsset.create({ data: { id: "m1", ownerId: "ann", storageKey: "ref/m1", sizeBytes: 10n, status: "active" } });
  assert.equal(await runtime.repo.createCollection({ id: "c1", ownerId: "ann", visibility: "private", archived: false, mediaIds: ["m1"], name: "Saved" }), true);
  assert.equal((await new MemoryRepository().getCollection("c1")), null);
  assert.equal((await runtime.repo.getCollection("c1"))?.name, "Saved");
  client.videoCollection.create = async () => { throw new Error("database went away"); };
  await assert.rejects(() => runtime.repo.createCollection({ id: "c2", ownerId: "ann", visibility: "private", archived: false, mediaIds: [], name: "Nope" }), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
  assert.equal(await client.videoCollection.findUnique({ where: { id: "c2" } }), null);
});

test("Neon keeps collections, media metadata, and cycles after a new database connection", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => {
  const stamp = randomUUID();
  const ownerId = `phase2a-${stamp}`;
  const otherId = `phase2a-other-${stamp}`;
  const mediaId = `media-${stamp}`;
  const collectionId = `collection-${stamp}`;
  const cycleId = `cycle-${stamp}`;
  const accountId = `account-${stamp}`;
  const storageKey = `local-ref/${stamp}`;
  const db = await createPrismaClient(databaseUrlAtStart as string);
  const closer = db as PrismaClientLike & { $disconnect(): Promise<void> };
  const remove = async (client: PrismaClientLike): Promise<void> => {
    await client.publishingCycle.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await client.videoCollection.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await client.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
    await client.auditLog.deleteMany({ where: { actorId: { in: [ownerId, otherId] } } });
    await client.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  };
  try {
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@clipforge.test`, passwordHash: "scrypt$not-a-password", role: "user" } });
    await db.user.create({ data: { id: otherId, email: `${otherId}@clipforge.test`, passwordHash: "scrypt$not-a-password", role: "user" } });
    await db.socialAccount.create({ data: { id: accountId, userId: ownerId, platform: "instagram", externalAccountId: stamp, status: "connected" } });
    const first = new PrismaRepository(db);
    const media = makeMedia({ id: mediaId, ownerId, title: "Persisted clip", sizeBytes: 32, kind: "video", mimeType: "video/mp4" });
    assert.equal(await first.addMediaIfStorageWithin(media, { storageKey, thumbnailKey: null }, 1_000_000), true);
    assert.equal(await first.addMediaIfStorageWithin(media, { storageKey: `${storageKey}-over`, thumbnailKey: null }, 40), false);
    const stored = await first.getMediaStorageInfo(mediaId);
    assert.equal(stored?.storageKey, storageKey);
    assert.equal(stored?.storageKey.includes("Persisted"), false);
    assert.equal(await first.createCollection({ id: collectionId, ownerId, name: "Persisted collection", description: "Kept", visibility: "private", archived: false, mediaIds: [mediaId] }), true);
    assert.equal(await first.createCollection({ id: collectionId, ownerId, name: "Again", visibility: "private", archived: false, mediaIds: [] }), false);
    await first.createCycle({ id: cycleId, ownerId, name: "Persisted cycle", status: "draft", finalReviewConfirmed: false, socialAccountId: accountId });
    assert.equal(await first.addCycleItems([makeItem({ id: `item-${stamp}`, cycleId, cycleOwnerId: ownerId, mediaAssetId: mediaId, sourceKind: "owned", sourceCollectionId: collectionId, position: 1 })], { [collectionId]: 1 }), true);
    await first.appendAudit({ actorId: ownerId, action: "cycle.created", entityType: "PublishingCycle", entityId: cycleId });
    await closer.$disconnect();

    const restarted = await createPrismaClient(databaseUrlAtStart as string);
    const restartedCloser = restarted as PrismaClientLike & { $disconnect(): Promise<void> };
    try {
      const second = new PrismaRepository(restarted);
      const collection = await second.getCollection(collectionId);
      assert.equal(collection?.name, "Persisted collection");
      assert.deepEqual(collection?.mediaIds, [mediaId]);
      const loaded = await second.getMedia(mediaId);
      assert.equal(loaded?.title, "Persisted clip");
      assert.equal(loaded?.sizeBytes, 32);
      assert.equal(Object.hasOwn(loaded ?? {}, "storageKey"), false);
      assert.deepEqual((await second.listCollectionsForOwner(otherId)).map((c) => c.id), []);
      assert.deepEqual((await second.listMediaForOwner(otherId, { limit: 20, offset: 0 })).items, []);
      assert.equal((await second.listCyclesForOwner(ownerId))[0]?.name, "Persisted cycle");
      assert.equal((await second.getCycleItems(cycleId))[0]?.position, 1);
      assert.equal(await second.getCollection("missing-collection"), null);
      assert.equal(await second.getMedia("missing-media"), null);
      assert.equal(await second.getCycle("missing-cycle"), null);
      assert.equal(await second.replaceCollectionMedia(collectionId, [mediaId, mediaId]), false);
      assert.deepEqual((await second.getCollection(collectionId))?.mediaIds, [mediaId]);
      const asOther = (userId: string): RequestContext => ({ userId, now: new Date(), repo: second, newId: () => "unused", config: { coverSupport: "unknown" } });
      await assert.rejects(() => getCollectionDetail(asOther(otherId), collectionId), (error: unknown) => error instanceof AppError && error.status === 404);
      await assert.rejects(() => getMediaDetail(asOther(otherId), mediaId), (error: unknown) => error instanceof AppError && error.status === 404);
      await assert.rejects(() => getCycleDetail(asOther(otherId), cycleId), (error: unknown) => error instanceof AppError && error.status === 404);
      assert.equal((await getCollectionDetail(asOther(ownerId), collectionId)).collection.name, "Persisted collection");
    } finally {
      await remove(restarted);
      await restartedCloser.$disconnect();
    }
  } finally {
    try { await remove(db); } catch { /* the restarted connection already removed the rows */ }
    try { await closer.$disconnect(); } catch { /* already disconnected before the restart */ }
  }
});
