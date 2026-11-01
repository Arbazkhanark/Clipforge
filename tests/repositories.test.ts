import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import { cycleToRow, grantToRow, itemToMutableData, itemToRow, mediaToRow, rowToCollection, rowToGrant, rowToItem, rowToMedia } from "../src/server/prisma/mappers.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { runRepositoryContract, type RepoHarness } from "./contracts/repository.contract.ts";
import { runAuthRepositoryContract } from "./contracts/auth-repository.contract.ts";
import { DEFAULT_EDITING_SETTINGS } from "../src/lib/domain/editing-settings.ts";
import { makeItem, makeMedia } from "./helpers.ts";

function memoryHarness(): RepoHarness {
  const repo = new MemoryRepository();
  return {
    repo,
    seedPlan: async (u, p) => { repo.plans.set(u, p); },
    seedMedia: async (m, keys) => { repo.media.set(m.id, structuredClone(m)); if (keys) { repo.storageKeys.set(m.id, keys.storageKey); repo.thumbnailKeys.set(m.id, keys.thumbnailKey); } },
    seedCollection: async (c) => { repo.collections.set(c.id, structuredClone(c)); },
    seedGrant: async (g) => { repo.grants.push(structuredClone(g)); },
    seedSocialAccount: async (a) => { repo.socialAccounts.set(a.id, a); },
    seedCycle: async (c) => { repo.cycles.set(c.id, c); },
    seedItems: async (items) => { items.forEach((i) => repo.items.set(i.id, structuredClone(i))); },
    seedUsage: async (u, m, usage) => { repo.setUsage(u, m, usage); },
    auditActions: async () => repo.audit.map((a) => a.action), revisionCount: async () => repo.captionRevisions.length,
  };
}

function prismaHarness(): RepoHarness {
  const client = new FakePrismaClient(); let n = 0;
  const repo = new PrismaRepository(client, () => new Date("2026-06-01T12:00:00Z"));
  return {
    repo,
    seedPlan: async (userId, planId) => { await client.subscription.create({ data: { userId, planId, interval: "monthly", status: "active", lastEventAt: 0n, trialEndsAt: null } }); },
    seedMedia: async (m, keys) => { await client.mediaAsset.create({ data: mediaToRow(m, keys ?? { storageKey: `k/${m.id}`, thumbnailKey: null }) }); },
    seedCollection: async (c) => {
      await client.videoCollection.create({ data: { id: c.id, ownerId: c.ownerId, name: c.name ?? c.id, description: c.description ?? null, visibility: c.visibility, archived: c.archived } });
      for (const [position, mediaAssetId] of c.mediaIds.entries()) await client.collectionItem.create({ data: { collectionId: c.id, mediaAssetId, position } });
    },
    seedGrant: async (g) => { await client.collectionPermission.create({ data: grantToRow(g) }); },
    seedSocialAccount: async (a) => { await client.socialAccount.create({ data: { id: a.id, userId: a.userId, status: a.status, platform: "instagram", externalAccountId: a.id } }); },
    seedCycle: async (c) => { await client.publishingCycle.create({ data: cycleToRow(c) }); },
    seedItems: async (items) => { await client.cycleItem.createMany({ data: items.map(itemToRow) }); },
    seedUsage: async (userId, periodStart, u) => {
      for (const [kind, amount] of [["processing_seconds", u.processingSeconds], ["exports", u.exports], ["scheduled_items", u.scheduledItems]] as const) await client.usageRecord.create({ data: { userId, kind, amount: BigInt(amount), periodStart, idempotencyKey: `seed${++n}` } });
    },
    auditActions: async () => (await client.auditLog.findMany()).map((r) => r["action"]), revisionCount: async () => client.captionRevision.count(),
  };
}

runRepositoryContract("MemoryRepository", memoryHarness);
runRepositoryContract("PrismaRepository over FAKE client", prismaHarness);
runAuthRepositoryContract("PrismaAuthRepository over FAKE client", () => new PrismaAuthRepository(new FakePrismaClient()));

// ---------- behaviours specific to the Prisma implementation ----------
test("subscription entitlement is computed from the stored state: trial counts only until it ends; halted/cancelled fall back to free", async () => {
  const client = new FakePrismaClient(); const T = Math.floor(new Date("2026-06-01T12:00:00Z").getTime() / 1000);
  const repo = new PrismaRepository(client, () => new Date("2026-06-01T12:00:00Z"));
  const sub = (userId: string, status: string, trialEndsAt: number | null) => client.subscription.create({ data: { userId, planId: "pro", interval: "weekly", status, lastEventAt: 0n, trialEndsAt: trialEndsAt === null ? null : BigInt(trialEndsAt) } });
  await sub("trial", "authenticated", T + 100); await sub("trialOver", "authenticated", T - 1); await sub("active", "active", null); await sub("pending", "pending", null);
  await sub("halted", "halted", null); await sub("cancelled", "cancelled", null); await sub("created", "created", T + 100);
  const plans = Object.fromEntries(await Promise.all(["trial", "trialOver", "active", "pending", "halted", "cancelled", "created", "none"].map(async (u) => [u, await repo.getPlanIdForUser(u)])));
  assert.deepEqual(plans, { trial: "pro", trialOver: "free", active: "pro", pending: "pro", halted: "free", cancelled: "free", created: "free", none: "free" });
});

