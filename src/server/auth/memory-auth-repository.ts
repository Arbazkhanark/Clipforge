import type { AuthRepository, AuthTokenKind, AuthTokenRecord, GoogleIdentityRecord, SessionRecord, UserRecord } from "./auth-repository.ts";

const clone = <T>(v: T): T => structuredClone(v);
const tick = (): Promise<void> => Promise.resolve();

export class MemoryAuthRepository implements AuthRepository {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, SessionRecord>();
  tokens = new Map<string, AuthTokenRecord>();
  googleIdentities = new Map<string, GoogleIdentityRecord>();

  async createUser(user: UserRecord): Promise<boolean> {
    await tick();
    if ([...this.users.values()].some((u) => u.email === user.email)) return false; // like a UNIQUE constraint
    this.users.set(user.id, clone(user)); return true;
  }
  async getUserByEmail(email: string): Promise<UserRecord | null> { await tick(); const u = [...this.users.values()].find((x) => x.email === email); return u ? clone(u) : null; }
  async getUserById(userId: string): Promise<UserRecord | null> { await tick(); const u = this.users.get(userId); return u ? clone(u) : null; }
  async markEmailVerified(userId: string, at: Date): Promise<void> { await tick(); const u = this.users.get(userId); if (u && !u.emailVerifiedAt) u.emailVerifiedAt = at; }
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> { await tick(); const u = this.users.get(userId); if (u) u.passwordHash = passwordHash; }

  async createSession(session: SessionRecord): Promise<void> { await tick(); this.sessions.set(session.id, clone(session)); }
  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> { await tick(); const s = [...this.sessions.values()].find((x) => x.tokenHash === tokenHash); return s ? clone(s) : null; }
  async touchSession(sessionId: string, lastUsedAt: Date): Promise<void> { await tick(); const s = this.sessions.get(sessionId); if (s) s.lastUsedAt = lastUsedAt; }
  async revokeSession(sessionId: string, at: Date): Promise<void> { await tick(); const s = this.sessions.get(sessionId); if (s && !s.revokedAt) s.revokedAt = at; }
  async revokeAllSessionsForUser(userId: string, at: Date): Promise<void> { await tick(); for (const s of this.sessions.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = at; }

  async createAuthToken(token: AuthTokenRecord): Promise<void> { await tick(); this.tokens.set(token.id, clone(token)); }
  async getAuthToken(kind: AuthTokenKind, tokenHash: string): Promise<AuthTokenRecord | null> {
    await tick();
    const token = [...this.tokens.values()].find((item) => item.kind === kind && item.tokenHash === tokenHash);
    return token ? clone(token) : null;
  }
  async completePasswordReset(input: { tokenHash: string; now: Date; passwordHash: string; passwordProblems: (email: string) => string[] }): Promise<{ status: "reset" } | { status: "invalid" } | { status: "rejected"; problems: string[] }> {
    await tick();
    const token = [...this.tokens.values()].find((item) => item.tokenHash === input.tokenHash && item.kind === "password_reset");
    const user = token ? this.users.get(token.userId) : undefined;
    if (!token || token.usedAt !== null || token.expiresAt <= input.now || !user) return { status: "invalid" };
    const problems = input.passwordProblems(user.email);
    if (problems.length > 0) return { status: "rejected", problems };
    token.usedAt = input.now;
    user.passwordHash = input.passwordHash;
    if (!user.emailVerifiedAt) user.emailVerifiedAt = input.now;
    for (const session of this.sessions.values()) if (session.userId === user.id && !session.revokedAt) session.revokedAt = input.now;
    return { status: "reset" };
  }
  async consumeAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date): Promise<AuthTokenRecord | null> {
    await tick();
    // No await between check and write: atomic, like UPDATE ... WHERE usedAt IS NULL AND expiresAt > now.
    const t = [...this.tokens.values()].find((x) => x.tokenHash === tokenHash && x.kind === kind);
    if (!t || t.usedAt !== null || t.expiresAt <= now) return null;
    t.usedAt = now; return clone(t);
  }
  async invalidateAuthTokens(userId: string, kind: AuthTokenKind, now: Date): Promise<void> {
    await tick();
    for (const t of this.tokens.values()) if (t.userId === userId && t.kind === kind && t.usedAt === null) t.usedAt = now;
  }

  async getGoogleIdentityBySub(googleSub: string): Promise<GoogleIdentityRecord | null> {
    await tick(); const found = [...this.googleIdentities.values()].find((row) => row.googleSub === googleSub); return found ? clone(found) : null;
  }
  async getGoogleIdentityByUserId(userId: string): Promise<GoogleIdentityRecord | null> {
    await tick(); const found = [...this.googleIdentities.values()].find((row) => row.userId === userId); return found ? clone(found) : null;
  }
  async linkGoogleIdentity(identity: GoogleIdentityRecord): Promise<boolean> {
    await tick();
    if (!this.users.has(identity.userId)) return false;
    if ([...this.googleIdentities.values()].some((row) => row.userId === identity.userId || row.googleSub === identity.googleSub)) return false;
    this.googleIdentities.set(identity.id, clone(identity));
    return true;
  }
  async createGoogleUser(user: UserRecord, identity: GoogleIdentityRecord): Promise<"created" | "email_taken" | "sub_taken"> {
    await tick();
    if (identity.userId !== user.id) return "sub_taken";
    if ([...this.users.values()].some((row) => row.email === user.email)) return "email_taken";
    if ([...this.googleIdentities.values()].some((row) => row.googleSub === identity.googleSub || row.userId === user.id)) return "sub_taken";
    this.users.set(user.id, clone(user));
    this.googleIdentities.set(identity.id, clone(identity));
    return "created";
  }
}
