-- Preserve affirmative auto-renew consent for future recurring checkout attempts.
-- Prepared only; do not apply without separate database approval.
ALTER TABLE "RazorpaySubscriptionIntent"
  ADD COLUMN "autoRenewConsentAt" TIMESTAMP(3),
  ADD COLUMN "autoRenewConsentVersion" TEXT;
