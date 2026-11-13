// Registration, email verification, login, sessions, logout, password reset.
// Design rules:
//  - tokens (session cookie, email links) are random and stored only as SHA-256 hashes,
//  - the same answer for "no such account" and "wrong password"; a dummy hash check keeps timing similar,
//  - repeated failures lock an email for a while (rate limiter),
//  - every login creates a NEW session (no session fixation); a password reset ends ALL sessions,
//  - emailed tokens are single-use and expire (24h verification, 1h reset).
// Google sign-in is completeGoogleSignIn. It reuses these sessions and does not store Google tokens.
// Email messages are sent through the server-only adapters in email.ts when configured.
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
  /** Require a confirmation link when real delivery is configured; first-Admin activation always requires its own confirmation. */
  requireVerifiedEmail: boolean;
}
export const DEFAULT_AUTH_CONFIG = (baseUrl: string): AuthConfig => ({
  baseUrl, scrypt: DEFAULT_SCRYPT_PARAMS, sessionAbsoluteMs: 30 * 86_400_000, sessionIdleMs: 7 * 86_400_000,
  verificationTtlMs: 24 * 3_600_000, resetTtlMs: 3_600_000, touchEveryMs: 60_000, requireVerifiedEmail: true,
});

export interface AuthDeps { repo: AuthRepository; email: EmailSender; limiter: RateLimiter; now: () => Date; newId: () => string; config: AuthConfig; }

export type RegisterResult = { ok: true } | { ok: false; problems: string[] };
export type LoginResult =
  | { ok: true; sessionToken: string; expiresAt: Date; userId: string }
  | { ok: false; code: "invalid_credentials" | "email_not_verified" | "rate_limited"; retryAfterSeconds?: number };

