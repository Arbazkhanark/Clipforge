ALTER TABLE "MediaImportJob"
  ADD COLUMN "stagingObjectKey" TEXT,
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "lockToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attemptStorageKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "MediaImportJob"
  ADD CONSTRAINT "MediaImportJob_attempts_nonnegative" CHECK ("attempts" >= 0);

CREATE INDEX "MediaImportJob_status_leaseExpiresAt_idx"
  ON "MediaImportJob"("status", "leaseExpiresAt");
