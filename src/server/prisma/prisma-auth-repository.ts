// Prisma version of AuthRepository. NOT RUN against the real Prisma Client (see prisma-client-like.ts).
import type { AuthRepository, AuthTokenKind, AuthTokenRecord, GoogleIdentityRecord, SessionRecord, UserRecord } from "../auth/auth-repository.ts";
import { isUniqueViolation, type PrismaClientLike, type Row } from "./prisma-client-like.ts";

const rowToUser = (r: Row): UserRecord => ({ id: r["id"], email: r["email"], emailVerifiedAt: r["emailVerified"] ?? null, passwordHash: r["passwordHash"] ?? null, name: r["name"] ?? null, role: r["role"], createdAt: r["createdAt"] });
const rowToSession = (r: Row): SessionRecord => ({ id: r["id"], userId: r["userId"], tokenHash: r["tokenHash"], createdAt: r["createdAt"], lastUsedAt: r["lastUsedAt"], expiresAt: r["expiresAt"], revokedAt: r["revokedAt"] ?? null });
const rowToToken = (r: Row): AuthTokenRecord => ({ id: r["id"], userId: r["userId"], kind: r["kind"], tokenHash: r["tokenHash"], expiresAt: r["expiresAt"], usedAt: r["usedAt"] ?? null, createdAt: r["createdAt"] });

export class PrismaAuthRepository implements AuthRepository {
  private db: PrismaClientLike;
  constructor(db: PrismaClientLike) { this.db = db; }

