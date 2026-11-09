import type { CoverSupport } from "../lib/domain/caption-cover-updates.ts";
import type { MediaProbe, ThumbnailMaker } from "./storage/media-inspection.ts";
import type { MediaStorage } from "./storage/media-storage.ts";
import type { TemporaryMediaAccessAdapter } from "./storage/temporary-media-access.ts";
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
  /** Optional trusted server adapter. Missing in current runtimes; never sent to browser code. */
  publishingMediaAccess?: TemporaryMediaAccessAdapter;
  /** Present when this process can execute renders; durable job state is stored through repo. */
  renders?: RenderScheduler;
  /** Durable import requests are enabled only when both persistence and private storage are configured. */
  durableMediaImports?: boolean;
}

export function requireUser(ctx: RequestContext): string {
  if (ctx.userId === null || ctx.userId === "") throw notAuthenticated();
  return ctx.userId;
}
