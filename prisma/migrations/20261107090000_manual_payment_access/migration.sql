-- Additive, review-only migration for non-recurring paid access periods.
-- Prepared only; do not apply until the existing recurring billing migration is reviewed/applied.
CREATE TYPE "ManualPaymentIntentStatus" AS ENUM (
  'creating', 'created', 'paid', 'failed', 'expired', 'manual_review'
);

CREATE TABLE "ManualPaymentIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "providerPaymentLinkId" TEXT,
  "checkoutUrl" TEXT,
  "planId" TEXT NOT NULL,
  "interval" "BillingInterval" NOT NULL,
  "amountPaise" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" "ManualPaymentIntentStatus" NOT NULL DEFAULT 'creating',
  "accessStartsAt" TIMESTAMP(3),
  "accessEndsAt" TIMESTAMP(3),
  "errorCategory" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualPaymentIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualPaymentIntent_amount_positive" CHECK ("amountPaise" > 0),
  CONSTRAINT "ManualPaymentIntent_plan_price" CHECK (
    ("planId" = 'creator' AND "interval" = 'weekly' AND "amountPaise" = 49900) OR
    ("planId" = 'creator' AND "interval" = 'monthly' AND "amountPaise" = 199900) OR
    ("planId" = 'pro' AND "interval" = 'weekly' AND "amountPaise" = 99900) OR
    ("planId" = 'pro' AND "interval" = 'monthly' AND "amountPaise" = 399900) OR
    ("planId" = 'agency' AND "interval" = 'weekly' AND "amountPaise" = 149900) OR
    ("planId" = 'agency' AND "interval" = 'monthly' AND "amountPaise" = 599900)
  ),
  CONSTRAINT "ManualPaymentIntent_period_order" CHECK ("accessStartsAt" IS NULL OR "accessEndsAt" IS NULL OR "accessEndsAt" > "accessStartsAt"),
  CONSTRAINT "ManualPaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManualPaymentIntent_id_userId_key" ON "ManualPaymentIntent"("id", "userId");
CREATE UNIQUE INDEX "ManualPaymentIntent_userId_idempotencyKey_key" ON "ManualPaymentIntent"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "ManualPaymentIntent_providerPaymentLinkId_key" ON "ManualPaymentIntent"("providerPaymentLinkId");
CREATE INDEX "ManualPaymentIntent_userId_status_createdAt_idx" ON "ManualPaymentIntent"("userId", "status", "createdAt");

ALTER TABLE "PaymentRecord" ADD COLUMN "manualPaymentIntentId" TEXT;
CREATE INDEX "PaymentRecord_manualPaymentIntentId_idx" ON "PaymentRecord"("manualPaymentIntentId");
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_manualPaymentIntentId_userId_fkey"
  FOREIGN KEY ("manualPaymentIntentId", "userId") REFERENCES "ManualPaymentIntent"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_single_billing_intent"
  CHECK (num_nonnulls("subscriptionIntentId", "manualPaymentIntentId") <= 1);

CREATE TABLE "ManualPlanAccess" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "providerPaymentId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualPlanAccess_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualPlanAccess_plan_supported" CHECK ("planId" IN ('creator', 'pro', 'agency')),
  CONSTRAINT "ManualPlanAccess_period_order" CHECK ("expiresAt" > "startsAt"),
  CONSTRAINT "ManualPlanAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ManualPlanAccess_intentId_userId_fkey" FOREIGN KEY ("intentId", "userId") REFERENCES "ManualPaymentIntent"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManualPlanAccess_intentId_key" ON "ManualPlanAccess"("intentId");
CREATE UNIQUE INDEX "ManualPlanAccess_intentId_userId_key" ON "ManualPlanAccess"("intentId", "userId");
CREATE UNIQUE INDEX "ManualPlanAccess_providerPaymentId_key" ON "ManualPlanAccess"("providerPaymentId");
CREATE INDEX "ManualPlanAccess_userId_expiresAt_idx" ON "ManualPlanAccess"("userId", "expiresAt");