  async createUser(user: UserRecord): Promise<boolean> {
    try {
      // Public signup must use the database's ordinary-user default. An
      // untrusted caller-supplied UserRecord.role is never persisted here.
      await this.db.user.create({ data: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt, passwordHash: user.passwordHash, name: user.name, createdAt: user.createdAt } });
      return true;
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; } // the UNIQUE index decides races, not our code
  }
  async getUserByEmail(email: string): Promise<UserRecord | null> { const r = await this.db.user.findUnique({ where: { email } }); return r ? rowToUser(r) : null; }
  async getUserById(userId: string): Promise<UserRecord | null> { const r = await this.db.user.findUnique({ where: { id: userId } }); return r ? rowToUser(r) : null; }
  async isUserSuspended(userId: string): Promise<boolean> {
    try { return Boolean(await this.db.userSuspension.findUnique({ where: { userId }, select: { userId: true } })); }
    catch (error) {
      const candidate = error as { code?: unknown } | null;
      if (candidate?.code === "P2021") return false; // Before the optional admin-suspension migration, no suspension rows can exist.
      throw error;
    }
  }
  async markEmailVerified(userId: string, at: Date): Promise<void> { await this.db.user.updateMany({ where: { id: userId, emailVerified: null }, data: { emailVerified: at } }); }
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> { await this.db.user.update({ where: { id: userId }, data: { passwordHash } }); }

  async createSession(s: SessionRecord): Promise<void> { await this.db.session.create({ data: { id: s.id, userId: s.userId, tokenHash: s.tokenHash, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt } }); }
  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> { const r = await this.db.session.findUnique({ where: { tokenHash } }); return r ? rowToSession(r) : null; }
  async touchSession(sessionId: string, lastUsedAt: Date): Promise<void> { await this.db.session.update({ where: { id: sessionId }, data: { lastUsedAt } }); }
  async revokeSession(sessionId: string, at: Date): Promise<void> { await this.db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: at } }); }
  async revokeAllSessionsForUser(userId: string, at: Date): Promise<void> { await this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } }); }

  async createAuthToken(t: AuthTokenRecord): Promise<void> { await this.db.authToken.create({ data: { id: t.id, userId: t.userId, kind: t.kind, tokenHash: t.tokenHash, expiresAt: t.expiresAt, usedAt: t.usedAt, createdAt: t.createdAt } }); }
  async getAuthToken(kind: AuthTokenKind, tokenHash: string): Promise<AuthTokenRecord | null> {
    const row = await this.db.authToken.findUnique({ where: { tokenHash } });
    return row && row["kind"] === kind ? rowToToken(row) : null;
  }
  async completePasswordReset(input: { tokenHash: string; now: Date; passwordHash: string; passwordProblems: (email: string) => string[] }): Promise<{ status: "reset" } | { status: "invalid" } | { status: "rejected"; problems: string[] }> {
    return this.db.$transaction(async (tx) => {
      const token = await tx.authToken.findUnique({ where: { tokenHash: input.tokenHash } });
      if (!token || token["kind"] !== "password_reset" || token["usedAt"] != null || !(token["expiresAt"] > input.now)) return { status: "invalid" };
      const user = await tx.user.findUnique({ where: { id: token["userId"] } });
      if (!user) return { status: "invalid" };
      const problems = input.passwordProblems(user["email"]);
      if (problems.length > 0) return { status: "rejected", problems };
      const consumed = await tx.authToken.updateMany({ where: { tokenHash: input.tokenHash, kind: "password_reset", usedAt: null, expiresAt: { gt: input.now } }, data: { usedAt: input.now } });
      if (consumed.count !== 1) return { status: "invalid" };
      await tx.user.update({ where: { id: user["id"] }, data: { passwordHash: input.passwordHash, ...(user["emailVerified"] == null ? { emailVerified: input.now } : {}) } });
      await tx.session.updateMany({ where: { userId: user["id"], revokedAt: null }, data: { revokedAt: input.now } });
      return { status: "reset" };
    });
  }
  async consumeAuthToken(kind: AuthTokenKind, tokenHash: string, now: Date): Promise<AuthTokenRecord | null> {
    // ONE conditional UPDATE decides: only a request that really flips usedAt from NULL gets the token.
    const outcome = await this.db.authToken.updateMany({ where: { tokenHash, kind, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (outcome.count !== 1) return null;
    const row = await this.db.authToken.findUnique({ where: { tokenHash } });
    return row ? rowToToken(row) : null;
  }
  async invalidateAuthTokens(userId: string, kind: AuthTokenKind, now: Date): Promise<void> { await this.db.authToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: now } }); }

  async getGoogleIdentityBySub(googleSub: string): Promise<GoogleIdentityRecord | null> {
    const row = await this.db.googleIdentity.findUnique({ where: { googleSub } }); return row ? rowToGoogle(row) : null;
  }
  async getGoogleIdentityByUserId(userId: string): Promise<GoogleIdentityRecord | null> {
    const row = await this.db.googleIdentity.findUnique({ where: { userId } }); return row ? rowToGoogle(row) : null;
  }
  async linkGoogleIdentity(identity: GoogleIdentityRecord): Promise<boolean> {
    if (!await this.getUserById(identity.userId)) return false;
    if (await this.getGoogleIdentityByUserId(identity.userId) || await this.getGoogleIdentityBySub(identity.googleSub)) return false;
    try {
      await this.db.googleIdentity.create({ data: { id: identity.id, userId: identity.userId, googleSub: identity.googleSub, createdAt: identity.createdAt } });
      return true;
    } catch (error) { if (isUniqueViolation(error)) return false; throw error; }
  }
  async createGoogleUser(user: UserRecord, identity: GoogleIdentityRecord): Promise<"created" | "email_taken" | "sub_taken"> {
    if (identity.userId !== user.id) return "sub_taken";
    try {
      await this.db.$transaction(async (tx) => {
        // As with password signup, public Google signup relies on the DB's
        // role default instead of accepting a caller-selected role.
        await tx.user.create({ data: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt, passwordHash: user.passwordHash, name: user.name, createdAt: user.createdAt } });
        await tx.googleIdentity.create({ data: { id: identity.id, userId: identity.userId, googleSub: identity.googleSub, createdAt: identity.createdAt } });
      });
      return "created";
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const subOwner = await this.getGoogleIdentityBySub(identity.googleSub);
      // The transaction has already rolled back both inserts. Never issue a
      // compensating broad delete that could remove a pre-existing user.
      if (subOwner) return "sub_taken";
      return "email_taken";
    }
  }
}

const rowToGoogle = (r: Row): GoogleIdentityRecord => ({ id: r["id"], userId: r["userId"], googleSub: r["googleSub"], createdAt: r["createdAt"] });
