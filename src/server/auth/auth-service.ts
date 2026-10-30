// Registration, email verification, login, sessions, logout, password reset.
// Design rules:
//  - tokens (session cookie, email links) are random and stored only as SHA-256 hashes,
//  - the same answer for "no such account" and "wrong password"; a dummy hash check keeps timing similar,
//  - repeated failures lock an email for a while (rate limiter),
//  - every login creates a NEW session (no session fixation); a password reset ends ALL sessions,
//  - emailed tokens are single-use and expire (24h verification, 1h reset).
// Google sign-in is NOT implemented. Nothing here sends real email (see email.ts).
import { DEFAULT_SCRYPT_PARAMS, checkPasswordPolicy, hashPassword, makeDummyHash, needsRehash, verifyPassword, type ScryptParams } from "./password.ts";
import { generateToken, hashToken } from "./tokens.ts";
import type { AuthRepository, UserRecord } from "./auth-repository.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import { passwordResetEmail, verificationEmail, type EmailSender } from "./email.ts";

export interface AuthConfig {
  baseUrl: string;
  scrypt: ScryptParams;
  sessionAbsoluteMs: number;   // a session never lives longer than this
  sessionIdleMs: number;       // ...and ends after this long without use
  verificationTtlMs: number;
  resetTtlMs: number;
  /** Save "last used" at most this often, so every request is not a database write. */
  touchEveryMs: number;
}
export const DEFAULT_AUTH_CONFIG = (baseUrl: string): AuthConfig => ({
  baseUrl, scrypt: DEFAULT_SCRYPT_PARAMS, sessionAbsoluteMs: 30 * 86_400_000, sessionIdleMs: 7 * 86_400_000,
  verificationTtlMs: 24 * 3_600_000, resetTtlMs: 3_600_000, touchEveryMs: 60_000,
});

export interface AuthDeps { repo: AuthRepository; email: EmailSender; limiter: RateLimiter; now: () => Date; newId: () => string; config: AuthConfig; }

export type RegisterResult = { ok: true } | { ok: false; problems: string[] };
export type LoginResult =
  | { ok: true; sessionToken: string; expiresAt: Date; userId: string }
  | { ok: false; code: "invalid_credentials" | "email_not_verified" | "rate_limited"; retryAfterSeconds?: number };

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

export class AuthService {
  private deps: AuthDeps;
  private dummyHash: Promise<string>;
  constructor(deps: AuthDeps) { this.deps = deps; this.dummyHash = makeDummyHash(deps.config.scrypt); }

  private emailKey(email: string): string { return `login:${hashToken(normaliseEmail(email))}`; }

  /** Creates an unverified account and "sends" a verification email. An existing email gets the SAME success answer (no enumeration). */
  async register(input: { email: unknown; password: unknown; name?: unknown }): Promise<RegisterResult> {
    const { repo, config } = this.deps;
    const problems: string[] = [];
    const email = typeof input.email === "string" ? normaliseEmail(input.email) : "";
    if (!EMAIL_PATTERN.test(email) || email.length > 320) problems.push("Enter a valid email address.");
    const password = typeof input.password === "string" ? input.password : "";
    problems.push(...checkPasswordPolicy(password, email));
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
    if (problems.length > 0) return { ok: false, problems };

    const user: UserRecord = { id: this.deps.newId(), email, emailVerifiedAt: null, passwordHash: await hashPassword(password, config.scrypt), name: name || null, role: "user", createdAt: this.deps.now() };
    if (await repo.createUser(user)) await this.issueToken(user.id, email, "email_verification");
    return { ok: true };
  }

  private async issueToken(userId: string, email: string, kind: "email_verification" | "password_reset"): Promise<void> {
    const { repo, config } = this.deps; const now = this.deps.now();
    await repo.invalidateAuthTokens(userId, kind, now); // only the newest link works
    const { token, tokenHash } = generateToken();
    const ttl = kind === "email_verification" ? config.verificationTtlMs : config.resetTtlMs;
    await repo.createAuthToken({ id: this.deps.newId(), userId, kind, tokenHash, expiresAt: new Date(now.getTime() + ttl), usedAt: null, createdAt: now });
    await this.deps.email.send(kind === "email_verification" ? verificationEmail(email, config.baseUrl, token) : passwordResetEmail(email, config.baseUrl, token));
  }

