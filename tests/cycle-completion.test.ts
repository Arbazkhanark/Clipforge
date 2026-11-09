import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { cycleToRow, itemToRow } from "../src/server/prisma/mappers.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { makeCycle, makeItem, NOW } from "./helpers.ts";
import type { CycleRecord } from "../src/server/repository.ts";
import type { CycleItem } from "../src/lib/domain/types.ts";

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  ...makeCycle(), name: "Campaign", socialAccountId: "account-1", repeatBehavior: "never",
  scheduleSettings: { timeZone: "Asia/Kolkata", startDate: "2026-06-01", intervalMinutes: 60, postsPerInterval: 1, daysOfWeek: [1, 2, 3, 4, 5, 6, 7], windowStart: "09:00", windowEnd: "18:00", dailyMax: null, endDate: null },
  createdAt: NOW, ...over,
});
const item = (id: string, position: number, status: CycleItem["status"]): CycleItem => makeItem({ id, position, status, scheduledFor: status === "scheduled" ? NOW : null });

async function seedMemory(overrides: { cycle?: Partial<CycleRecord>; items?: CycleItem[] } = {}) {
  const repo = new MemoryRepository();
  await repo.createCycle(cycle(overrides.cycle));
  for (const value of overrides.items ?? [item("one", 1, "published"), item("two", 2, "failed"), item("three", 3, "cancelled")]) repo.items.set(value.id, structuredClone(value));
  return repo;
}

async function seedPrisma(overrides: { cycle?: Partial<CycleRecord>; items?: CycleItem[] } = {}) {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "bob", email: "bob@example.test" } });
  const repo = new PrismaRepository(db, () => NOW);
  const source = cycle(overrides.cycle);
  await repo.createCycle(source);
  await repo.addCycleItems(overrides.items ?? [item("one", 1, "published"), item("two", 2, "failed"), item("three", 3, "cancelled")]);
  return { repo, db };
}

test("all terminal cycle items complete the cycle once and create one audit event", async () => {
  const repo = await seedMemory();
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" }), "completed");
  assert.equal(repo.cycles.get("cycle1")?.status, "completed");
  assert.deepEqual(repo.audit.map((event) => event.action), ["cycle.completed"]);
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" }), "already_completed");
  assert.equal(repo.audit.length, 1);
});

test("upcoming, processing, scheduled and manual-review items prevent completion", async () => {
  for (const status of ["upcoming", "scheduled", "processing", "needs_review"] as const) {
    const repo = await seedMemory({ items: [item("pending", 1, status)] });
    assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => "unused" }), "not_ready", status);
    assert.equal(repo.cycles.get("cycle1")?.status, "running");
    assert.equal(repo.audit.length, 0);
  }
});

test("concurrent memory completion is serialized and cannot duplicate completion or a repeat round", async () => {
  const repo = await seedMemory({ cycle: { repeatBehavior: "automatic" }, items: [item("published", 1, "published"), item("failed", 2, "failed")] });
  let id = 0;
  const complete = () => repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => `new-${++id}` });
  const results = await Promise.all([complete(), complete()]);
  assert.equal(results.filter((result) => result === "repeat_queued").length, 1);
  assert.equal(results.filter((result) => result === "already_completed").length, 1);
  assert.equal([...repo.cycles.values()].filter((entry) => entry.ownerId === "bob" && entry.status === "draft").length, 1);
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.completed").length, 1);
  assert.equal(repo.audit.filter((entry) => entry.action === "cycle.repeat_queued").length, 1);
});

test("automatic repeat queues only unpublished eligible items as an unscheduled draft, preserving order and settings", async () => {
  const sourceItems = [item("published", 1, "published"), item("failed-later", 2, "failed"), item("cancelled-last", 3, "cancelled")];
  sourceItems[1]!.captionText = "Retry this caption";
  sourceItems[1]!.selectedRenderOutputId = "render-1";
  const repo = await seedMemory({ cycle: { repeatBehavior: "automatic" }, items: sourceItems });
  let id = 0;
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => `new-${++id}` }), "repeat_queued");
  const repeatedCycle = [...repo.cycles.values()].find((entry) => entry.id !== "cycle1")!;
  assert.equal(repeatedCycle.status, "draft");
  assert.equal(repeatedCycle.finalReviewConfirmed, false);
  assert.equal(repeatedCycle.socialAccountId, "account-1");
  assert.deepEqual(repeatedCycle.scheduleSettings, cycle().scheduleSettings);
  const repeatedItems = [...repo.items.values()].filter((entry) => entry.cycleId === repeatedCycle.id).sort((a, b) => a.position - b.position);
  assert.deepEqual(repeatedItems.map((entry) => [entry.mediaAssetId, entry.position]), [["media1", 2], ["media1", 3]]);
  assert.ok(repeatedItems.every((entry) => entry.status === "upcoming" && entry.scheduledFor === null && entry.externalPostId === null));
  assert.equal(repeatedItems[0]?.captionText, "Retry this caption");
  assert.equal(repeatedItems[0]?.selectedRenderOutputId, "render-1");
  assert.equal(repo.cycles.get("cycle1")?.status, "completed");
});

