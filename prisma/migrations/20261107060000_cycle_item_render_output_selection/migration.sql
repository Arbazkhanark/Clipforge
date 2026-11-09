-- Explicitly selected rendered publishing media. Existing CycleItems remain unselected.
-- The nullable columns deliberately have no backfill: no historical render is selected implicitly.
CREATE UNIQUE INDEX "MediaDerivative_id_ownerId_mediaAssetId_key"
  ON "MediaDerivative"("id", "ownerId", "mediaAssetId");

ALTER TABLE "CycleItem"
  ADD COLUMN "selectedRenderOutputId" TEXT,
  ADD COLUMN "selectedRenderOwnerId" TEXT,
  ADD COLUMN "selectedRenderSourceMediaId" TEXT;

ALTER TABLE "CycleItem"
  ADD CONSTRAINT "CycleItem_selected_render_output_matches_item_check"
  CHECK (
    ("selectedRenderOutputId" IS NULL AND "selectedRenderOwnerId" IS NULL AND "selectedRenderSourceMediaId" IS NULL)
    OR (
      "selectedRenderOutputId" IS NOT NULL
      AND "selectedRenderOwnerId" = "cycleOwnerId"
      AND "selectedRenderSourceMediaId" = "mediaAssetId"
    )
  ),
  ADD CONSTRAINT "CycleItem_selectedRenderOutput_fkey"
  FOREIGN KEY ("selectedRenderOutputId", "selectedRenderOwnerId", "selectedRenderSourceMediaId")
  REFERENCES "MediaDerivative"("id", "ownerId", "mediaAssetId")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "CycleItem_selectedRenderOutputId_idx" ON "CycleItem"("selectedRenderOutputId");
