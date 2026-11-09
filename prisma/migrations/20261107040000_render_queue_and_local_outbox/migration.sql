-- Durable render fields and the encrypted local outbox.
-- Nullable columns and a new table only. No existing table is dropped or rewritten.
-- This migration is not applied by Phase 10J.

ALTER TABLE "ProcessingJob" ADD COLUMN "settingsHash" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "payload" JSONB;
ALTER TABLE "ProcessingJob" ADD COLUMN "pendingOutputId" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "outputDerivativeId" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "lockToken" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "ffmpegPid" INTEGER;
ALTER TABLE "ProcessingJob" ADD COLUMN "ffmpegStartedAt" TIMESTAMP(3);

CREATE TABLE "LocalEmailMessage" (
    "id" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocalEmailMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LocalEmailMessage_toAddress_createdAt_idx" ON "LocalEmailMessage"("toAddress", "createdAt");
CREATE INDEX "LocalEmailMessage_expiresAt_idx" ON "LocalEmailMessage"("expiresAt");
