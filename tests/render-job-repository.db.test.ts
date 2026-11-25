// Scoped ProcessingJob check against the isolated local database only.
// isolatedDatabaseUrl() refuses any other target before a connection is opened.
// The repository has no owner-scoped delete, so the created job row is left in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import type { RenderJobRecord } from "../src/server/repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const databaseUrlAtStart = isolatedDatabaseUrl();
const hasDatabase = Boolean(databaseUrlAtStart);

test("isolated PostgreSQL render job repository is owner-scoped and rejects a wrong lock token", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => {
  const stamp = randomUUID();
  const ownerId = `render-repo-${stamp}`;
  const otherOwnerId = `render-repo-other-${stamp}`;
  const jobId = `render-job-${stamp}`;
  const idempotencyKey = `render-repo-test:${stamp}`;
  const db = await createPrismaClient(databaseUrlAtStart as string);
  const closer = db as PrismaClientLike & { $disconnect(): Promise<void> };
  let ownsFixture = false;
  try {
    const preserved = async () => ({
      users: await db.user.count(),
      sessions: await db.session.count(),
      collections: await db.videoCollection.count(),
      media: await db.mediaAsset.count(),
    });
    const before = await preserved();
    const jobsBefore = await db.processingJob.count();
    const repo = new PrismaRepository(db);
    const job: RenderJobRecord = {
      id: jobId, ownerId, kind: "render", status: "queued", cycleItemId: null, mediaAssetId: null,
      progressPercent: 0, attempts: 0, idempotencyKey, lockedBy: null, lockExpiresAt: null, errorMessage: null,
      createdAt: new Date(), finishedAt: null, settingsHash: null, payload: { aspect: "9:16" },
      pendingOutputId: null, outputDerivativeId: null, lockToken: null, ffmpegPid: null, ffmpegStartedAt: null,
    };
    const created = await repo.createRenderJob(job);
    ownsFixture = created.status === "created" && created.job.id === jobId;
    assert.equal(created.status, "created");
    if (created.status === "created") assert.equal(created.job.id, jobId);

    const owned = await repo.getRenderJobForOwner(jobId, ownerId);
    assert.equal(owned?.id, jobId);
    assert.equal(owned?.status, "queued");
    assert.equal(await repo.getRenderJobForOwner(jobId, otherOwnerId), null);

    const byKey = await repo.getRenderJobByIdempotencyKey(idempotencyKey, ownerId);
    assert.equal(byKey?.id, jobId);
    assert.equal(await repo.getRenderJobByIdempotencyKey(idempotencyKey, otherOwnerId), null);

    const duplicate = await repo.createRenderJob({ ...job, id: `render-job-duplicate-${stamp}` });
    assert.equal(duplicate.status, "existing");
    if (duplicate.status === "existing") assert.equal(duplicate.job.id, jobId);
    const conflict = await repo.createRenderJob({ ...job, id: `render-job-conflict-${stamp}`, ownerId: otherOwnerId });
    assert.equal(conflict.status, "conflict");

    const ownList = await repo.listRenderJobsForOwner(ownerId);
    assert.deepEqual(ownList.map((row) => row.id), [jobId]);
    assert.equal((await repo.listRenderJobsForOwner(otherOwnerId)).some((row) => row.id === jobId), false);

    assert.equal(await repo.updateRenderJobProgress(jobId, ownerId, "incorrect-lock-token", 25), false);
    assert.equal(await repo.heartbeatRenderJob(jobId, ownerId, "incorrect-lock-token", new Date(), 60), false);
    const afterUpdate = await repo.getRenderJobForOwner(jobId, ownerId);
    assert.equal(afterUpdate?.status, "queued");
    assert.equal(afterUpdate?.progressPercent, 0);
    assert.equal(afterUpdate?.attempts, 0);
    assert.equal(afterUpdate?.lockToken, null);

    assert.equal(await db.processingJob.count(), jobsBefore + 1);
    assert.deepEqual(await preserved(), before);
  } finally {
    try {
      if (ownsFixture) {
        await db.processingJob.deleteMany({
          where: { id: jobId, idempotencyKey, ownerId, kind: "render" },
        });
      }
    } finally {
      await closer.$disconnect();
    }
  }
});
