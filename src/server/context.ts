import type { CoverSupport } from "../lib/domain/caption-cover-updates.ts";
import type { MediaProbe, ThumbnailMaker } from "./storage/media-inspection.ts";
import type { MediaStorage } from "./storage/media-storage.ts";
import { notAuthenticated } from "./errors.ts";
import type { RenderScheduler } from "./render/export-service.ts";
import type { Repository } from "./repository.ts";

export interface MediaServices {
  storage: MediaStorage;
  /** null when ffprobe is not installed: uploads are then accepted by file signature only and marked "incomplete". */
  probe: MediaProbe | null;
  /** Makes a small JPEG preview image, or null when ffmpeg is not installed (uploads then have no thumbnail). */
  thumbnail?: ThumbnailMaker | null;
  /** A technical limit for one upload in this development build (NOT a plan entitlement). */
  maxUploadBytes: number;
  /** Set when database mode cannot use the private folder. Callers must not save the file in memory instead. */
  unavailable?: string;
}

/** Everything a handler needs. `userId` comes from the verified session on the server - NEVER from the request body. */
export interface RequestContext {
  userId: string | null;
  now: Date;
  repo: Repository;
  newId: () => string;
  config: { coverSupport: CoverSupport };
  /** Missing when no storage is configured: upload handlers then answer 503. */
  media?: MediaServices;
  /** Present when this process can queue renders. The queue itself does not survive a restart. */
  renders?: RenderScheduler;
}

export function requireUser(ctx: RequestContext): string {
  if (ctx.userId === null || ctx.userId === "") throw notAuthenticated();
  return ctx.userId;
}
