-- Forward-only promotion persistence and discounted manual-payment compatibility.
-- Prepared for review; do not apply until migration history, backups, and preflight checks
-- have been verified for each target database.

-- This replaces the full-list-price-only rule from 20261107090000. Discounted intents
-- remain positive, INR, supported-plan/interval amounts no greater than the catalog price.
-- Discount snapshots below bind the payable amount to an owner-bound manual intent.
ALTER TABLE "ManualPaymentIntent"
  DROP CONSTRAINT "ManualPaymentIntent_plan_price";

ALTER TABLE "ManualPaymentIntent"
  ADD CONSTRAINT "ManualPaymentIntent_plan_price" CHECK (
    "amountPaise" > 0 AND "currency" = 'INR' AND (
      ("planId" = 'creator' AND "interval" = 'weekly' AND "amountPaise" <= 49900) OR
      ("planId" = 'creator' AND "interval" = 'monthly' AND "amountPaise" <= 199900) OR
      ("planId" = 'pro' AND "interval" = 'weekly' AND "amountPaise" <= 99900) OR
      ("planId" = 'pro' AND "interval" = 'monthly' AND "amountPaise" <= 399900) OR
      ("planId" = 'agency' AND "interval" = 'weekly' AND "amountPaise" <= 149900) OR
      ("planId" = 'agency' AND "interval" = 'monthly' AND "amountPaise" <= 599900)
    )
  );

CREATE UNIQUE INDEX "ManualPaymentIntent_id_userId_planId_interval_amountPaise_key"
  ON "ManualPaymentIntent" ("id", "userId", "planId", "interval", "amountPaise");

CREATE TYPE "PromotionType" AS ENUM ('bonus_days', 'tier_access', 'discount_coupon', 'free_access_coupon');
CREATE TYPE "PromotionStatus" AS ENUM ('draft', 'active', 'paused', 'expired', 'revoked');
CREATE TYPE "PromotionDiscountType" AS ENUM ('percentage', 'fixed_amount');
CREATE TYPE "PromotionRedemptionStatus" AS ENUM ('reserved', 'redeemed', 'released', 'manual_review');
CREATE TYPE "PromotionalAccessStatus" AS ENUM ('queued', 'active', 'expired', 'revoked');
CREATE TYPE "PromotionalAccessKind" AS ENUM ('bonus_days', 'tier_access', 'free_access_coupon');
CREATE TYPE "PromotionActivationPolicy" AS ENUM ('immediate', 'after_current_access');
CREATE TYPE "PromotionLifecycleEventType" AS ENUM (
  'promotion_created', 'promotion_updated', 'promotion_paused', 'promotion_revoked',
  'grant_created', 'grant_queued', 'grant_activated', 'grant_expired', 'grant_revoked',
  'coupon_reserved', 'coupon_redeemed', 'coupon_released', 'manual_review_required'
);

CREATE SEQUENCE "PromotionalAccessGrant_queueSequence_seq" AS BIGINT;

CREATE TABLE "Promotion" (
  "id" TEXT NOT NULL,
  "type" "PromotionType" NOT NULL,
  "status" "PromotionStatus" NOT NULL DEFAULT 'draft',
  "code" TEXT,
  "discountType" "PromotionDiscountType",
  "discountValue" INTEGER,
  "accessPlanId" TEXT,
  "durationDays" INTEGER,
  "eligiblePlanIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetUserId" TEXT,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3),
  "usageLimit" INTEGER,
  "createdByAdminId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Promotion_targetUserId_fkey" FOREIGN KEY ("targetUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Promotion_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Promotion_code_canonical" CHECK (
    "code" IS NULL OR ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9_-]{3,64}$')
  ),
  CONSTRAINT "Promotion_usage_limit_positive" CHECK ("usageLimit" IS NULL OR "usageLimit" > 0),
  CONSTRAINT "Promotion_validity_order" CHECK ("expiresAt" IS NULL OR "expiresAt" > "startsAt"),
  CONSTRAINT "Promotion_supported_plan_ids" CHECK (
    "eligiblePlanIds" <@ ARRAY['creator', 'pro', 'agency']::TEXT[]
  ),
  CONSTRAINT "Promotion_supported_access_plan" CHECK (
    "accessPlanId" IS NULL OR "accessPlanId" IN ('creator', 'pro', 'agency')
  ),
  CONSTRAINT "Promotion_duration_bounds" CHECK (
    "durationDays" IS NULL OR "durationDays" BETWEEN 1 AND 30
  ),
  CONSTRAINT "Promotion_percentage_bounds" CHECK (
    ("discountType" IS DISTINCT FROM 'percentage' OR
      ("discountValue" IS NOT NULL AND "discountValue" BETWEEN 1 AND 50)) IS TRUE
  ),
  CONSTRAINT "Promotion_fixed_discount_positive" CHECK (
    ("discountType" IS DISTINCT FROM 'fixed_amount' OR
      ("discountValue" IS NOT NULL AND "discountValue" > 0)) IS TRUE
  ),
  CONSTRAINT "Promotion_type_fields" CHECK ((
    (
      "type" IN ('bonus_days', 'tier_access') AND
      "accessPlanId" IN ('creator', 'pro', 'agency') AND
      "durationDays" BETWEEN 1 AND 30 AND "targetUserId" IS NOT NULL AND
      "code" IS NULL AND "discountType" IS NULL AND "discountValue" IS NULL AND
      cardinality("eligiblePlanIds") = 0 AND "usageLimit" IS NULL
    ) OR (
      "type" = 'discount_coupon' AND "code" IS NOT NULL AND
      "discountType" IN ('percentage', 'fixed_amount') AND "discountValue" IS NOT NULL AND
      cardinality("eligiblePlanIds") > 0 AND "accessPlanId" IS NULL AND "durationDays" IS NULL
    ) OR (
      "type" = 'free_access_coupon' AND "code" IS NOT NULL AND
      "discountType" IS NULL AND "discountValue" IS NULL AND
      "accessPlanId" IN ('creator', 'pro', 'agency') AND "durationDays" BETWEEN 1 AND 30 AND
      cardinality("eligiblePlanIds") = 0
    )
  ) IS TRUE)
);

