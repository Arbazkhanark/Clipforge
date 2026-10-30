// Slows down password guessing. In-memory for now (resets on restart); a shared/database-backed version comes with real infrastructure.
export interface RateLimiter {
  /** Is this key currently allowed to try? */
  check(key: string, now: Date): { allowed: boolean; retryAfterSeconds: number };
  recordFailure(key: string, now: Date): void;
  reset(key: string): void;
}

export class InMemoryRateLimiter implements RateLimiter {
  private failures = new Map<string, { count: number; windowStart: number; lockedUntil: number }>();
  private maxFailures: number; private windowMs: number; private lockoutMs: number;
  constructor(maxFailures = 5, windowMs = 15 * 60_000, lockoutMs = 15 * 60_000) { this.maxFailures = maxFailures; this.windowMs = windowMs; this.lockoutMs = lockoutMs; }

  check(key: string, now: Date): { allowed: boolean; retryAfterSeconds: number } {
    const entry = this.failures.get(key);
    if (!entry || entry.lockedUntil <= now.getTime()) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now.getTime()) / 1000) };
  }
  recordFailure(key: string, now: Date): void {
    const t = now.getTime();
    let entry = this.failures.get(key);
    if (!entry || t - entry.windowStart > this.windowMs) entry = { count: 0, windowStart: t, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= this.maxFailures) { entry.lockedUntil = t + this.lockoutMs; entry.count = 0; entry.windowStart = t; }
    this.failures.set(key, entry);
  }
  reset(key: string): void { this.failures.delete(key); }
}
