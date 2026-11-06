-- Integrity rules that were missing from 20261106135723_init.
-- Source: prisma/manual-constraints.sql.
--
-- The partial unique index is also declared on CollectionAccessRequest in schema.prisma.
-- The four CHECK constraints cannot be declared in the Prisma schema. They are documented
-- on CycleItem.version, MediaAsset.sizeBytes, MediaAsset.deleteAfter, and PaymentRecord.amountPaise.
--
-- This migration does not UPDATE or DELETE rows.
-- If a current row would violate a rule, it raises and leaves the data unchanged.
-- If the same object already exists with the intended meaning, it is left in place.
-- If the same name exists with a different definition, it raises and leaves that object unchanged.

DO $$
DECLARE
  duplicate_pending integer;
  bad_versions integer;
  bad_sizes integer;
  bad_payments integer;
  bad_deletions integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_pending FROM (
    SELECT 1
    FROM "CollectionAccessRequest"
    WHERE status = 'pending'
    GROUP BY "collectionId", "requesterId"
    HAVING COUNT(*) > 1
  ) duplicates;

  SELECT COUNT(*) INTO bad_versions FROM "CycleItem" WHERE version < 1;
  SELECT COUNT(*) INTO bad_sizes FROM "MediaAsset" WHERE "sizeBytes" < 0;
  SELECT COUNT(*) INTO bad_payments FROM "PaymentRecord" WHERE "amountPaise" < 0;
  SELECT COUNT(*) INTO bad_deletions
  FROM "MediaAsset"
  WHERE status = 'pending_deletion' AND "deleteAfter" IS NULL;

  IF duplicate_pending > 0 THEN
    RAISE EXCEPTION 'Refusing collection_access_request_one_pending: % collection/requester pair(s) already have more than one pending request', duplicate_pending;
  END IF;
  IF bad_versions > 0 THEN
    RAISE EXCEPTION 'Refusing cycle_item_version_positive: % CycleItem row(s) have version < 1', bad_versions;
  END IF;
  IF bad_sizes > 0 THEN
    RAISE EXCEPTION 'Refusing media_size_non_negative: % MediaAsset row(s) have sizeBytes < 0', bad_sizes;
  END IF;
  IF bad_payments > 0 THEN
    RAISE EXCEPTION 'Refusing payment_amount_non_negative: % PaymentRecord row(s) have amountPaise < 0', bad_payments;
  END IF;
  IF bad_deletions > 0 THEN
    RAISE EXCEPTION 'Refusing media_pending_deletion_has_date: % MediaAsset row(s) are pending_deletion without deleteAfter', bad_deletions;
  END IF;
END $$;

DO $$
DECLARE
  index_oid oid;
  is_unique boolean;
  predicate text;
  columns text;
BEGIN
  SELECT c.oid, i.indisunique, pg_get_expr(i.indpred, i.indrelid), (
    SELECT string_agg(a.attname, ',' ORDER BY cols.ordinality)
    FROM unnest(i.indkey) WITH ORDINALITY AS cols(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = cols.attnum
  )
  INTO index_oid, is_unique, predicate, columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relname = 'collection_access_request_one_pending';

  IF index_oid IS NULL THEN
    CREATE UNIQUE INDEX collection_access_request_one_pending
      ON "CollectionAccessRequest" ("collectionId", "requesterId")
      WHERE status = 'pending';
  ELSIF is_unique IS NOT TRUE
     OR columns IS DISTINCT FROM 'collectionId,requesterId'
     OR predicate IS NULL
     OR position('status' in predicate) = 0
     OR position('pending' in predicate) = 0
     OR position('approved' in predicate) > 0
     OR position('rejected' in predicate) > 0
  THEN
    RAISE EXCEPTION 'collection_access_request_one_pending exists but does not enforce one pending request per collection and requester (columns=%, predicate=%)', columns, predicate;
  END IF;
END $$;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'cycle_item_version_positive'
    AND conrelid = '"CycleItem"'::regclass;

  IF def IS NULL THEN
    ALTER TABLE "CycleItem" ADD CONSTRAINT cycle_item_version_positive CHECK (version >= 1);
  ELSIF position('version >= 1' in def) = 0 THEN
    RAISE EXCEPTION 'cycle_item_version_positive exists with a different definition: %', def;
  END IF;
END $$;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'media_size_non_negative'
    AND conrelid = '"MediaAsset"'::regclass;

  IF def IS NULL THEN
    ALTER TABLE "MediaAsset" ADD CONSTRAINT media_size_non_negative CHECK ("sizeBytes" >= 0);
  ELSIF position('"sizeBytes" >= 0' in def) = 0 THEN
    RAISE EXCEPTION 'media_size_non_negative exists with a different definition: %', def;
  END IF;
END $$;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'payment_amount_non_negative'
    AND conrelid = '"PaymentRecord"'::regclass;

  IF def IS NULL THEN
    ALTER TABLE "PaymentRecord" ADD CONSTRAINT payment_amount_non_negative CHECK ("amountPaise" >= 0);
  ELSIF position('"amountPaise" >= 0' in def) = 0 THEN
    RAISE EXCEPTION 'payment_amount_non_negative exists with a different definition: %', def;
  END IF;
END $$;

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'media_pending_deletion_has_date'
    AND conrelid = '"MediaAsset"'::regclass;

  IF def IS NULL THEN
    ALTER TABLE "MediaAsset" ADD CONSTRAINT media_pending_deletion_has_date
      CHECK (status <> 'pending_deletion' OR "deleteAfter" IS NOT NULL);
  ELSIF position('pending_deletion' in def) = 0
     OR position('"deleteAfter" IS NOT NULL' in def) = 0
  THEN
    RAISE EXCEPTION 'media_pending_deletion_has_date exists with a different definition: %', def;
  END IF;
END $$;