CREATE TABLE "PromotionRedemption" (
  "id" TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "PromotionRedemptionStatus" NOT NULL DEFAULT 'reserved',
  "idempotencyKey" TEXT NOT NULL,
  "planId" TEXT,
  "interval" "BillingInterval",
  "listPricePaise" INTEGER,
  "discountPaise" INTEGER,
  "payablePaise" INTEGER,
  "currency" TEXT,
  "manualPaymentIntentId" TEXT,
  "manualPaymentIntentUserId" TEXT,
  "reservedAt" TIMESTAMPTZ(3) NOT NULL,
  "redeemedAt" TIMESTAMPTZ(3),
  "releasedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PromotionRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromotionRedemption_promotionId_fkey" FOREIGN KEY ("promotionId")
    REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionRedemption_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionRedemption_manualPaymentIntentId_manualPaymentIntentUserId_fkey"
    FOREIGN KEY ("manualPaymentIntentId", "manualPaymentIntentUserId")
    REFERENCES "ManualPaymentIntent"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionRedemption_manual_intent_owner_pair" CHECK (
    ("manualPaymentIntentId" IS NULL AND "manualPaymentIntentUserId" IS NULL) OR
    ("manualPaymentIntentId" IS NOT NULL AND "manualPaymentIntentUserId" IS NOT NULL
      AND "manualPaymentIntentUserId" = "userId" AND "planId" IS NOT NULL AND
      "interval" IS NOT NULL AND "listPricePaise" IS NOT NULL AND
      "discountPaise" IS NOT NULL AND "payablePaise" IS NOT NULL AND "currency" IS NOT NULL)
  ),
  CONSTRAINT "PromotionRedemption_discount_snapshot" CHECK ((
    (
      "planId" IS NULL AND "interval" IS NULL AND "listPricePaise" IS NULL AND
      "discountPaise" IS NULL AND "payablePaise" IS NULL AND "currency" IS NULL
    ) OR (
      "planId" IN ('creator', 'pro', 'agency') AND "interval" IN ('weekly', 'monthly') AND
      "listPricePaise" = CASE
        WHEN "planId" = 'creator' AND "interval" = 'weekly' THEN 49900
        WHEN "planId" = 'creator' AND "interval" = 'monthly' THEN 199900
        WHEN "planId" = 'pro' AND "interval" = 'weekly' THEN 99900
        WHEN "planId" = 'pro' AND "interval" = 'monthly' THEN 399900
        WHEN "planId" = 'agency' AND "interval" = 'weekly' THEN 149900
        WHEN "planId" = 'agency' AND "interval" = 'monthly' THEN 599900
        ELSE NULL
      END AND
      "listPricePaise" > 0 AND "discountPaise" > 0 AND "payablePaise" > 0 AND
      "currency" = 'INR' AND "payablePaise" = "listPricePaise" - "discountPaise" AND
      "discountPaise" <= floor("listPricePaise" * 0.5)
    )
  ) IS TRUE),
  CONSTRAINT "PromotionRedemption_released_timestamp" CHECK (
    ("status" = 'released') = ("releasedAt" IS NOT NULL)
  )
);

