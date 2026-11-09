-- Additive recurring Razorpay checkout persistence. Prepared only; do not apply without reviewed backup/rollout.
CREATE TYPE "RazorpaySubscriptionIntentStatus" AS ENUM (
  'creating', 'created', 'active', 'failed', 'manual_review', 'cancelled', 'expired'
);

ALTER TABLE "Subscription"
  ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX "Subscription_razorpaySubscriptionId_userId_planId_interval_key"
  ON "Subscription"("razorpaySubscriptionId", "userId", "planId", "interval");

CREATE TABLE "RazorpaySubscriptionIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerSubscriptionId" TEXT,
  "checkoutUrl" TEXT,
  "providerPlanId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "interval" "BillingInterval" NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "RazorpaySubscriptionIntentStatus" NOT NULL DEFAULT 'creating',
  "errorCategory" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RazorpaySubscriptionIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RazorpaySubscriptionIntent_amount_positive" CHECK ("amountPaise" > 0),
  CONSTRAINT "RazorpaySubscriptionIntent_plan_price" CHECK (
    ("planId" = 'creator' AND "interval" = 'weekly' AND "amountPaise" = 49900) OR
    ("planId" = 'creator' AND "interval" = 'monthly' AND "amountPaise" = 199900) OR
    ("planId" = 'pro' AND "interval" = 'weekly' AND "amountPaise" = 99900) OR
    ("planId" = 'pro' AND "interval" = 'monthly' AND "amountPaise" = 399900) OR
    ("planId" = 'agency' AND "interval" = 'weekly' AND "amountPaise" = 149900) OR
    ("planId" = 'agency' AND "interval" = 'monthly' AND "amountPaise" = 599900)
  ),
  CONSTRAINT "RazorpaySubscriptionIntent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RazorpaySubscriptionIntent_userId_idempotencyKey_key"
  ON "RazorpaySubscriptionIntent"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "RazorpaySubscriptionIntent_providerSubscriptionId_key"
  ON "RazorpaySubscriptionIntent"("providerSubscriptionId");
CREATE UNIQUE INDEX "RazorpaySubscriptionIntent_id_userId_key"
  ON "RazorpaySubscriptionIntent"("id", "userId");
CREATE UNIQUE INDEX "RazorpaySubscriptionIntent_providerSubscriptionId_userId_planId_interval_key"
  ON "RazorpaySubscriptionIntent"("providerSubscriptionId", "userId", "planId", "interval");
CREATE INDEX "RazorpaySubscriptionIntent_userId_status_createdAt_idx"
  ON "RazorpaySubscriptionIntent"("userId", "status", "createdAt");
CREATE INDEX "RazorpaySubscriptionIntent_status_createdAt_idx"
  ON "RazorpaySubscriptionIntent"("status", "createdAt");

-- Preserve existing provider subscriptions while marking their missing checkout linkage for manual reconciliation.
-- This does not assert that the historical provider plan/amount has been verified.
INSERT INTO "RazorpaySubscriptionIntent" (
  "id", "userId", "idempotencyKey", "providerSubscriptionId", "checkoutUrl", "providerPlanId",
  "planId", "interval", "amountPaise", "currency", "status", "errorCategory", "createdAt", "updatedAt"
)
SELECT
  'legacy_' || s."id", s."userId", 'legacy_' || s."id", s."razorpaySubscriptionId", NULL, 'legacy_unverified',
  s."planId", s."interval",
  CASE s."planId"
    WHEN 'creator' THEN CASE s."interval" WHEN 'weekly' THEN 49900 WHEN 'monthly' THEN 199900 END
    WHEN 'pro' THEN CASE s."interval" WHEN 'weekly' THEN 99900 WHEN 'monthly' THEN 399900 END
    WHEN 'agency' THEN CASE s."interval" WHEN 'weekly' THEN 149900 WHEN 'monthly' THEN 599900 END
    ELSE NULL
  END,
  'INR', 'manual_review', 'legacy_subscription_unverified', s."createdAt", CURRENT_TIMESTAMP
FROM "Subscription" s
WHERE s."razorpaySubscriptionId" IS NOT NULL;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_checkoutIntent_fkey"
  FOREIGN KEY ("razorpaySubscriptionId", "userId", "planId", "interval")
  REFERENCES "RazorpaySubscriptionIntent"("providerSubscriptionId", "userId", "planId", "interval")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentRecord"
  ADD COLUMN "subscriptionIntentId" TEXT,
  ADD COLUMN "providerSubscriptionId" TEXT;
CREATE INDEX "PaymentRecord_subscriptionIntentId_idx"
  ON "PaymentRecord"("subscriptionIntentId");
ALTER TABLE "PaymentRecord"
  ADD CONSTRAINT "PaymentRecord_subscriptionIntentId_userId_fkey"
    FOREIGN KEY ("subscriptionIntentId", "userId") REFERENCES "RazorpaySubscriptionIntent"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
