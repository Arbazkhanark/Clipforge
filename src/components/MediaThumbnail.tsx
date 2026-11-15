"use client";

import { useEffect, useState } from "react";

export function MediaThumbnail({ media }: { media: { id: string; hasThumbnail: boolean; kind?: "video" | "image" } }) {
  const variant = media.hasThumbnail ? "thumbnail" : media.kind === "image" ? "preview" : null;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media.id, variant]);

  if (variant && !failed) {
    return <img className="media-thumbnail-image" src={`/api/media/file?id=${encodeURIComponent(media.id)}&variant=${variant}`} alt="" width={80} loading="lazy" onError={() => setFailed(true)} />;
  }
  return <span className="media-no-preview">{media.kind === "image" ? "Image preview unavailable" : "Preview unavailable; original unchanged"}</span>;
}
