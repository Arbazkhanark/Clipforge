-- Add a dedicated durable queue kind for post-upload media verification.
-- Existing ProcessingJob columns and indexes persist stage, retry, and lease state.
ALTER TYPE "JobKind" ADD VALUE 'media_verification';
