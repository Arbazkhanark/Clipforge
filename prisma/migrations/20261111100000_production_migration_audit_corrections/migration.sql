-- Forward-only corrections for the production migration audit.
-- This migration intentionally stops on duplicate promotion/user history; it never
-- chooses a winner or deletes historical records.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public."PromotionRedemption"
    GROUP BY "promotionId", "userId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'PromotionRedemption contains duplicate promotion/user history; reconcile manually before applying this migration';
  END IF;
END;
$migration$;

-- One redemption per user and promotion across all statuses. A released row still
-- reserves that user's unique use; global usage counts continue to exclude released.
DROP INDEX IF EXISTS public."PromotionRedemption_one_unreleased_use_per_user_key";
CREATE UNIQUE INDEX "PromotionRedemption_promotionId_userId_key"
  ON public."PromotionRedemption" ("promotionId", "userId");

-- Promotion operations serialize user first, then promotion. These trigger locks
-- extend that order to direct INSERTs into redemption/grant tables.
CREATE FUNCTION public.clipforge_lock_promotion_use() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  PERFORM 1 FROM public."User" WHERE "id" = NEW."userId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion subject user does not exist';
  END IF;
  PERFORM 1 FROM public."Promotion" WHERE "id" = NEW."promotionId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion does not exist';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "PromotionRedemption_user_promotion_lock"
BEFORE INSERT ON public."PromotionRedemption"
FOR EACH ROW EXECUTE FUNCTION public.clipforge_lock_promotion_use();

CREATE TRIGGER "PromotionalAccessGrant_user_promotion_lock"
BEFORE INSERT ON public."PromotionalAccessGrant"
FOR EACH ROW EXECUTE FUNCTION public.clipforge_lock_promotion_use();

-- Protect all economic/eligibility terms after first use. Status, reason, and
-- updatedAt remain operationally editable by the existing audited application path.
CREATE FUNCTION public.clipforge_guard_used_promotion_terms() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF ROW(
    OLD."id", OLD."type", OLD."code", OLD."discountType", OLD."discountValue",
    OLD."accessPlanId", OLD."durationDays", OLD."eligiblePlanIds", OLD."targetUserId",
    OLD."startsAt", OLD."expiresAt", OLD."usageLimit", OLD."createdByAdminId", OLD."createdAt"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."type", NEW."code", NEW."discountType", NEW."discountValue",
    NEW."accessPlanId", NEW."durationDays", NEW."eligiblePlanIds", NEW."targetUserId",
    NEW."startsAt", NEW."expiresAt", NEW."usageLimit", NEW."createdByAdminId", NEW."createdAt"
  ) AND (
    EXISTS (SELECT 1 FROM public."PromotionRedemption" WHERE "promotionId" = OLD."id") OR
    EXISTS (SELECT 1 FROM public."PromotionalAccessGrant" WHERE "promotionId" = OLD."id")
  ) THEN
    RAISE EXCEPTION 'promotion terms are immutable after first redemption or grant';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Promotion_used_terms_immutable"
BEFORE UPDATE ON public."Promotion"
FOR EACH ROW EXECUTE FUNCTION public.clipforge_guard_used_promotion_terms();

