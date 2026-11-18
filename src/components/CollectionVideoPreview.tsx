"use client";

import type { MediaCard } from "../server/queries.ts";
import { MediaThumbnail } from "./MediaThumbnail.tsx";

/** Plays the exact completed render for the current saved settings when one exists. */
export function CollectionVideoPreview({ media }: { media: MediaCard }) {
  const templateLabel = media.templateDetailsAvailable
    ? media.matchingTemplateName
      ? `Template: ${media.matchingTemplateName}`
      : media.hasSavedEditorSettings
        ? "Custom settings"
        : "No template applied"
    : "Template details unavailable";

  return (
    <div className="collection-video-player-wrap">
      {media.kind === "video" && media.canPlayPreview ? (
        <video
          className="collection-video-player"
          controls
          playsInline
          preload="none"
          poster={media.hasThumbnail ? `/api/media/file?id=${encodeURIComponent(media.id)}&variant=thumbnail` : undefined}
          src={media.renderedPreviewId
            ? `/api/renders/preview?id=${encodeURIComponent(media.renderedPreviewId)}`
            : `/api/media/file?id=${encodeURIComponent(media.id)}&variant=preview`}
          aria-label={`${media.renderedPreviewId ? "Edited" : "Original"} video: ${media.title}`}
        />
      ) : (
        <div className="collection-video-preview-fallback">
          <MediaThumbnail media={media} />
          {media.kind === "video" && !media.canPlayPreview && <span className="collection-video-playback-note">Playback is not included in this collection’s permissions.</span>}
        </div>
      )}
      <div className="collection-video-preview-meta">
        <span className="collection-video-template-label">{templateLabel}</span>
        {media.kind === "video" && media.canPlayPreview && (
          <span className="collection-video-source-label">
            {media.renderedPreviewId ? "Edited export" : media.hasSavedEditorSettings ? "Original · no matching export yet" : "Original upload"}
          </span>
        )}
      </div>
    </div>
  );
}