  async verifyEmail(token: unknown): Promise<{ ok: boolean }> {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false };
    const record = await this.deps.repo.consumeAuthToken("email_verification", hashToken(token), this.deps.now());
    if (!record) return { ok: false };
    await this.deps.repo.markEmailVerified(record.userId, this.deps.now());
    return { ok: true };
  }

  /** Always answers ok: never reveals whether an email is registered or already verified. */
  async resendVerification(emailInput: unknown): Promise<{ ok: true }> {
    const email = typeof emailInput === "string" ? normaliseEmail(emailInput) : "";
    const user = email ? await this.deps.repo.getUserByEmail(email) : null;
    if (user && !user.emailVerifiedAt) await this.issueToken(user.id, user.email, "email_verification");
    return { ok: true };
  }

  async login(input: { email: unknown; password: unknown; ip?: string | null }): Promise<LoginResult> {
    const { repo, limiter, config } = this.deps; const now = this.deps.now();
    const email = typeof input.email === "string" ? normaliseEmail(input.email) : "";
    const password = typeof input.password === "string" ? input.password : "";
    const keys = [this.emailKey(email), ...(input.ip ? [`login-ip:${hashToken(input.ip)}`] : [])];
    for (const key of keys) { const state = limiter.check(key, now); if (!state.allowed) return { ok: false, code: "rate_limited", retryAfterSeconds: state.retryAfterSeconds }; }

    const user = email && password.length <= 1024 ? await repo.getUserByEmail(email) : null;
    // Always do one hash comparison, even when the account does not exist.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !user.passwordHash || !passwordOk) { for (const key of keys) limiter.recordFailure(key, now); return { ok: false, code: "invalid_credentials" }; }
    if (!user.emailVerifiedAt) return { ok: false, code: "email_not_verified" };

    for (const key of keys) limiter.reset(key);
    if (needsRehash(user.passwordHash, config.scrypt)) await repo.setPasswordHash(user.id, await hashPassword(password, config.scrypt));

    const { token, tokenHash } = generateToken();
    const expiresAt = new Date(now.getTime() + config.sessionAbsoluteMs);
    await repo.createSession({ id: this.deps.newId(), userId: user.id, tokenHash, createdAt: now, lastUsedAt: now, expiresAt, revokedAt: null });
    return { ok: true, sessionToken: token, expiresAt, userId: user.id };
  }

  /** Who is this cookie? Null when missing, unknown, revoked, expired, or idle for too long. */
  async getSessionUserId(token: string | null): Promise<string | null> {
    if (!token) return null;
    const { repo, config } = this.deps; const now = this.deps.now();
    const session = await repo.getSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || session.expiresAt <= now || now.getTime() - session.lastUsedAt.getTime() > config.sessionIdleMs) return null;
    if (now.getTime() - session.lastUsedAt.getTime() > config.touchEveryMs) await repo.touchSession(session.id, now);
    return session.userId;
  }

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const session = await this.deps.repo.getSessionByTokenHash(hashToken(token));
    if (session) await this.deps.repo.revokeSession(session.id, this.deps.now());
  }

  /** Always answers ok (no account enumeration). Only verified accounts get a reset email. */
  async requestPasswordReset(emailInput: unknown): Promise<{ ok: true }> {
    const email = typeof emailInput === "string" ? normaliseEmail(emailInput) : "";
    const user = email ? await this.deps.repo.getUserByEmail(email) : null;
    if (user?.emailVerifiedAt) await this.issueToken(user.id, user.email, "password_reset");
    return { ok: true };
  }

  async resetPassword(token: unknown, newPassword: unknown): Promise<{ ok: true } | { ok: false; problems: string[] }> {
    const { repo, config } = this.deps;
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false, problems: ["This reset link is not valid or has expired."] };
    const password = typeof newPassword === "string" ? newPassword : "";
    // Validate the password BEFORE consuming the token, so a typo does not burn the link.
    // The policy needs the email, which we only know after consuming; use a neutral check first, then re-check below.
    const early = checkPasswordPolicy(password, "");
    if (early.length > 0) return { ok: false, problems: early };
    const record = await repo.consumeAuthToken("password_reset", hashToken(token), this.deps.now());
    if (!record) return { ok: false, problems: ["This reset link is not valid or has expired."] };
    const user = await repo.getUserById(record.userId);
    if (!user) return { ok: false, problems: ["This reset link is not valid or has expired."] };
    const finalCheck = checkPasswordPolicy(password, user.email);
    if (finalCheck.length > 0) return { ok: false, problems: finalCheck };
    await repo.setPasswordHash(user.id, await hashPassword(password, config.scrypt));
    await repo.markEmailVerified(user.id, this.deps.now()); // they proved they control the mailbox
    await repo.revokeAllSessionsForUser(user.id, this.deps.now()); // anyone logged in with the old password is signed out
    return { ok: true };
  }
}
