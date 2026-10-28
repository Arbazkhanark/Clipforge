-- Constraints Prisma's schema language cannot express. Apply in a migration (Phase 2) AFTER the
-- tables exist. NOT yet applied or tested: no database is available in this environment.

-- One pending access request per person per collection.
CREATE UNIQUE INDEX collection_access_request_one_pending
  ON "CollectionAccessRequest" ("collectionId", "requesterId")
  WHERE status = 'pending';

-- Sanity checks that stop impossible data.
ALTER TABLE "CycleItem"   ADD CONSTRAINT cycle_item_version_positive CHECK (version >= 1);
ALTER TABLE "MediaAsset"  ADD CONSTRAINT media_size_non_negative    CHECK ("sizeBytes" >= 0);
ALTER TABLE "PaymentRecord" ADD CONSTRAINT payment_amount_non_negative CHECK ("amountPaise" >= 0);

-- A video marked pending_deletion must say when access ends.
ALTER TABLE "MediaAsset" ADD CONSTRAINT media_pending_deletion_has_date
  CHECK (status <> 'pending_deletion' OR "deleteAfter" IS NOT NULL);
