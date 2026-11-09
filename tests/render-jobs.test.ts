import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { RenderJobRecord, Repository } from "../src/server/repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const now = new Date("2026-11-09T12:00:00.000Z");
const makeJob = (overrides: Partial<RenderJobRecord> = {}): RenderJobRecord => ({
  id: "render-1", ownerId: "owner-1", kind: "render", status: "queued", cycleItemId: null, mediaAssetId: "video-1",
  progressPercent: 0, attempts: 0, idempotencyKey: "render:owner-1:video-1:settings-hash", lockedBy: null, lockExpiresAt: null,
  errorMessage: null, createdAt: now, finishedAt: null, settingsHash: "settings-hash", payload: { version: 1, editingSettings: { aspect: "9:16" } },
  pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null, ...overrides,
});

const cases: { name: string; create(): Promise<{ repo: Repository; seedUser?: () => Promise<void> }> }[] = [
  { name: "memory", async create() { const repo = new MemoryRepository(); return { repo }; } },
  { name: "fake-Prisma", async create() { const db = new FakePrismaClient(); return { repo: new PrismaRepository(db), seedUser: async () => { await db.user.create({ data: { id: "owner-1", email: "owner@example.test" } }); } }; } },
];

for (const scenario of cases) {
  test(`${scenario.name}: render job idempotency compares the persisted export snapshot`, async () => {
    const { repo, seedUser } = await scenario.create(); await seedUser?.();
    const first = makeJob();
    assert.equal((await repo.createRenderJob(first)).status, "created");
    const identical = await repo.createRenderJob({ ...first, id: "render-retry", payload: { editingSettings: { aspect: "9:16" }, version: 1 } });
    assert.equal(identical.status, "existing");
    if (identical.status === "existing") assert.equal(identical.job.id, first.id);
    assert.equal((await repo.createRenderJob({ ...first, id: "render-changed", payload: { version: 1, editingSettings: { aspect: "1:1" } } })).status, "conflict");
    assert.equal((await repo.listRenderJobsForOwner("owner-1")).length, 1);
  });

  test(`${scenario.name}: expired leases are reclaimed with a fresh token and output id; stale workers cannot save`, async () => {
    const { repo, seedUser } = await scenario.create(); await seedUser?.();
    await repo.createRenderJob(makeJob());
    const first = await repo.claimNextRenderJob({ workerId: "worker-a", now, leaseSeconds: 10 });
    assert.ok(first?.lockToken && first.pendingOutputId);
    assert.equal(await repo.claimNextRenderJob({ workerId: "worker-b", now: new Date(now.getTime() + 9_999), leaseSeconds: 10 }), null);
    const recovered = await repo.claimNextRenderJob({ workerId: "worker-b", now: new Date(now.getTime() + 10_000), leaseSeconds: 10 });
    assert.ok(recovered?.lockToken && recovered.pendingOutputId);
    assert.notEqual(recovered!.lockToken, first!.lockToken);
    assert.notEqual(recovered!.pendingOutputId, first!.pendingOutputId);
    assert.equal(recovered!.attempts, 2);
    const output = { id: first!.pendingOutputId!, sourceMediaId: "video-1", ownerId: "owner-1", storageKey: `render/${first!.pendingOutputId}`, sizeBytes: 10, settingsHash: "settings-hash", createdAt: now };
    assert.deepEqual(await repo.saveRenderOutput(output, 1_000, { id: first!.id, ownerId: first!.ownerId, lockToken: first!.lockToken! }), { status: "stale_job" });
    const currentOutput = { ...output, id: recovered!.pendingOutputId!, storageKey: `render/${recovered!.pendingOutputId}` };
    assert.deepEqual(await repo.saveRenderOutput(currentOutput, 1_000, { id: recovered!.id, ownerId: recovered!.ownerId, lockToken: recovered!.lockToken! }), { status: "saved", id: recovered!.pendingOutputId });
    assert.equal(await repo.completeRenderJob(recovered!.id, recovered!.ownerId, recovered!.lockToken!, new Date(now.getTime() + 11_000), recovered!.pendingOutputId!), true);
  });

  test(`${scenario.name}: simultaneous workers cannot claim the same render lease`, async () => {
    const { repo, seedUser } = await scenario.create(); await seedUser?.();
    await repo.createRenderJob(makeJob());
    const claims = await Promise.all(["worker-a", "worker-b"].map((workerId) => repo.claimNextRenderJob({ workerId, now, leaseSeconds: 30 })));
    assert.equal(claims.filter(Boolean).length, 1);
  });
}
