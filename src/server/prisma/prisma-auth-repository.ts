// Prisma version of AuthRepository. NOT RUN against the real Prisma Client (see prisma-client-like.ts).
import type { AuthRepository, AuthTokenKind, AuthTokenRecord, SessionRecord, UserRecord } from "../auth/auth-repository.ts";
import { isUniqueViolation, type PrismaClientLike, type Row } from "./prisma-client-like.ts";

const rowToUser = (r: Row): UserRecord => ({ id: r["id"], email: r["email"], emailVerifiedAt: r["emailVerified"] ?? null, passwordHash: r["passwordHash"] ?? null, name: r["name"] ?? null, role: r["role"], createdAt: r["createdAt"] });
const rowToSession = (r: Row): SessionRecord => ({ id: r["id"], userId: r["userId"], tokenHash: r["tokenHash"], createdAt: r["createdAt"], lastUsedAt: r["lastUsedAt"], expiresAt: r["expiresAt"], revokedAt: r["revokedAt"] ?? null });
const rowToToken = (r: Row): AuthTokenRecord => ({ id: r["id"], userId: r["userId"], kind: r["kind"], tokenHash: r["tokenHash"], expiresAt: r["expiresAt"], usedAt: r["usedAt"] ?? null, createdAt: r["createdAt"] });

export class PrismaAuthRepository implements AuthRepository {
  private db: PrismaClientLike;
  constructor(db: PrismaClientLike) { this.db = db; }

  async createUser(user: UserRecord): Promise<boolean> {
    try {
      await this.db.user.create({ data: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt, passwordHash: user.passwordHash, name: user.name, role: user.role, createdAt: user.createdAt } });
      return true;
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; } // the UNIQUE index decides races, not our code
  }
  async getUserByEmail(email: string): Promise<UserRecord | null> { const r = await this.db.user.findUnique({ where: { email } }); return r ? rowToUser(r) : null; }
  async getUserById(userId: string): Promise<UserRecord | null> { const r = await this.db.user.findUnique({ where: { id: userId } }); return r ? rowToUser(r) : null; }
  async markEmailVerified(userId: string, at: Date): Promise<void> { await this.db.user.updateMany({ where: { id: userId, emailVerified: null }, data: { emailVerified: at } }); }
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> { await this.db.user.update({ where: { id: userId }, data: { passwordHash } }); }

  async createSession(s: SessionRecord): Promise<void> { await this.db.session.create({ data: { id: s.id, userId: s.userId, tokenHash: s.tokenHash, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt } }); }
  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> { const r = await this.db.session.findUnique({ where: { tokenHash } }); return r ? rowToSession(r) : null; }
  async touchSession(sessionId: string, lastUsedAt: Date): Promise<void> { await this.db.session.update({ where: { id: sessionId }, data: { lastUsedAt } }); }
  async revokeSession(sessionId: string, at: Date): Promise<void> { await this.db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: at } }); }
  async revokeAllSessionsForUser(userId: string, at: Date): Promise<void> { await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } }); }

  async createAuthToken(t: AuthTokenRecord): Promise<void> { await this.db.authToken.create({ data: { id: t.id, userId: t.userId, kind: t.kind, tokenHash: t.tokenHash, expiresAt: t.expiresAt, usedAt: t.usedAt, createdAt: t.createdAt } }); }
  async consumeAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date): Promise<AuthTokenRecord | null> {
    // ONE conditional UPDATE decides: only a request that really flips usedAt from NULL gets the token.
    const outcome = await this.db.authToken.updateMany({ where: { tokenHash, kind, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (outcome.count !== 1) return null;
    const row = await this.db.authToken.findUnique({ where: { tokenHash } });
    return row ? rowToToken(row) : null;
  }
  async invalidateAuthTokens(userId: string, kind: AuthTokenKind, now: Date): Promise<void> { await this.db.authToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: now } }); }
}
