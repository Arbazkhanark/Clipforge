import { randomUUID } from "node:crypto";
import { hashToken } from "../auth/tokens.ts";
import type { AuthRepository } from "../auth/auth-repository.ts";

export interface InstagramOAuthStateStore {
  issue(state: string, userId: string, now: Date): Promise<void>;
  consume(state: string, now: Date): Promise<InstagramOAuthStateConsumeResult>;
}

export type InstagramOAuthStateConsumeResult =
  | { status: "consumed"; userId: string }
  | { status: "not_found" | "expired" | "already_consumed" | "race_lost" };

/** Durable through AuthToken in database mode; the in-memory auth repository is used in local mode. */
export class AuthTokenInstagramOAuthStateStore implements InstagramOAuthStateStore {
  constructor(private readonly auth: AuthRepository, private readonly newId: () => string) {}
  async issue(state: string, userId: string, now: Date): Promise<void> {
    const kind = "instagram_oauth_state" as const;
    // Keep other live one-time states valid. Invalidating per user makes a second
    // browser/device connection attempt silently break the first callback.
    await this.auth.createAuthToken({ id: this.newId(), userId, kind, tokenHash: hashToken(`instagram-oauth:${state}`), expiresAt: new Date(now.getTime() + 600_000), usedAt: null, createdAt: now });
  }
  async consume(state: string, now: Date): Promise<InstagramOAuthStateConsumeResult> {
    const hash = hashToken(`instagram-oauth:${state}`);
    const token = await this.auth.consumeAuthToken("instagram_oauth_state", hash, now);
    if (token) return { status: "consumed", userId: token.userId };
    // This lookup is diagnostic only. The conditional consume above remains the
    // authorization decision and is atomic; a later read can never make a miss pass.
    const existing = await this.auth.getAuthToken("instagram_oauth_state", hash);
    if (!existing) return { status: "not_found" };
    if (existing.usedAt) return { status: "already_consumed" };
    if (existing.expiresAt <= now) return { status: "expired" };
    return { status: "race_lost" };
  }
}
