// What authentication needs from storage. Memory implementation: memory-auth-repository.ts. Prisma: prisma/prisma-auth-repository.ts.
export interface UserRecord { id: string; email: string; emailVerifiedAt: Date | null; passwordHash: string | null; name: string | null; role: "user" | "admin"; createdAt: Date; }
export interface SessionRecord { id: string; userId: string; tokenHash: string; createdAt: Date; lastUsedAt: Date; expiresAt: Date; revokedAt: Date | null; }
export type AuthTokenKind = "email_verification" | "password_reset";
export interface AuthTokenRecord { id: string; userId: string; kind: AuthTokenKind; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date; }

export interface AuthRepository {
  /** Returns false (and creates nothing) if the email is already registered. Must be atomic: a UNIQUE constraint in PostgreSQL. */
  createUser(user: UserRecord): Promise<boolean>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(userId: string): Promise<UserRecord | null>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  setPasswordHash(userId: string, passwordHash: string): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touchSession(sessionId: string, lastUsedAt: Date): Promise<void>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
  revokeAllSessionsForUser(userId: string, at: Date): Promise<void>;

  createAuthToken(token: AuthTokenRecord): Promise<void>;
  /** Marks a token used and returns it - ONLY if it exists, matches the kind, is unused and unexpired. Atomic: two requests cannot both succeed. */
  consumeAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date): Promise<AuthTokenRecord | null>;
  /** Makes every unused token of this kind for the user unusable (called when a new one is issued). */
  invalidateAuthTokens(userId: string, kind: AuthTokenKind, now: Date): Promise<void>;
}
