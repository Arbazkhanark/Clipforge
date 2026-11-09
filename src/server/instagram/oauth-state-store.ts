import { randomUUID } from "node:crypto";
import { hashToken } from "../auth/tokens.ts";
import type { AuthRepository } from "../auth/auth-repository.ts";

export interface InstagramOAuthStateStore {
  issue(state: string, userId: string, now: Date): Promise<void>;
  consume(state: string, now: Date): Promise<string | null>;
}

/** Durable through AuthToken in database mode; the in-memory auth repository is used in local mode. */
export class AuthTokenInstagramOAuthStateStore implements InstagramOAuthStateStore {
  constructor(private readonly auth: AuthRepository, private readonly newId: () => string) {}
  async issue(state: string, userId: string, now: Date): Promise<void> {
    const kind = "instagram_oauth_state" as const;
    await this.auth.invalidateAuthTokens(userId, kind, now);
    await this.auth.createAuthToken({ id: this.newId(), userId, kind, tokenHash: hashToken(`instagram-oauth:${state}`), expiresAt: new Date(now.getTime() + 600_000), usedAt: null, createdAt: now });
  }
  async consume(state: string, now: Date): Promise<string | null> {
    const token = await this.auth.consumeAuthToken("instagram_oauth_state", hashToken(`instagram-oauth:${state}`), now);
    return token?.userId ?? null;
  }
}
