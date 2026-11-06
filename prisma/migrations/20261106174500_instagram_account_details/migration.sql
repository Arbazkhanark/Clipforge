-- Account type and granted permission names for an Instagram connection.
-- These columns hold no access token. encryptedAccessToken already exists.
-- This migration is not applied by the Phase 9 work.

ALTER TABLE "SocialAccount" ADD COLUMN "accountType" TEXT;
ALTER TABLE "SocialAccount" ADD COLUMN "grantedScopes" TEXT;