test("the quota insert takes a lock inside ONE transaction before it counts (so concurrent uploads are serialised)", async () => {
  const client = new FakePrismaClient(); const calls: string[] = [];
  const wrapped = Object.create(client) as FakePrismaClient;
  wrapped.$transaction = async (work) => { calls.push("begin"); const r = await client.$transaction(async (tx) => work(Object.assign(Object.create(tx), { $queryRaw: async (s: TemplateStringsArray) => { calls.push(`lock:${s.join("?").includes("FOR UPDATE")}`); return []; } }))); calls.push("end"); return r; };
  const repo = new PrismaRepository(wrapped);
  assert.equal(await repo.addMediaIfStorageWithin(makeMedia({ id: "m1", ownerId: "bob", sizeBytes: 10 }), { storageKey: "k", thumbnailKey: null }, 100), true);
  assert.deepEqual(calls, ["begin", "lock:true", "end"]);
});

test("the template-limit insert also takes the user-row lock inside ONE transaction before it counts", async () => {
  const client = new FakePrismaClient(); const calls: string[] = [];
  const wrapped = Object.create(client) as FakePrismaClient;
  wrapped.$transaction = async (work) => { calls.push("begin"); const r = await client.$transaction(async (tx) => work(Object.assign(Object.create(tx), { $queryRaw: async (s: TemplateStringsArray) => { calls.push(`lock:${s.join("?").includes("FOR UPDATE")}`); return []; } }))); calls.push("end"); return r; };
  const repo = new PrismaRepository(wrapped);
  assert.equal(await repo.createTemplateIfWithinLimit({ id: "t1", ownerId: "bob", name: "N", settings: DEFAULT_EDITING_SETTINGS, createdAt: new Date() }, 3), true);
  assert.deepEqual(calls, ["begin", "lock:true", "end"]);
});

test("every version-checked save is a single conditional UPDATE keyed by id AND version (never a read-then-write)", async () => {
  const client = new FakePrismaClient(); const seen: unknown[] = [];
  const original = client.cycleItem.updateMany.bind(client.cycleItem);
  client.cycleItem.updateMany = async (args) => { seen.push(args.where); return original(args); };
  client.cycleItem.update = async () => { throw new Error("must not use plain update for versioned saves"); };
  const repo = new PrismaRepository(client); await client.cycleItem.create({ data: itemToRow(makeItem({ id: "i1", version: 4 })) });
  await repo.saveCycleItemsIfVersionMatches([{ item: makeItem({ id: "i1", version: 5, captionText: "x" }), expectedVersion: 4 }]);
  assert.deepEqual(seen, [{ id: "i1", version: 4 }]);
});

test("mappers: media, grants, collections and items round-trip; bigint sizes become numbers; missing display fields get safe defaults", () => {
  const m = makeMedia({ id: "m", ownerId: "o", sizeBytes: 5_000_000_000, title: "T", kind: "image", validation: "verified", width: 3, height: 4 });
  const row = mediaToRow(m, { storageKey: "k", thumbnailKey: "t" });
  assert.equal(typeof row["sizeBytes"], "bigint");
  const back = rowToMedia(row); assert.deepEqual([back.sizeBytes, back.title, back.kind, back.validation, back.hasThumbnail, back.width], [5_000_000_000, "T", "image", "verified", true, 3]);
  assert.equal(rowToMedia(mediaToRow(makeMedia({ id: "x" }), { storageKey: "k", thumbnailKey: null })).validation, "incomplete");   // unknown never becomes "verified"
  assert.equal(mediaToRow(makeMedia({ id: "x" }), { storageKey: "k", thumbnailKey: null })["mimeType"], "application/octet-stream");
  const g = { collectionId: "c", granteeId: "u", capabilities: ["view" as const], status: "revoked" as const, expiresAt: null };
  assert.deepEqual(rowToGrant(grantToRow(g)), g);
  assert.deepEqual(rowToCollection({ id: "c", ownerId: "o", visibility: "link", archived: false, name: "N", description: null }, ["a"]), { id: "c", ownerId: "o", visibility: "link", archived: false, mediaIds: ["a"], name: "N" });
  const i = makeItem({ id: "i", captionText: "hi", coverState: "saved_internally", coverMediaId: "c" }); assert.deepEqual(rowToItem(itemToRow(i)), i);
  assert.ok(!("id" in itemToMutableData(i)) && !("cycleId" in itemToMutableData(i)) && !("cycleOwnerId" in itemToMutableData(i)));
});

test("a UNIQUE violation is reported as 'email taken', but unrelated database errors are NOT swallowed", async () => {
  const client = new FakePrismaClient(); const repo = new PrismaAuthRepository(client);
  const u = { id: "u1", email: "a@example.com", emailVerifiedAt: null, passwordHash: "h", name: null, role: "user" as const, createdAt: new Date() };
  assert.equal(await repo.createUser(u), true); assert.equal(await repo.createUser({ ...u, id: "u2" }), false);
  client.user.create = async () => { throw new Error("connection lost"); };
  await assert.rejects(() => repo.createUser({ ...u, id: "u3", email: "z@example.com" }), /connection lost/);
});
