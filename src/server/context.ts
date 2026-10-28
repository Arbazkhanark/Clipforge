import type { CoverSupport } from "../lib/domain/caption-cover-updates.ts";
import { notAuthenticated } from "./errors.ts";
import type { Repository } from "./repository.ts";

/** Everything a handler needs. `userId` comes from the verified session on the server - NEVER from the request body. */
export interface RequestContext {
  userId: string | null;
  now: Date;
  repo: Repository;
  newId: () => string;
  config: { coverSupport: CoverSupport };
}

export function requireUser(ctx: RequestContext): string {
  if (ctx.userId === null || ctx.userId === "") throw notAuthenticated();
  return ctx.userId;
}
