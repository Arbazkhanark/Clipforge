-- Durable state for promoting a verified render into an independently verified MediaAsset.
-- This migration is additive: it does not change existing media, collection, or cycle rows.
CREATE TYPE "EditedMediaReplacementStatus" AS ENUM ('queued', 'copying', 'verifying', 'completed', 'blocked', 'failed');

CREATE TABLE "EditedMediaReplacement" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sourceMediaAssetId" TEXT NOT NULL,
    "sourceDerivativeId" TEXT NOT NULL,
    "plannedReplacementMediaAssetId" TEXT NOT NULL,
    "replacementMediaAssetId" TEXT,
    "stagingObjectKey" TEXT,
    "status" "EditedMediaReplacementStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT NOT NULL,
    "membershipSnapshot" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "lockToken" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EditedMediaReplacement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditedMediaReplacement_plannedReplacementMediaAssetId_key" ON "EditedMediaReplacement"("plannedReplacementMediaAssetId");
CREATE UNIQUE INDEX "EditedMediaReplacement_replacementMediaAssetId_key" ON "EditedMediaReplacement"("replacementMediaAssetId");
CREATE UNIQUE INDEX "EditedMediaReplacement_idempotencyKey_key" ON "EditedMediaReplacement"("idempotencyKey");
CREATE UNIQUE INDEX "EditedMediaReplacement_ownerId_sourceMediaAssetId_sourceDerivativeId_key" ON "EditedMediaReplacement"("ownerId", "sourceMediaAssetId", "sourceDerivativeId");
CREATE INDEX "EditedMediaReplacement_status_lockExpiresAt_createdAt_idx" ON "EditedMediaReplacement"("status", "lockExpiresAt", "createdAt");
CREATE INDEX "EditedMediaReplacement_ownerId_sourceMediaAssetId_idx" ON "EditedMediaReplacement"("ownerId", "sourceMediaAssetId");

ALTER TABLE "EditedMediaReplacement" ADD CONSTRAINT "EditedMediaReplacement_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditedMediaReplacement" ADD CONSTRAINT "EditedMediaReplacement_sourceMediaAssetId_fkey"
  FOREIGN KEY ("sourceMediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditedMediaReplacement" ADD CONSTRAINT "EditedMediaReplacement_sourceDerivativeId_ownerId_sourceMediaAssetId_fkey"
  FOREIGN KEY ("sourceDerivativeId", "ownerId", "sourceMediaAssetId") REFERENCES "MediaDerivative"("id", "ownerId", "mediaAssetId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EditedMediaReplacement" ADD CONSTRAINT "EditedMediaReplacement_replacementMediaAssetId_fkey"
  FOREIGN KEY ("replacementMediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