test("repeat disabled or no eligible unpublished items creates no next round", async () => {
  const disabled = await seedMemory({ items: [item("published", 1, "published")] });
  assert.equal(await disabled.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => "unused" }), "completed");
  assert.equal(disabled.cycles.size, 1);
  const allPublished = await seedMemory({ cycle: { repeatBehavior: "automatic" }, items: [item("published", 1, "published")] });
  assert.equal(await allPublished.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => "unused" }), "completed");
  assert.equal(allPublished.cycles.size, 1);
});

test("repeat respects active-cycle limits and ownership", async () => {
  const repo = await seedMemory({ cycle: { repeatBehavior: "automatic" }, items: [item("failed", 1, "failed")] });
  await repo.createCycle(cycle({ id: "already-active", status: "draft" }));
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" }), "repeat_skipped_limit");
  assert.equal(repo.cycles.size, 2);
  assert.equal(repo.audit.at(-1)?.action, "cycle.repeat_skipped");
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "mallory", now: NOW, activeCycleLimit: 9, newId: () => "unused" }), "not_found");

  const prisma = await seedPrisma({ cycle: { repeatBehavior: "automatic" }, items: [item("failed", 1, "failed")] });
  await prisma.repo.createCycle(cycle({ id: "already-active", status: "draft" }));
  assert.equal(await prisma.repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" }), "repeat_skipped_limit");
  assert.equal((await prisma.repo.getCycle("cycle1"))?.status, "completed");
  assert.equal((await prisma.repo.listCyclesForOwner("bob")).length, 2);
  assert.equal(prisma.db.auditLog.rows.at(-1)?.["action"], "cycle.repeat_skipped");
});

test("fake-Prisma transaction rolls back completion, repeat, items and audit together on audit failure", async () => {
  const { repo, db } = await seedPrisma({ cycle: { repeatBehavior: "automatic" }, items: [item("failed", 1, "failed")] });
  const originalCreate = db.auditLog.create.bind(db.auditLog);
  db.auditLog.create = async (args) => { if (args.data["action"] === "cycle.repeat_queued") throw new Error("injected audit failure"); return originalCreate(args); };
  await assert.rejects(() => repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: (() => { let id = 0; return () => `next-${++id}`; })() }));
  assert.equal((await repo.getCycle("cycle1"))?.status, "running");
  assert.equal((await repo.listCyclesForOwner("bob")).length, 1);
  assert.equal((await repo.getCycleItems("cycle1")).length, 1);
  assert.equal(db.auditLog.rows.length, 0);
});

test("fake-Prisma completion serializes duplicate calls and matches memory repeat behavior", async () => {
  const { repo, db } = await seedPrisma({ cycle: { repeatBehavior: "automatic" }, items: [item("published", 1, "published"), item("failed", 2, "failed")] });
  db.lockLog.length = 0;
  let id = 0;
  const complete = () => repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => `next-${++id}` });
  const results = await Promise.all([complete(), complete()]);
  assert.equal(results.filter((result) => result === "repeat_queued").length, 1);
  assert.equal(results.filter((result) => result === "already_completed").length, 1);
  assert.equal((await repo.listCyclesForOwner("bob")).length, 2);
  assert.deepEqual(db.lockLog, ["user:bob", "cycle:cycle1", "user:bob", "cycle:cycle1"]);
  assert.equal(db.auditLog.rows.filter((entry) => entry["action"] === "cycle.completed").length, 1);
  assert.equal(db.auditLog.rows.filter((entry) => entry["action"] === "cycle.repeat_queued").length, 1);
});

test("fake-Prisma repository maps terminal and pending item states consistently", async () => {
  const { repo, db } = await seedPrisma({ items: [item("pending", 1, "needs_review")] });
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => "unused" }), "not_ready");
  assert.equal((await repo.getCycle("cycle1"))?.status, "running");
  assert.equal(db.auditLog.rows.length, 0);
  const terminal = item("pending", 1, "failed");
  await repo.saveCycleItemsIfVersionMatches([{ item: terminal, expectedVersion: 1 }]);
  assert.equal(await repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 2, newId: () => "unused" }), "completed");
  assert.equal((await repo.getCycle("cycle1"))?.status, "completed");
});

test("cycle item insertion cannot race into a completed cycle in either repository", async () => {
  const memory = await seedMemory();
  await memory.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" });
  assert.equal(await memory.addCycleItems([makeItem({ id: "late", cycleId: "cycle1", cycleOwnerId: "bob" })]), false);
  const prisma = await seedPrisma();
  await prisma.repo.completeSettledCycle({ cycleId: "cycle1", ownerId: "bob", now: NOW, activeCycleLimit: 1, newId: () => "unused" });
  assert.equal(await prisma.repo.addCycleItems([makeItem({ id: "late", cycleId: "cycle1", cycleOwnerId: "bob" })]), false);
});