/** Claims read from a verified Google ID token. No access token is included. */
export interface GoogleProfile { sub: string; email: string; emailVerified: boolean; name: string | null; }
export type GoogleSignInCode = "google_email_unverified" | "google_account_exists" | "google_identity_taken" | "google_link_mismatch" | "google_invalid_profile";
export type GoogleSignInResult =
  | { ok: true; sessionToken: string; expiresAt: Date; userId: string; created: boolean }
  | { ok: false; code: GoogleSignInCode };

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
    if (await repo.createUser(user) && config.requireVerifiedEmail) await this.issueToken(user.id, email, "email_verification");
    return { ok: true };
  }

  private async issueToken(userId: string, email: string, kind: "email_verification" | "password_reset"): Promise<void> {
    const { repo, config } = this.deps; const now = this.deps.now();
    await repo.invalidateAuthTokens(userId, kind, now); // only the newest link works
    const { token, tokenHash } = generateToken();
    const ttl = kind === "email_verification" ? config.verificationTtlMs : config.resetTtlMs;
    await repo.createAuthToken({ id: this.deps.newId(), userId, kind, tokenHash, expiresAt: new Date(now.getTime() + ttl), usedAt: null, createdAt: now });
    try {
      await this.deps.email.send(kind === "email_verification" ? verificationEmail(email, config.baseUrl, token) : passwordResetEmail(email, config.baseUrl, token));
    } catch (error) {
      await repo.invalidateAuthTokens(userId, kind, now); // a failed send must not leave a usable link
      throw error;
    }
  }

  async verifyEmail(token: unknown): Promise<{ ok: boolean }> {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false };
    const key = `verify:${hashToken(token)}`; const now = this.deps.now();
    if (!this.deps.limiter.check(key, now).allowed) return { ok: false };
    const record = await this.deps.repo.consumeAuthToken("email_verification", hashToken(token), now);
    if (!record) { this.deps.limiter.recordFailure(key, now); return { ok: false }; }
    this.deps.limiter.reset(key);
    await this.deps.repo.markEmailVerified(record.userId, now);
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
    if (config.requireVerifiedEmail && !user.emailVerifiedAt) return { ok: false, code: "email_not_verified" };

    for (const key of keys) limiter.reset(key);
    if (needsRehash(user.passwordHash, config.scrypt)) await repo.setPasswordHash(user.id, await hashPassword(password, config.scrypt));

    return { ok: true, ...(await this.openSession(user.id)) };
  }

  private async openSession(userId: string): Promise<{ sessionToken: string; expiresAt: Date; userId: string }> {
    const now = this.deps.now();
    const { token, tokenHash } = generateToken();
    const expiresAt = new Date(now.getTime() + this.deps.config.sessionAbsoluteMs);
    await this.deps.repo.createSession({ id: this.deps.newId(), userId, tokenHash, createdAt: now, lastUsedAt: now, expiresAt, revokedAt: null });
    return { sessionToken: token, expiresAt, userId };
  }

  /**
   * Sign in, sign up, or link a Google account.
   * linkUserId is set only when this browser already has a ClipForge session and asked to connect Google.
   * A matching email never links by itself.
   */
  async completeGoogleSignIn(profile: GoogleProfile, linkUserId: string | null): Promise<GoogleSignInResult> {
    const sub = typeof profile.sub === "string" ? profile.sub.trim() : "";
    const email = typeof profile.email === "string" ? normaliseEmail(profile.email) : "";
    const name = typeof profile.name === "string" ? profile.name.trim().slice(0, 100) : "";
    if (!/^[\x21-\x7E]{1,255}$/.test(sub) || !EMAIL_PATTERN.test(email) || email.length > 320) return { ok: false, code: "google_invalid_profile" };
    if (profile.emailVerified !== true) return { ok: false, code: "google_email_unverified" };

    const { repo } = this.deps;
    const existing = await repo.getGoogleIdentityBySub(sub);
    if (existing) {
      if (linkUserId && linkUserId !== existing.userId) return { ok: false, code: "google_identity_taken" };
      return { ok: true, created: false, ...(await this.openSession(existing.userId)) };
    }

    if (linkUserId) {
      const user = await repo.getUserById(linkUserId);
      if (!user || !user.emailVerifiedAt || normaliseEmail(user.email) !== email) return { ok: false, code: "google_link_mismatch" };
      const already = await repo.getGoogleIdentityByUserId(user.id);
      if (already) return { ok: false, code: "google_identity_taken" };
      const linked = await repo.linkGoogleIdentity({ id: this.deps.newId(), userId: user.id, googleSub: sub, createdAt: this.deps.now() });
      if (!linked) {
        const winner = await repo.getGoogleIdentityBySub(sub);
        if (winner?.userId === user.id) return { ok: true, created: false, ...(await this.openSession(user.id)) };
        return { ok: false, code: "google_identity_taken" };
      }
      return { ok: true, created: false, ...(await this.openSession(user.id)) };
    }

    if (await repo.getUserByEmail(email)) return { ok: false, code: "google_account_exists" };
    const now = this.deps.now();
    const userId = this.deps.newId();
    const outcome = await repo.createGoogleUser(
      { id: userId, email, emailVerifiedAt: now, passwordHash: null, name: name || null, role: "user", createdAt: now },
      { id: this.deps.newId(), userId, googleSub: sub, createdAt: now },
    );
    if (outcome === "email_taken") return { ok: false, code: "google_account_exists" };
    if (outcome === "sub_taken") {
      const winner = await repo.getGoogleIdentityBySub(sub);
      if (!winner) return { ok: false, code: "google_identity_taken" };
      return { ok: true, created: false, ...(await this.openSession(winner.userId)) };
    }
    return { ok: true, created: true, ...(await this.openSession(userId)) };
  }

  /** Who is this cookie? Null when missing, unknown, revoked, expired, or idle for too long. */
  async getSessionUserId(token: string | null): Promise<string | null> {
    if (!token) return null;
    const { repo, config } = this.deps; const now = this.deps.now();
    const session = await repo.getSessionByTokenHash(hashToken(token));
    if (!session) return null;
    if (session.revokedAt || session.expiresAt <= now || now.getTime() - session.lastUsedAt.getTime() > config.sessionIdleMs) {
      if (!session.revokedAt) await repo.revokeSession(session.id, now);
      return null;
    }
    if (now.getTime() - session.lastUsedAt.getTime() > config.touchEveryMs) await repo.touchSession(session.id, now);
    return session.userId;
  }

  /** Resolves the current persisted role only after validating this session on this request. */
  async getSessionPrincipal(token: string | null): Promise<{ userId: string; role: UserRecord["role"] } | null> {
    const userId = await this.getSessionUserId(token);
    if (!userId) return null;
    const user = await this.deps.repo.getUserById(userId);
    return user ? { userId: user.id, role: user.role } : null;
  }

  /** Fresh persisted verification check for Admin login, even when ordinary email verification is optional. */
  async isEmailVerified(userId: string): Promise<boolean> {
    const user = await this.deps.repo.getUserById(userId);
    return Boolean(user?.emailVerifiedAt);
  }

  async logout(token: string | null): Promise<void> {
    if (!token) return;
    const session = await this.deps.repo.getSessionByTokenHash(hashToken(token));
    if (session) await this.deps.repo.revokeSession(session.id, this.deps.now());
  }

  /** Always answers ok (no account enumeration). Only verified accounts get a reset email. Repeated requests are slowed down and still get the same answer. */
  async requestPasswordReset(emailInput: unknown): Promise<{ ok: true }> {
    const email = typeof emailInput === "string" ? normaliseEmail(emailInput) : "";
    const key = `reset:${hashToken(email || "blank")}`; const now = this.deps.now();
    if (!this.deps.limiter.check(key, now).allowed) return { ok: true };
    this.deps.limiter.recordFailure(key, now);
    const user = email ? await this.deps.repo.getUserByEmail(email) : null;
    if (this.deps.config.requireVerifiedEmail && user?.emailVerifiedAt) await this.issueToken(user.id, user.email, "password_reset");
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
    const now = this.deps.now();
    const outcome = await repo.completePasswordReset({
      tokenHash: hashToken(token), now, passwordHash: await hashPassword(password, config.scrypt),
      passwordProblems: (email) => checkPasswordPolicy(password, email),
    });
    if (outcome.status === "rejected") return { ok: false, problems: outcome.problems };
    if (outcome.status === "invalid") return { ok: false, problems: ["This reset link is not valid or has expired."] };
    return { ok: true };
  }
}