-- A changed reason is allowed only when the same transaction records both the
-- lifecycle event and its corresponding audit row. Deferred validation permits
-- the repository's update-then-log transaction order, while rejecting a direct
-- SQL UPDATE that commits without an audit trail.
CREATE FUNCTION public.clipforge_require_promotion_reason_audit() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF OLD."reason" IS NOT DISTINCT FROM NEW."reason" THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."PromotionLifecycleEvent" AS event
    JOIN public."User" AS actor
      ON actor."id" = event."actorUserId"
     AND actor."role" = 'admin'::public."UserRole"
    JOIN public."AuditLog" AS audit
      ON audit."actorId" = event."actorUserId"
     AND audit."action" = 'promotion.promotion_updated'
     AND audit."entityType" = 'Promotion'
     AND audit."entityId" = NEW."id"
     AND audit."metadata" ->> 'eventKey' = event."eventKey"
     AND audit."metadata" ? 'reasonOld'
     AND audit."metadata" -> 'reasonOld' = COALESCE(to_jsonb(OLD."reason"), 'null'::jsonb)
     AND audit."metadata" ? 'reasonNew'
     AND audit."metadata" -> 'reasonNew' = COALESCE(to_jsonb(NEW."reason"), 'null'::jsonb)
    WHERE event."promotionId" = NEW."id"
      AND event."eventType" = 'promotion_updated'::public."PromotionLifecycleEventType"
      AND event."actorUserId" IS NOT NULL
      AND event."occurredAt" = NEW."updatedAt"
      AND event."metadata" ? 'reasonOld'
      AND event."metadata" -> 'reasonOld' = COALESCE(to_jsonb(OLD."reason"), 'null'::jsonb)
      AND event."metadata" ? 'reasonNew'
      AND event."metadata" -> 'reasonNew' = COALESCE(to_jsonb(NEW."reason"), 'null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'promotion reason change requires an Admin lifecycle event and matching audit record';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "Promotion_reason_requires_audit"
AFTER UPDATE ON public."Promotion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD."reason" IS DISTINCT FROM NEW."reason")
EXECUTE FUNCTION public.clipforge_require_promotion_reason_audit();

-- Keep the deferred discounted-intent invariant safe from search_path shadowing.
CREATE OR REPLACE FUNCTION public.clipforge_assert_discounted_manual_intent(p_intent_id TEXT, p_user_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_intent RECORD;
  v_list_price INTEGER;
BEGIN
  IF p_intent_id IS NULL OR p_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "id", "userId", "planId", "interval", "amountPaise"
    INTO v_intent
    FROM public."ManualPaymentIntent"
    WHERE "id" = p_intent_id AND "userId" = p_user_id;
  IF NOT FOUND THEN
    RETURN;
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
    FROM public."PromotionRedemption" AS redemption
    JOIN public."Promotion" AS promotion ON promotion."id" = redemption."promotionId"
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
END;
$function$;

CREATE OR REPLACE FUNCTION public.clipforge_validate_discounted_manual_intent() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'ManualPaymentIntent' THEN
    PERFORM public.clipforge_assert_discounted_manual_intent(NEW."id", NEW."userId");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.clipforge_assert_discounted_manual_intent(OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId");
  ELSE
    PERFORM public.clipforge_assert_discounted_manual_intent(NEW."manualPaymentIntentId", NEW."manualPaymentIntentUserId");
    IF TG_OP = 'UPDATE' AND
      (OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId") IS DISTINCT FROM
      (NEW."manualPaymentIntentId", NEW."manualPaymentIntentUserId") THEN
      PERFORM public.clipforge_assert_discounted_manual_intent(OLD."manualPaymentIntentId", OLD."manualPaymentIntentUserId");
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- Historical publishing outcome=success is not provider verification. Preserve
-- outcome/IDs and move both attempt and item to manual review without retrying.
UPDATE public."PublishingJob"
SET "stage" = 'needs_manual_review'::public."PublishingJobStage",
    "errorCategory" = COALESCE("errorCategory", 'legacy_success_without_verified_media_id'),
    "errorDetails" = COALESCE("errorDetails", 'Historical success has no verified Instagram media ID; operator review required.'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "outcome" = 'success'
  AND "stage" = 'published'
  AND "instagramMediaId" IS NULL;

UPDATE public."CycleItem" AS item
SET "status" = 'needs_review'::public."CycleItemStatus",
    "reviewReason" = 'legacy_publish_unverified',
    "lockedBy" = NULL,
    "lockExpiresAt" = NULL,
    "version" = "version" + 1
WHERE item."status" = 'published'
  AND EXISTS (
    SELECT 1 FROM public."PublishingJob" AS job
    WHERE job."cycleItemId" = item."id"
      AND job."outcome" = 'success'
      AND job."stage" = 'needs_manual_review'
      AND job."instagramMediaId" IS NULL
  )
  -- Do not downgrade an item if another attempt independently recorded a
  -- confirmed publication with its provider media ID.
  AND NOT EXISTS (
    SELECT 1 FROM public."PublishingJob" AS verified
    WHERE verified."cycleItemId" = item."id"
      AND verified."outcome" = 'success'
      AND verified."stage" = 'published'
      AND verified."instagramMediaId" IS NOT NULL
  );

-- Catalog prices are not evidence of historical charges. Identify synthetic
-- rows only by the explicit legacy backfill markers; do not compare against the
-- current catalog to decide whether an old amount was real.
ALTER TABLE public."RazorpaySubscriptionIntent"
  DROP CONSTRAINT "RazorpaySubscriptionIntent_amount_positive",
  DROP CONSTRAINT "RazorpaySubscriptionIntent_plan_price",
  ALTER COLUMN "amountPaise" DROP NOT NULL;

UPDATE public."RazorpaySubscriptionIntent" AS intent
SET "amountPaise" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM public."Subscription" AS subscription
WHERE intent."id" = 'legacy_' || subscription."id"
  AND intent."providerSubscriptionId" = subscription."razorpaySubscriptionId"
  AND intent."providerPlanId" = 'legacy_unverified'
  AND intent."status" = 'manual_review'
  AND intent."errorCategory" = 'legacy_subscription_unverified';

ALTER TABLE public."RazorpaySubscriptionIntent"
  ADD CONSTRAINT "RazorpaySubscriptionIntent_amount_positive"
    CHECK ("amountPaise" IS NULL OR "amountPaise" > 0),
  ADD CONSTRAINT "RazorpaySubscriptionIntent_plan_price"
    CHECK (
      (
        "amountPaise" IS NOT NULL AND (
          ("planId" = 'creator' AND "interval" = 'weekly' AND "amountPaise" = 49900) OR
          ("planId" = 'creator' AND "interval" = 'monthly' AND "amountPaise" = 199900) OR
          ("planId" = 'pro' AND "interval" = 'weekly' AND "amountPaise" = 99900) OR
          ("planId" = 'pro' AND "interval" = 'monthly' AND "amountPaise" = 399900) OR
          ("planId" = 'agency' AND "interval" = 'weekly' AND "amountPaise" = 149900) OR
          ("planId" = 'agency' AND "interval" = 'monthly' AND "amountPaise" = 599900)
        )
      ) OR (
        "amountPaise" IS NULL AND "status" = 'manual_review' AND
        "errorCategory" = 'legacy_subscription_unverified'
      )
    );
