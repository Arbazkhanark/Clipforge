# Promotion System: SQL Constraint and Index Review

**Status: review-only design.** This is not a migration. Do not execute this document as SQL. The model declarations are in `prisma/schema.prisma`; this document records checks and indexes that Prisma schema declarations do not fully express.

## Required ownership relationships

Prisma relations declare these composite foreign keys and referenced unique keys:

- `PromotionRedemption(manualPaymentIntentId, manualPaymentIntentUserId)` references `ManualPaymentIntent(id, userId)`.
- `PromotionalAccessGrant(redemptionId, redemptionUserId, redemptionPromotionId)` references `PromotionRedemption(id, userId, promotionId)`.
- `PromotionLifecycleEvent(redemptionId, redemptionUserId, redemptionPromotionId)` references `PromotionRedemption(id, userId, promotionId)`.
- `PromotionLifecycleEvent(accessGrantId, accessGrantUserId, accessGrantPromotionId)` references `PromotionalAccessGrant(id, userId, promotionId)`.

The duplicated owner/promotion columns need checks as well as foreign keys. PostgreSQL's default composite-FK `MATCH SIMPLE` behavior does not reject a partly-null key, so enforce all-null or all-present explicitly:

```sql
ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "PromotionRedemption_manual_intent_owner_pair"
  CHECK (
    ("manualPaymentIntentId" IS NULL AND "manualPaymentIntentUserId" IS NULL)
    OR
    ("manualPaymentIntentId" IS NOT NULL
      AND "manualPaymentIntentUserId" IS NOT NULL
      AND "manualPaymentIntentUserId" = "userId")
  );

ALTER TABLE "PromotionalAccessGrant"
  ADD CONSTRAINT "PromotionalAccessGrant_redemption_owner_promotion"
  CHECK (
    ("redemptionId" IS NULL AND "redemptionUserId" IS NULL AND "redemptionPromotionId" IS NULL)
    OR
    ("redemptionId" IS NOT NULL AND "redemptionUserId" IS NOT NULL AND "redemptionPromotionId" IS NOT NULL
      AND "redemptionUserId" = "userId"
      AND "redemptionPromotionId" = "promotionId")
  );

ALTER TABLE "PromotionLifecycleEvent"
  ADD CONSTRAINT "PromotionLifecycleEvent_redemption_owner_promotion"
  CHECK (
    ("redemptionId" IS NULL AND "redemptionUserId" IS NULL AND "redemptionPromotionId" IS NULL)
    OR
    ("redemptionId" IS NOT NULL AND "redemptionUserId" IS NOT NULL AND "redemptionPromotionId" IS NOT NULL
      AND "subjectUserId" IS NOT NULL
      AND "redemptionUserId" = "subjectUserId"
      AND "redemptionPromotionId" = "promotionId")
  );

ALTER TABLE "PromotionLifecycleEvent"
  ADD CONSTRAINT "PromotionLifecycleEvent_grant_owner_promotion"
  CHECK (
    ("accessGrantId" IS NULL AND "accessGrantUserId" IS NULL AND "accessGrantPromotionId" IS NULL)
    OR
    ("accessGrantId" IS NOT NULL AND "accessGrantUserId" IS NOT NULL AND "accessGrantPromotionId" IS NOT NULL
      AND "subjectUserId" IS NOT NULL
      AND "accessGrantUserId" = "subjectUserId"
      AND "accessGrantPromotionId" = "promotionId")
  );
```

The matching `@@unique` keys are present in the Prisma models, including the unique grant-side redemption tuple required because one redemption maps to at most one access grant. A migration must confirm Prisma-generated FK names before adding any SQL-only constraints, so it does not duplicate an FK.

## State and value checks

