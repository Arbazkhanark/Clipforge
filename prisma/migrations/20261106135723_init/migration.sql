-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('video', 'image');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('active', 'pending_deletion', 'deleted');

-- CreateEnum
CREATE TYPE "DerivativeKind" AS ENUM ('thumbnail', 'render', 'compressed');

-- CreateEnum
CREATE TYPE "CollectionVisibility" AS ENUM ('private', 'link', 'public_view');

-- CreateEnum
CREATE TYPE "Capability" AS ENUM ('view', 'use_in_cycle', 'import_copy', 'download', 'manage');

-- CreateEnum
CREATE TYPE "GrantStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('pending', 'copying', 'verifying', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('draft', 'running', 'paused', 'stopped', 'completed');

-- CreateEnum
CREATE TYPE "CycleItemStatus" AS ENUM ('upcoming', 'scheduled', 'processing', 'publishing', 'published', 'needs_review', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('owned', 'shared_reference', 'imported_copy');

-- CreateEnum
CREATE TYPE "CaptionSource" AS ENUM ('none', 'individual', 'bulk');

-- CreateEnum
CREATE TYPE "CoverState" AS ENUM ('none', 'saved_internally', 'applied_on_instagram');

-- CreateEnum
CREATE TYPE "CaptionChangeSource" AS ENUM ('bulk', 'individual');

-- CreateEnum
CREATE TYPE "RepeatBehavior" AS ENUM ('never', 'ask', 'automatic');

-- CreateEnum
CREATE TYPE "OrderMode" AS ENUM ('manual', 'upload_order', 'oldest_first', 'newest_first', 'smallest_first', 'largest_first', 'shuffle');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('render', 'thumbnail', 'import', 'cleanup');

-- CreateEnum
CREATE TYPE "PublishOutcome" AS ENUM ('in_progress', 'success', 'definite_failure', 'ambiguous');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('instagram', 'youtube_shorts', 'tiktok');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('connected', 'token_expired', 'revoked', 'disconnected');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('weekly', 'monthly');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('storage_bytes', 'processing_seconds', 'exports', 'scheduled_items');

-- CreateEnum
CREATE TYPE "AuthTokenKind" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processed', 'failed', 'ignored');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AuthTokenKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'created',
    "razorpaySubscriptionId" TEXT,
    "lastEventAt" BIGINT NOT NULL DEFAULT 0,
    "trialEndsAt" BIGINT,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "username" TEXT,
    "encryptedAccessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'connected',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'active',
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "durationMs" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "checksumSha256" TEXT,
    "thumbnailKey" TEXT,
    "metadataValidated" BOOLEAN NOT NULL DEFAULT false,
    "deleteAfter" TIMESTAMP(3),
    "importedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaDerivative" (
    "id" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "DerivativeKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "settingsHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaDerivative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoCollection" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "CollectionVisibility" NOT NULL DEFAULT 'private',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionItem" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionShareLink" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "capabilities" "Capability"[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionAccessRequest" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requestedCapabilities" "Capability"[],
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'pending',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionPermission" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "capabilities" "Capability"[],
    "status" "GrantStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaImportJob" (
    "id" TEXT NOT NULL,
    "importerId" TEXT NOT NULL,
    "sourceMediaId" TEXT NOT NULL,
    "sourceCollectionId" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "newObjectKey" TEXT,
    "resultMediaAssetId" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditingTemplate" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingCycle" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CycleStatus" NOT NULL DEFAULT 'draft',
    "finalReviewConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "orderMode" "OrderMode" NOT NULL DEFAULT 'manual',
    "repeatBehavior" "RepeatBehavior" NOT NULL DEFAULT 'never',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "scheduleSettings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleItem" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "cycleOwnerId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "sourceKind" "SourceKind" NOT NULL,
    "sourceCollectionId" TEXT,
    "status" "CycleItemStatus" NOT NULL DEFAULT 'upcoming',
    "position" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scheduledFor" TIMESTAMP(3),
    "editingSettings" JSONB,
    "templateId" TEXT,
    "captionText" TEXT NOT NULL DEFAULT '',
    "captionSource" "CaptionSource" NOT NULL DEFAULT 'none',
    "coverMediaId" TEXT,
    "coverIsCustom" BOOLEAN NOT NULL DEFAULT false,
    "coverState" "CoverState" NOT NULL DEFAULT 'none',
    "lockedBy" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "externalPostId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptionRevision" (
    "id" TEXT NOT NULL,
    "cycleItemId" TEXT NOT NULL,
    "previousText" TEXT NOT NULL,
    "newText" TEXT NOT NULL,
    "source" "CaptionChangeSource" NOT NULL,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaptionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverImageSelection" (
    "id" TEXT NOT NULL,
    "cycleItemId" TEXT NOT NULL,
    "previousCoverId" TEXT,
    "newCoverId" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverImageSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "cycleItemId" TEXT,
    "mediaAssetId" TEXT,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "lockedBy" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" TEXT NOT NULL,
    "cycleItemId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "outcome" "PublishOutcome" NOT NULL DEFAULT 'in_progress',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "amount" BIGINT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_kind_idx" ON "AuthToken"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_razorpaySubscriptionId_key" ON "Subscription"("razorpaySubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_key" ON "WebhookEvent"("providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecord_providerPaymentId_key" ON "PaymentRecord"("providerPaymentId");

-- CreateIndex
CREATE INDEX "PaymentRecord_userId_createdAt_idx" ON "PaymentRecord"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_userId_platform_externalAccountId_key" ON "SocialAccount"("userId", "platform", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_status_createdAt_idx" ON "MediaAsset"("ownerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_status_deleteAfter_idx" ON "MediaAsset"("status", "deleteAfter");

-- CreateIndex
CREATE UNIQUE INDEX "MediaDerivative_storageKey_key" ON "MediaDerivative"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaDerivative_mediaAssetId_ownerId_kind_settingsHash_key" ON "MediaDerivative"("mediaAssetId", "ownerId", "kind", "settingsHash");

-- CreateIndex
CREATE INDEX "VideoCollection_ownerId_archived_idx" ON "VideoCollection"("ownerId", "archived");

-- CreateIndex
CREATE INDEX "CollectionItem_collectionId_position_idx" ON "CollectionItem"("collectionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionItem_collectionId_mediaAssetId_key" ON "CollectionItem"("collectionId", "mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionShareLink_tokenHash_key" ON "CollectionShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "CollectionAccessRequest_collectionId_status_idx" ON "CollectionAccessRequest"("collectionId", "status");

-- CreateIndex
CREATE INDEX "CollectionPermission_granteeId_status_idx" ON "CollectionPermission"("granteeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionPermission_collectionId_granteeId_key" ON "CollectionPermission"("collectionId", "granteeId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaImportJob_idempotencyKey_key" ON "MediaImportJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaImportJob_resultMediaAssetId_key" ON "MediaImportJob"("resultMediaAssetId");

-- CreateIndex
CREATE INDEX "MediaImportJob_sourceMediaId_status_idx" ON "MediaImportJob"("sourceMediaId", "status");

-- CreateIndex
CREATE INDEX "EditingTemplate_ownerId_idx" ON "EditingTemplate"("ownerId");

-- CreateIndex
CREATE INDEX "PublishingCycle_ownerId_status_idx" ON "PublishingCycle"("ownerId", "status");

-- CreateIndex
CREATE INDEX "CycleItem_status_scheduledFor_idx" ON "CycleItem"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "CycleItem_cycleId_status_position_idx" ON "CycleItem"("cycleId", "status", "position");

-- CreateIndex
CREATE INDEX "CycleItem_mediaAssetId_status_idx" ON "CycleItem"("mediaAssetId", "status");

-- CreateIndex
CREATE INDEX "CaptionRevision_cycleItemId_changedAt_idx" ON "CaptionRevision"("cycleItemId", "changedAt");

-- CreateIndex
CREATE INDEX "CoverImageSelection_cycleItemId_changedAt_idx" ON "CoverImageSelection"("cycleItemId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_idempotencyKey_key" ON "ProcessingJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_createdAt_idx" ON "ProcessingJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_idempotencyKey_key" ON "PublishingJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_cycleItemId_attemptNumber_key" ON "PublishingJob"("cycleItemId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_idempotencyKey_key" ON "UsageRecord"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_kind_periodStart_idx" ON "UsageRecord"("userId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_importedFromId_fkey" FOREIGN KEY ("importedFromId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaDerivative" ADD CONSTRAINT "MediaDerivative_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoCollection" ADD CONSTRAINT "VideoCollection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VideoCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionItem" ADD CONSTRAINT "CollectionItem_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionShareLink" ADD CONSTRAINT "CollectionShareLink_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VideoCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAccessRequest" ADD CONSTRAINT "CollectionAccessRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VideoCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionAccessRequest" ADD CONSTRAINT "CollectionAccessRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPermission" ADD CONSTRAINT "CollectionPermission_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "VideoCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionPermission" ADD CONSTRAINT "CollectionPermission_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaImportJob" ADD CONSTRAINT "MediaImportJob_importerId_fkey" FOREIGN KEY ("importerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaImportJob" ADD CONSTRAINT "MediaImportJob_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditingTemplate" ADD CONSTRAINT "EditingTemplate_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingCycle" ADD CONSTRAINT "PublishingCycle_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingCycle" ADD CONSTRAINT "PublishingCycle_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleItem" ADD CONSTRAINT "CycleItem_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PublishingCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleItem" ADD CONSTRAINT "CycleItem_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleItem" ADD CONSTRAINT "CycleItem_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptionRevision" ADD CONSTRAINT "CaptionRevision_cycleItemId_fkey" FOREIGN KEY ("cycleItemId") REFERENCES "CycleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverImageSelection" ADD CONSTRAINT "CoverImageSelection_cycleItemId_fkey" FOREIGN KEY ("cycleItemId") REFERENCES "CycleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_cycleItemId_fkey" FOREIGN KEY ("cycleItemId") REFERENCES "CycleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_cycleItemId_fkey" FOREIGN KEY ("cycleItemId") REFERENCES "CycleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