CREATE TABLE "PromotionalAccessGrant" (
  "id" TEXT NOT NULL,
  "promotionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "redemptionId" TEXT,
  "redemptionUserId" TEXT,
  "redemptionPromotionId" TEXT,
  "kind" "PromotionalAccessKind" NOT NULL,
  "activationPolicy" "PromotionActivationPolicy" NOT NULL,
  "status" "PromotionalAccessStatus" NOT NULL DEFAULT 'queued',
  "planId" TEXT NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "queueSequence" BIGINT NOT NULL DEFAULT nextval('"PromotionalAccessGrant_queueSequence_seq"'::regclass),
  "startsAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  "activatedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "grantedByAdminId" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PromotionalAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromotionalAccessGrant_promotionId_fkey" FOREIGN KEY ("promotionId")
    REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionalAccessGrant_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionalAccessGrant_grantedByAdminId_fkey" FOREIGN KEY ("grantedByAdminId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionalAccessGrant_redemption_owner_promotion" CHECK (
    (
      "redemptionId" IS NULL AND "redemptionUserId" IS NULL AND "redemptionPromotionId" IS NULL
    ) OR (
      "redemptionId" IS NOT NULL AND "redemptionUserId" IS NOT NULL AND
      "redemptionPromotionId" IS NOT NULL AND "redemptionUserId" = "userId" AND
      "redemptionPromotionId" = "promotionId"
    )
  ),
  CONSTRAINT "PromotionalAccessGrant_supported_plan" CHECK ("planId" IN ('creator', 'pro', 'agency')),
  CONSTRAINT "PromotionalAccessGrant_duration_bounds" CHECK ("durationDays" BETWEEN 1 AND 30),
  CONSTRAINT "PromotionalAccessGrant_period_state" CHECK ((
    (
      "status" = 'queued' AND "startsAt" IS NULL AND "expiresAt" IS NULL AND "activatedAt" IS NULL
    ) OR (
      "status" IN ('active', 'expired') AND "startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND
      "activatedAt" IS NOT NULL AND "expiresAt" > "startsAt"
    ) OR (
      "status" = 'revoked' AND (
        ("startsAt" IS NULL AND "expiresAt" IS NULL AND "activatedAt" IS NULL) OR
        ("startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "expiresAt" > "startsAt")
      )
    )
  ) IS TRUE),
  CONSTRAINT "PromotionalAccessGrant_revoked_timestamp" CHECK (
    ("status" = 'revoked') = ("revokedAt" IS NOT NULL)
  )
);

ALTER SEQUENCE "PromotionalAccessGrant_queueSequence_seq"
  OWNED BY "PromotionalAccessGrant"."queueSequence";

