import type { CoverSupport } from "../lib/domain/caption-cover-updates.ts";
import type { MediaProbe } from "./storage/media-inspection.ts";
import type { MediaStorage } from "./storage/media-storage.ts";
import { notAuthenticated } from "./errors.ts";
import type { Repository } from "./repository.ts";

export interface MediaServices {
  storage: MediaStorage;
  /** null when ffprobe is not installed: uploads are then accepted by file signature only and marked "incomplete". */
  probe: MediaProbe | null;
  /** A technical limit for one upload in this development build (NOT a plan entitlement). */
  maxUploadBytes: number;
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
}

export function requireUser(ctx: RequestContext): string {
  if (ctx.userId === null || ctx.userId === "") throw notAuthenticated();
  return ctx.userId;
}