```sql
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_code_canonical"
  CHECK ("code" IS NULL OR ("code" = upper(btrim("code")) AND "code" ~ '^[A-Z0-9_-]{3,64}$')),
  ADD CONSTRAINT "Promotion_usage_limit_positive"
  CHECK ("usageLimit" IS NULL OR "usageLimit" > 0),
  ADD CONSTRAINT "Promotion_validity_order"
  CHECK ("expiresAt" IS NULL OR "expiresAt" > "startsAt"),
  ADD CONSTRAINT "Promotion_supported_plan_ids"
  CHECK ("eligiblePlanIds" <@ ARRAY['creator', 'pro', 'agency']::text[]),
  ADD CONSTRAINT "Promotion_supported_access_plan"
  CHECK ("accessPlanId" IS NULL OR "accessPlanId" IN ('creator', 'pro', 'agency')),
  ADD CONSTRAINT "Promotion_duration_bounds"
  CHECK ("durationDays" IS NULL OR "durationDays" BETWEEN 1 AND 30),
  ADD CONSTRAINT "Promotion_percentage_bounds"
  CHECK ("discountType" <> 'percentage' OR "discountValue" BETWEEN 1 AND 50),
  ADD CONSTRAINT "Promotion_fixed_discount_positive"
  CHECK ("discountType" <> 'fixed_amount' OR "discountValue" > 0);

-- Same-row field consistency by promotion type. IS TRUE makes UNKNOWN fail.
ALTER TABLE "Promotion"
  ADD CONSTRAINT "Promotion_type_fields"
  CHECK ((
    ("type" IN ('bonus_days', 'tier_access')
      AND "accessPlanId" IN ('creator', 'pro', 'agency') AND "durationDays" BETWEEN 1 AND 30
      AND "targetUserId" IS NOT NULL AND "code" IS NULL AND "discountType" IS NULL AND "discountValue" IS NULL
      AND cardinality("eligiblePlanIds") = 0 AND "usageLimit" IS NULL)
    OR ("type" = 'discount_coupon'
      AND "code" IS NOT NULL AND "discountType" IN ('percentage', 'fixed_amount') AND "discountValue" IS NOT NULL
      AND cardinality("eligiblePlanIds") > 0 AND "accessPlanId" IS NULL AND "durationDays" IS NULL)
    OR ("type" = 'free_access_coupon'
      AND "code" IS NOT NULL AND "discountType" IS NULL AND "discountValue" IS NULL
      AND "accessPlanId" IN ('creator', 'pro', 'agency') AND "durationDays" BETWEEN 1 AND 30
      AND cardinality("eligiblePlanIds") = 0)
  ) IS TRUE);

ALTER TABLE "PromotionRedemption"
  ADD CONSTRAINT "PromotionRedemption_discount_snapshot"
  CHECK ((
    ("planId" IS NULL AND "interval" IS NULL AND "listPricePaise" IS NULL
      AND "discountPaise" IS NULL AND "payablePaise" IS NULL AND "currency" IS NULL)
    OR
    ("planId" IN ('creator', 'pro', 'agency') AND "interval" IN ('weekly', 'monthly')
      AND "listPricePaise" > 0 AND "discountPaise" > 0 AND "payablePaise" > 0
      AND "currency" = 'INR'
      AND "payablePaise" = "listPricePaise" - "discountPaise"
      AND "discountPaise" <= floor("listPricePaise" * 0.5))
  ) IS TRUE),
  ADD CONSTRAINT "PromotionRedemption_released_timestamp"
  CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL));

ALTER TABLE "PromotionalAccessGrant"
  ADD CONSTRAINT "PromotionalAccessGrant_supported_plan"
  CHECK ("planId" IN ('creator', 'pro', 'agency')),
  ADD CONSTRAINT "PromotionalAccessGrant_duration_bounds"
  CHECK ("durationDays" BETWEEN 1 AND 30),
  ADD CONSTRAINT "PromotionalAccessGrant_period_state"
  CHECK ((
    ("status" = 'queued' AND "startsAt" IS NULL AND "expiresAt" IS NULL AND "activatedAt" IS NULL)
    OR
    ("status" IN ('active', 'expired') AND "startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL
      AND "activatedAt" IS NOT NULL AND "expiresAt" > "startsAt")
    OR
    ("status" = 'revoked' AND (
      ("startsAt" IS NULL AND "expiresAt" IS NULL AND "activatedAt" IS NULL)
      OR ("startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "activatedAt" IS NOT NULL AND "expiresAt" > "startsAt")
    ))
  ) IS TRUE),
  ADD CONSTRAINT "PromotionalAccessGrant_revoked_timestamp"
  CHECK (("status" = 'revoked') = ("revokedAt" IS NOT NULL));

-- No queued or active grant can overlap another live entitlement for one user.
CREATE UNIQUE INDEX "PromotionalAccessGrant_one_active_per_user"
  ON "PromotionalAccessGrant" ("userId") WHERE "status" = 'active';

-- A lifecycle event can point to at most one business target (redemption or grant).
ALTER TABLE "PromotionLifecycleEvent"
  ADD CONSTRAINT "PromotionLifecycleEvent_one_target"
  CHECK (NOT ("redemptionId" IS NOT NULL AND "accessGrantId" IS NOT NULL));
```

Notes:

- The redemption check ensures no negative or zero payable amount and caps all discounts at 50% of the stored list-price snapshot. Application code must additionally verify the snapshot against the authoritative plan catalog and compute percentage discounts using integer paise.
- Cross-table rules (whether a redemption/grant is consistent with its referenced Promotion type and eligible plans) cannot be ordinary `CHECK` constraints. Enforce them in the transactional repository; a trigger would be a separate design choice. The new `Promotion_type_fields` check covers only fields on the Promotion row itself.
- `PromotionRedemption_released_timestamp` assumes `releasedAt` is set exactly when status is `released`. If status transitions retain a release timestamp for audit reasons, revise this rule before migration.

## Uniqueness and indexes

Canonical code uniqueness is supplied by the Prisma `@unique` key after the uppercase/trim check. `PromotionLifecycleEvent.eventKey` is unique. `PromotionalAccessGrant.queueSequence` is globally unique and generated by PostgreSQL.

The per-user single-use coupon rule needs a partial index:

```sql
CREATE UNIQUE INDEX "PromotionRedemption_one_unreleased_use_per_user_key"
  ON "PromotionRedemption" ("promotionId", "userId")
  WHERE "status" IN ('reserved', 'redeemed', 'manual_review');
```

`released` rows remain as history but no longer hold the coupon slot. Reserved and manual-review rows count against `usageLimit`; release is allowed only after a provider-confirmed final failure/expiry, never after a timeout or ambiguous outcome. Redemption operations must lock the User row first, then the Promotion row, and count/insert in the same transaction; the index is the final race guard.

`PromotionalAccessGrant_one_active_per_user` enforces at most one grant with `status = 'active'` per user. Queue activation still must hold the user's row lock and recheck for current paid access and an active grant in the same transaction. This index does not itself prove that two timestamp ranges do not overlap if application code incorrectly marks an expired range active; lifecycle status and timestamp checks remain necessary.

The wide Prisma unique key `PromotionRedemption(id, userId, planId, interval, payablePaise)` was confirmed unnecessary: the primary key already uniquely identifies `id`, and no relation references that wider tuple. It has been removed from the Prisma model. The `@@unique([id, userId])` and `@@unique([id, userId, promotionId])` keys remain because composite relations reference them.

The Prisma models also declare lookup indexes for promotion validity, redemption usage/user history, grant queue/expiry, and lifecycle event history. Actual PostgreSQL locking behavior, generated FK names, migration SQL correctness, and constraint installation have not been tested against a database.