CREATE TABLE "PromotionLifecycleEvent" (
  "id" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" "PromotionLifecycleEventType" NOT NULL,
  "promotionId" TEXT NOT NULL,
  "subjectUserId" TEXT,
  "actorUserId" TEXT,
  "redemptionId" TEXT,
  "redemptionUserId" TEXT,
  "redemptionPromotionId" TEXT,
  "accessGrantId" TEXT,
  "accessGrantUserId" TEXT,
  "accessGrantPromotionId" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "outcome" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromotionLifecycleEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromotionLifecycleEvent_promotionId_fkey" FOREIGN KEY ("promotionId")
    REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionLifecycleEvent_subjectUserId_fkey" FOREIGN KEY ("subjectUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionLifecycleEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PromotionLifecycleEvent_redemption_owner_promotion" CHECK (
    (
      "redemptionId" IS NULL AND "redemptionUserId" IS NULL AND "redemptionPromotionId" IS NULL
    ) OR (
      "redemptionId" IS NOT NULL AND "redemptionUserId" IS NOT NULL AND
      "redemptionPromotionId" IS NOT NULL AND "subjectUserId" IS NOT NULL AND
      "redemptionUserId" = "subjectUserId" AND "redemptionPromotionId" = "promotionId"
    )
  ),
  CONSTRAINT "PromotionLifecycleEvent_grant_owner_promotion" CHECK (
    (
      "accessGrantId" IS NULL AND "accessGrantUserId" IS NULL AND "accessGrantPromotionId" IS NULL
    ) OR (
      "accessGrantId" IS NOT NULL AND "accessGrantUserId" IS NOT NULL AND
      "accessGrantPromotionId" IS NOT NULL AND "subjectUserId" IS NOT NULL AND
      "accessGrantUserId" = "subjectUserId" AND "accessGrantPromotionId" = "promotionId"
    )
  ),
  CONSTRAINT "PromotionLifecycleEvent_one_target" CHECK (
    NOT ("redemptionId" IS NOT NULL AND "accessGrantId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion" ("code");
CREATE INDEX "Promotion_type_status_startsAt_expiresAt_idx"
  ON "Promotion" ("type", "status", "startsAt", "expiresAt");
CREATE INDEX "Promotion_targetUserId_status_idx" ON "Promotion" ("targetUserId", "status");

CREATE UNIQUE INDEX "PromotionRedemption_userId_idempotencyKey_key"
  ON "PromotionRedemption" ("userId", "idempotencyKey");
CREATE UNIQUE INDEX "PromotionRedemption_id_userId_key" ON "PromotionRedemption" ("id", "userId");
CREATE UNIQUE INDEX "PromotionRedemption_id_userId_promotionId_key"
  ON "PromotionRedemption" ("id", "userId", "promotionId");
CREATE UNIQUE INDEX "PromotionRedemption_manualPaymentIntentId_manualPaymentIntentUserId_key"
  ON "PromotionRedemption" ("manualPaymentIntentId", "manualPaymentIntentUserId");
CREATE INDEX "PromotionRedemption_promotionId_status_createdAt_idx"
  ON "PromotionRedemption" ("promotionId", "status", "createdAt");
CREATE INDEX "PromotionRedemption_userId_createdAt_idx" ON "PromotionRedemption" ("userId", "createdAt");

CREATE UNIQUE INDEX "PromotionRedemption_one_unreleased_use_per_user_key"
  ON "PromotionRedemption" ("promotionId", "userId")
  WHERE "status" IN ('reserved', 'redeemed', 'manual_review');

CREATE UNIQUE INDEX "PromotionalAccessGrant_redemptionId_key"
  ON "PromotionalAccessGrant" ("redemptionId");
CREATE UNIQUE INDEX "PromotionalAccessGrant_id_userId_promotionId_key"
  ON "PromotionalAccessGrant" ("id", "userId", "promotionId");
CREATE UNIQUE INDEX "PromotionalAccessGrant_redemptionId_redemptionUserId_redemptionPromotionId_key"
  ON "PromotionalAccessGrant" ("redemptionId", "redemptionUserId", "redemptionPromotionId");
CREATE UNIQUE INDEX "PromotionalAccessGrant_queueSequence_key" ON "PromotionalAccessGrant" ("queueSequence");
CREATE INDEX "PromotionalAccessGrant_userId_status_queueSequence_idx"
  ON "PromotionalAccessGrant" ("userId", "status", "queueSequence");
CREATE INDEX "PromotionalAccessGrant_status_startsAt_expiresAt_idx"
  ON "PromotionalAccessGrant" ("status", "startsAt", "expiresAt");
CREATE UNIQUE INDEX "PromotionalAccessGrant_one_active_per_user"
  ON "PromotionalAccessGrant" ("userId") WHERE "status" = 'active';

CREATE UNIQUE INDEX "PromotionLifecycleEvent_eventKey_key" ON "PromotionLifecycleEvent" ("eventKey");
CREATE INDEX "PromotionLifecycleEvent_promotionId_occurredAt_idx"
  ON "PromotionLifecycleEvent" ("promotionId", "occurredAt");
CREATE INDEX "PromotionLifecycleEvent_subjectUserId_occurredAt_idx"
  ON "PromotionLifecycleEvent" ("subjectUserId", "occurredAt");
CREATE INDEX "PromotionLifecycleEvent_actorUserId_occurredAt_idx"
  ON "PromotionLifecycleEvent" ("actorUserId", "occurredAt");

-- These composite keys bind the payment amount, plan, interval, and owner to the
-- immutable redemption snapshot. Free-access redemptions keep these columns null.
ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "PromotionRedemption_manual_intent_snapshot_fkey"
  FOREIGN KEY ("manualPaymentIntentId", "manualPaymentIntentUserId", "planId", "interval", "payablePaise")
  REFERENCES "ManualPaymentIntent" ("id", "userId", "planId", "interval", "amountPaise")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PromotionalAccessGrant"
  ADD CONSTRAINT "PromotionalAccessGrant_redemptionId_redemptionUserId_redemptionPromotionId_fkey"
  FOREIGN KEY ("redemptionId", "redemptionUserId", "redemptionPromotionId")
  REFERENCES "PromotionRedemption" ("id", "userId", "promotionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PromotionLifecycleEvent"
  ADD CONSTRAINT "PromotionLifecycleEvent_redemptionId_redemptionUserId_redemptionPromotionId_fkey"
  FOREIGN KEY ("redemptionId", "redemptionUserId", "redemptionPromotionId")
  REFERENCES "PromotionRedemption" ("id", "userId", "promotionId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PromotionLifecycleEvent_accessGrantId_accessGrantUserId_accessGrantPromotionId_fkey"
  FOREIGN KEY ("accessGrantId", "accessGrantUserId", "accessGrantPromotionId")
  REFERENCES "PromotionalAccessGrant" ("id", "userId", "promotionId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A discounted intent must have a durable matching discount-coupon snapshot at commit.
-- Deferral allows the reservation transaction to insert the intent before its redemption.
-- A released redemption remains valid evidence for the original intent; it does not reopen
-- or alter that intent. Standalone redemption records without a manual intent remain allowed
-- for the repository's existing non-checkout paths.
CREATE FUNCTION "clipforge_assert_discounted_manual_intent"(p_intent_id TEXT, p_user_id TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_intent RECORD;
  v_list_price INTEGER;
BEGIN
  IF p_intent_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "id", "userId", "planId", "interval", "amountPaise"
    INTO v_intent
    FROM "ManualPaymentIntent"
    WHERE "id" = p_intent_id AND "userId" = p_user_id;
  IF NOT FOUND THEN
    RETURN; -- Foreign keys remain responsible for missing intent rows.
  END IF;

  v_list_price := CASE
    WHEN v_intent."planId" = 'creator' AND v_intent."interval" = 'weekly' THEN 49900
    WHEN v_intent."planId" = 'creator' AND v_intent."interval" = 'monthly' THEN 199900
    WHEN v_intent."planId" = 'pro' AND v_intent."interval" = 'weekly' THEN 99900
    WHEN v_intent."planId" = 'pro' AND v_intent."interval" = 'monthly' THEN 399900
    WHEN v_intent."planId" = 'agency' AND v_intent."interval" = 'weekly' THEN 149900
    WHEN v_intent."planId" = 'agency' AND v_intent."interval" = 'monthly' THEN 599900
    ELSE NULL
  END;

  IF v_list_price IS NULL THEN
    RAISE EXCEPTION 'manual payment intent has unsupported catalog terms';
  END IF;
  IF v_intent."amountPaise" = v_list_price THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "PromotionRedemption" AS redemption
    JOIN "Promotion" AS promotion ON promotion."id" = redemption."promotionId"
    WHERE redemption."manualPaymentIntentId" = v_intent."id"
      AND redemption."manualPaymentIntentUserId" = v_intent."userId"
      AND redemption."userId" = v_intent."userId"
      AND redemption."planId" = v_intent."planId"
      AND redemption."interval" = v_intent."interval"
      AND redemption."listPricePaise" = v_list_price
      AND redemption."payablePaise" = v_intent."amountPaise"
      AND redemption."currency" = 'INR'
      AND promotion."type" = 'discount_coupon'
      AND (
        (promotion."discountType" = 'percentage' AND redemption."discountPaise" =
          floor(redemption."listPricePaise" * promotion."discountValue" / 100)) OR
        (promotion."discountType" = 'fixed_amount' AND redemption."discountPaise" = promotion."discountValue")
      )
  ) THEN
    RAISE EXCEPTION 'discounted manual payment intent lacks a matching coupon snapshot';
  END IF;

  RETURN;
END;
$$;

CREATE FUNCTION "clipforge_validate_discounted_manual_intent"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ManualPaymentIntent' THEN
    PERFORM "clipforge_assert_discounted_manual_intent"(NEW."id", NEW."userId");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "clipforge_assert_discounted_manual_intent"(OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId");
  ELSE
    PERFORM "clipforge_assert_discounted_manual_intent"(NEW."manualPaymentIntentId", NEW."manualPaymentIntentUserId");
    IF TG_OP = 'UPDATE' AND
      (OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId") IS DISTINCT FROM
      (NEW."manualPaymentIntentId", NEW."manualPaymentIntentUserId") THEN
      PERFORM "clipforge_assert_discounted_manual_intent"(OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ManualPaymentIntent_discount_snapshot_required"
AFTER INSERT OR UPDATE ON "ManualPaymentIntent"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "clipforge_validate_discounted_manual_intent"();

CREATE CONSTRAINT TRIGGER "PromotionRedemption_discount_snapshot_matches_intent"
AFTER INSERT OR UPDATE OR DELETE ON "PromotionRedemption"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "clipforge_validate_discounted_manual_intent"();

