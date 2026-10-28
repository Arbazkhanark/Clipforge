// Server-side limit checks. API routes must call these - never trust the browser.
import { getPlan, type PlanDefinition } from "./catalog.ts";

export type LimitName = keyof PlanDefinition["limits"];

export interface LimitCheckResult {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  message: string;
}

/** Can this user consume `requested` more units of `limitName`? */
export function checkLimit(planId: string, limitName: LimitName, used: number, requested = 1): LimitCheckResult {
  if (![used, requested].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new RangeError("used and requested must be non-negative numbers");
  }
  const limit = getPlan(planId).limits[limitName];
  const remaining = Math.max(0, limit - used);
  const allowed = used + requested <= limit;
  return {
    allowed, limit, used, remaining,
    message: allowed
      ? "Within plan limit."
      : `Your plan allows ${limit} for ${limitName}; you have used ${used} and requested ${requested} more.`,
  };
}
