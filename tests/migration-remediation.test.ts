import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../prisma/migrations/20261111100000_production_migration_audit_corrections/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("corrective migration enforces one promotion redemption per user across released status without deleting history", () => {
  assert.match(migration, /GROUP BY\s+"promotionId",\s*"userId"[\s\S]*HAVING count\(\*\) > 1[\s\S]*RAISE EXCEPTION/);
  assert.match(migration, /DROP INDEX IF EXISTS public\."PromotionRedemption_one_unreleased_use_per_user_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "PromotionRedemption_promotionId_userId_key"\s+ON public\."PromotionRedemption" \("promotionId", "userId"\)/);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+public\."PromotionRedemption"/i);
  assert.match(schema, /@@unique\(\[promotionId, userId\]\)/);
});

test("promotion trigger functions are invoker-only, use a fixed safe search path, and qualify protected objects", () => {
  const functions = [...migration.matchAll(/CREATE(?: OR REPLACE)? FUNCTION (public\.clipforge_[\s\S]*?)\$function\$;/g)];
  assert.equal(functions.length, 5);
  for (const [, sql] of functions) {
    assert.match(sql!, /SECURITY INVOKER/);
    assert.match(sql!, /SET search_path = pg_catalog, public, pg_temp/);
    assert.doesNotMatch(sql!, /SECURITY DEFINER/);
  }
  assert.match(migration, /FROM public\."ManualPaymentIntent"/);
  assert.match(migration, /FROM public\."PromotionRedemption" AS redemption\s+JOIN public\."Promotion" AS promotion/);
  assert.match(migration, /PERFORM public\.clipforge_assert_discounted_manual_intent/);
  assert.match(migration, /BEFORE INSERT ON public\."PromotionRedemption"/);
  assert.match(migration, /BEFORE INSERT ON public\."PromotionalAccessGrant"/);
});

test("reason changes require a deferred matching lifecycle event and Admin audit row", () => {
  assert.match(migration, /CREATE FUNCTION public\.clipforge_require_promotion_reason_audit\(\)[\s\S]*SECURITY INVOKER[\s\S]*SET search_path = pg_catalog, public, pg_temp/);
  assert.match(migration, /JOIN public\."User" AS actor[\s\S]*actor\."role" = 'admin'::public\."UserRole"/);
  assert.match(migration, /JOIN public\."AuditLog" AS audit[\s\S]*audit\."action" = 'promotion\.promotion_updated'[\s\S]*audit\."metadata" ->> 'eventKey' = event\."eventKey"/);
  assert.match(migration, /event\."occurredAt" = NEW\."updatedAt"/);
  assert.match(migration, /reasonOld[\s\S]*reasonNew[\s\S]*COALESCE\(to_jsonb\(OLD\."reason"\), 'null'::jsonb\)[\s\S]*COALESCE\(to_jsonb\(NEW\."reason"\), 'null'::jsonb\)/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "Promotion_reason_requires_audit"[\s\S]*AFTER UPDATE ON public\."Promotion"[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*WHEN \(OLD\."reason" IS DISTINCT FROM NEW\."reason"\)/);
});

test("used promotion terms are guarded while status, reason, and timestamps remain outside the immutable tuple", () => {
  assert.match(migration, /CREATE TRIGGER "Promotion_used_terms_immutable"[\s\S]*BEFORE UPDATE ON public\."Promotion"/);
  const guardedTuple = migration.match(/IF ROW\(([\s\S]*?)\) IS DISTINCT FROM ROW\(([\s\S]*?)\) AND/);
  assert.ok(guardedTuple);
  for (const field of ["id", "type", "code", "discountType", "discountValue", "accessPlanId", "durationDays", "eligiblePlanIds", "targetUserId", "startsAt", "expiresAt", "usageLimit", "createdByAdminId", "createdAt"]) {
    assert.ok(guardedTuple[1]!.includes(`OLD."${field}"`), `${field} is protected`);
    assert.ok(guardedTuple[2]!.includes(`NEW."${field}"`), `${field} is protected`);
  }
  assert.doesNotMatch(guardedTuple[1]!, /reason|status|updatedAt/);
});

test("historical publishing success without a verified media ID is preserved as manual review, not published", () => {
  assert.match(migration, /UPDATE public\."PublishingJob"[\s\S]*SET "stage" = 'needs_manual_review'::public\."PublishingJobStage"/);
  assert.match(migration, /WHERE "outcome" = 'success'[\s\S]*"stage" = 'published'[\s\S]*"instagramMediaId" IS NULL/);
  assert.match(migration, /UPDATE public\."CycleItem" AS item[\s\S]*SET "status" = 'needs_review'::public\."CycleItemStatus"/);
  assert.match(migration, /AND NOT EXISTS \([\s\S]*FROM public\."PublishingJob" AS verified[\s\S]*verified\."outcome" = 'success'[\s\S]*verified\."stage" = 'published'[\s\S]*verified\."instagramMediaId" IS NOT NULL[\s\S]*\);/);
  assert.doesNotMatch(migration, /SET\s+"outcome"\s*=/);
  assert.doesNotMatch(migration, /SET\s+"instagramMediaId"\s*=/);
});

test("Razorpay historical catalog snapshots become nullable only for marked manual-review legacy rows", () => {
  assert.match(schema, /model RazorpaySubscriptionIntent \{[\s\S]*amountPaise\s+Int\?/);
  assert.match(migration, /ALTER COLUMN "amountPaise" DROP NOT NULL/);
  assert.match(migration, /SET "amountPaise" = NULL[\s\S]*"providerPlanId" = 'legacy_unverified'[\s\S]*"status" = 'manual_review'[\s\S]*"errorCategory" = 'legacy_subscription_unverified'/);
  const legacyNulling = migration.match(/UPDATE public\."RazorpaySubscriptionIntent" AS intent[\s\S]*?;/)?.[0];
  assert.ok(legacyNulling);
  assert.doesNotMatch(legacyNulling!, /CASE|pricePaise/i, "legacy amounts are not classified by comparing against current prices");
  assert.match(migration, /"amountPaise" IS NULL AND "status" = 'manual_review' AND\s+"errorCategory" = 'legacy_subscription_unverified'/);
  assert.doesNotMatch(migration, /SET "amountPaise" = CASE/i);
});
