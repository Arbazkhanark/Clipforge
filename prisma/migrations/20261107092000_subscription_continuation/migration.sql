-- Adds a durable, at-most-once audit row for extending an existing Razorpay subscription.
-- This migration is additive and review-only; do not apply it as part of local tests.
CREATE TYPE "SubscriptionContinuationStatus" AS ENUM ('reserved', 'applied', 'manual_review', 'skipped');

ALTER TABLE "Subscription"
  ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3),
  ADD CONSTRAINT "Subscription_id_razorpaySubscriptionId_key" UNIQUE ("id", "razorpaySubscriptionId");

CREATE TABLE "RazorpaySubscriptionContinuation" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "providerSubscriptionId" TEXT NOT NULL,
  "cycleEnd" TIMESTAMP(3) NOT NULL,
  "observedTotalCount" INTEGER NOT NULL,
  "observedPaidCount" INTEGER NOT NULL,
  "observedRemainingCount" INTEGER NOT NULL,
  "targetRemainingCount" INTEGER NOT NULL,
  "status" "SubscriptionContinuationStatus" NOT NULL DEFAULT 'reserved',
  "errorCategory" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "RazorpaySubscriptionContinuation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RazorpaySubscriptionContinuation_counts_check" CHECK (
    "observedTotalCount" > 0 AND "observedPaidCount" >= 0 AND
    "observedRemainingCount" >= 0 AND "targetRemainingCount" > 0
  ),
  CONSTRAINT "RazorpaySubscriptionContinuation_subscriptionId_providerSubscriptionId_fkey"
    FOREIGN KEY ("subscriptionId", "providerSubscriptionId")
    REFERENCES "Subscription"("id", "razorpaySubscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RazorpaySubscriptionContinuation_subscriptionId_cycleEnd_key"
  ON "RazorpaySubscriptionContinuation"("subscriptionId", "cycleEnd");
CREATE INDEX "RazorpaySubscriptionContinuation_status_createdAt_idx"
  ON "RazorpaySubscriptionContinuation"("status", "createdAt");
