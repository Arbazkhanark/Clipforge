-- Collection-owned publishing defaults and per-video settings. Existing records
-- safely default to individual mode with no caption or cover.
CREATE TYPE "CollectionSettingMode" AS ENUM ('individual', 'shared');

ALTER TABLE "VideoCollection"
  ADD COLUMN "captionMode" "CollectionSettingMode" NOT NULL DEFAULT 'individual',
  ADD COLUMN "sharedCaptionText" TEXT,
  ADD COLUMN "coverMode" "CollectionSettingMode" NOT NULL DEFAULT 'individual',
  ADD COLUMN "sharedCoverMediaId" TEXT,
  ADD COLUMN "settingsVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "CollectionItem"
  ADD COLUMN "captionText" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "coverMediaId" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "VideoCollection"
  ADD CONSTRAINT "VideoCollection_settingsVersion_check" CHECK ("settingsVersion" >= 1),
  ADD CONSTRAINT "VideoCollection_sharedCoverMediaId_fkey" FOREIGN KEY ("sharedCoverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CollectionItem"
  ADD CONSTRAINT "CollectionItem_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "CollectionItem_coverMediaId_fkey" FOREIGN KEY ("coverMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "VideoCollection_sharedCoverMediaId_idx" ON "VideoCollection"("sharedCoverMediaId");
CREATE INDEX "CollectionItem_coverMediaId_idx" ON "CollectionItem"("coverMediaId");
