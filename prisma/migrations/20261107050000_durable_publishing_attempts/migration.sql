-- Durable attempt stages and claim metadata. This file is prepared only; it has not been applied.
CREATE TYPE "PublishingJobStage" AS ENUM (
  'queued', 'claimed', 'container_creation_pending', 'container_processing',
  'ready_to_publish', 'publishing', 'published', 'failed',
  'needs_manual_review', 'cancelled'
);

ALTER TABLE "PublishingJob"
  ADD COLUMN "ownerId" TEXT,
  ADD COLUMN "cycleId" TEXT,
  ADD COLUMN "socialAccountId" TEXT,
  ADD COLUMN "stage" "PublishingJobStage" NOT NULL DEFAULT 'queued',
  ADD COLUMN "workerId" TEXT,
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "containerId" TEXT,
  ADD COLUMN "instagramMediaId" TEXT,
  ADD COLUMN "errorCategory" TEXT,
  ADD COLUMN "errorDetails" TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "PublishingJob" AS job
SET "ownerId" = cycle."ownerId",
    "cycleId" = cycle."id",
    "socialAccountId" = cycle."socialAccountId",
    "stage" = CASE job."outcome"
      WHEN 'success' THEN 'published'::"PublishingJobStage"
      WHEN 'definite_failure' THEN 'failed'::"PublishingJobStage"
      WHEN 'ambiguous' THEN 'needs_manual_review'::"PublishingJobStage"
      ELSE 'needs_manual_review'::"PublishingJobStage"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "CycleItem" AS item
JOIN "PublishingCycle" AS cycle ON cycle."id" = item."cycleId"
WHERE item."id" = job."cycleItemId";

ALTER TABLE "PublishingJob"
  ALTER COLUMN "ownerId" SET NOT NULL,
  ALTER COLUMN "cycleId" SET NOT NULL,
  ALTER COLUMN "socialAccountId" SET NOT NULL;

ALTER TABLE "PublishingJob"
  ADD CONSTRAINT "PublishingJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublishingJob_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PublishingCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublishingJob_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PublishingJob_media_id_only_when_published_check" CHECK ("instagramMediaId" IS NULL OR "stage" = 'published');

CREATE INDEX "PublishingJob_stage_leaseExpiresAt_idx" ON "PublishingJob"("stage", "leaseExpiresAt");
CREATE INDEX "PublishingJob_socialAccountId_stage_createdAt_idx" ON "PublishingJob"("socialAccountId", "stage", "createdAt");
CREATE UNIQUE INDEX "PublishingJob_one_active_per_account" ON "PublishingJob"("socialAccountId")
WHERE "stage" IN ('claimed', 'container_creation_pending', 'container_processing', 'ready_to_publish', 'publishing');
