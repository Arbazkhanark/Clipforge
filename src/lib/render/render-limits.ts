// Hard limits for one render. Plan resolution and monthly quotas are applied as well.
import { createHash } from "node:crypto";
import type { RenderSettings } from "./ffmpeg-command.ts";

export const MAX_SOURCE_DURATION_SECONDS = 180;
export const MAX_SOURCE_EDGE_PX = 3840;
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** Stop a render that runs longer than this. The temporary file is removed. */
export const MAX_RENDER_MS = 120_000;
/** How many renders this process will run at once, whichever plan the user is on. */
export const RENDER_PROCESS_LIMIT = 2;

export function sourceRenderProblems(media: { durationMs?: number | null; width?: number | null; height?: number | null; sizeBytes: number; validation?: "verified" | "incomplete" }): string[] {
  const problems: string[] = [];
  if (media.validation !== "verified") problems.push("This video has not been fully checked, so it cannot be rendered.");
  if (!(typeof media.durationMs === "number" && media.durationMs > 0)) problems.push("This video has no duration, so it cannot be rendered.");
  else if (media.durationMs > MAX_SOURCE_DURATION_SECONDS * 1000) problems.push(`Videos longer than ${MAX_SOURCE_DURATION_SECONDS} seconds cannot be rendered here.`);
  if (!(typeof media.width === "number" && typeof media.height === "number" && media.width > 0 && media.height > 0)) problems.push("This video has no picture size, so it cannot be rendered.");
  else if (media.width > MAX_SOURCE_EDGE_PX || media.height > MAX_SOURCE_EDGE_PX) problems.push("This video is larger than the renderer allows.");
  if (media.sizeBytes > MAX_SOURCE_BYTES) problems.push("This video is too large to render.");
  return problems;
}

/** Stable hash of the settings that change the picture. Same source and same hash means reuse the export. */
export function hashExportSettings(sourceMediaId: string, settings: RenderSettings, logoMediaId: string | null, backgroundMediaId: string | null): string {
  const body = JSON.stringify({
    sourceMediaId, aspect: settings.aspect, maxResolution: settings.maxResolution, background: settings.background,
    zoom: settings.zoom, offsetX: settings.offsetX, offsetY: settings.offsetY, border: settings.border,
    ...(settings.trim && (settings.trim.startSeconds !== 0 || settings.trim.endSeconds !== null) ? { trim: settings.trim } : {}),
    logo: settings.logo ?? null, logoMediaId, backgroundMediaId,
  });
  return createHash("sha256").update(body).digest("hex");
}
