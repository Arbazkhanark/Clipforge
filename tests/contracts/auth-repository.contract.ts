// A reusable test suite: every AuthRepository implementation (memory now, Prisma later) must pass it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthRepository, AuthTokenRecord, SessionRecord, UserRecord } from "../../src/server/auth/auth-repository.ts";

const T0 = new Date("2026-06-01T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const user = (over: Partial<UserRecord> = {}): UserRecord => ({ id: "u1", email: "a@example.com", emailVerifiedAt: null, passwordHash: "hash", name: null, role: "user", createdAt: T0, ...over });
const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({ id: "s1", userId: "u1", tokenHash: "th1", createdAt: T0, lastUsedAt: T0, expiresAt: at(3_600_000), revokedAt: null, ...over });
const token = (over: Partial<AuthTokenRecord> = {}): AuthTokenRecord => ({ id: "t1", userId: "u1", kind: "email_verification", tokenHash: "h1", expiresAt: at(3_600_000), usedAt: null, createdAt: T0, ...over });

export function runAuthRepositoryContract(name: string, factory: () => Promise<AuthRepository> | AuthRepository): void {
  test(`[${name}] users: create, lookup by email/id, duplicate email refused (unique)`, async () => {
    const repo = await factory();
    assert.equal(await repo.createUser(user()), true);
    assert.equal(await repo.createUser(user({ id: "u2" })), false);                     // same email
    assert.equal(await repo.createUser(user({ id: "u3", email: "b@example.com" })), true);
    assert.equal((await repo.getUserByEmail("a@example.com"))!.id, "u1");
    assert.equal((await repo.getUserById("u3"))!.email, "b@example.com");
    assert.equal(await repo.getUserByEmail("nobody@example.com"), null); assert.equal(await repo.getUserById("nope"), null);
  });

  test(`[${name}] users: concurrent registrations of one email - exactly one wins`, async () => {
    const repo = await factory();
    const results = await Promise.all([repo.createUser(user({ id: "a" })), repo.createUser(user({ id: "b" })), repo.createUser(user({ id: "c" }))]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test(`[${name}] users: verification time is kept (first one wins), password hash can change`, async () => {
    const repo = await factory(); await repo.createUser(user());
    await repo.markEmailVerified("u1", at(10)); await repo.markEmailVerified("u1", at(99));
    assert.equal((await repo.getUserById("u1"))!.emailVerifiedAt!.getTime(), at(10).getTime());
    await repo.setPasswordHash("u1", "newhash");
    assert.equal((await repo.getUserById("u1"))!.passwordHash, "newhash");
  });

  test(`[${name}] sessions: stored by token hash, touch, revoke one, revoke all for a user only`, async () => {
    const repo = await factory(); await repo.createUser(user()); await repo.createUser(user({ id: "u2", email: "b@example.com" }));
    await repo.createSession(session()); await repo.createSession(session({ id: "s2", tokenHash: "th2" })); await repo.createSession(session({ id: "s3", userId: "u2", tokenHash: "th3" }));
    assert.equal((await repo.getSessionByTokenHash("th1"))!.userId, "u1"); assert.equal(await repo.getSessionByTokenHash("unknown"), null);
    await repo.touchSession("s1", at(500));
    assert.equal((await repo.getSessionByTokenHash("th1"))!.lastUsedAt.getTime(), at(500).getTime());
    await repo.revokeSession("s1", at(600));
    assert.equal((await repo.getSessionByTokenHash("th1"))!.revokedAt!.getTime(), at(600).getTime());
    await repo.revokeAllSessionsForUser("u1", at(700));
    assert.notEqual((await repo.getSessionByTokenHash("th2"))!.revokedAt, null);
    assert.equal((await repo.getSessionByTokenHash("th1"))!.revokedAt!.getTime(), at(600).getTime()); // already revoked: unchanged
    assert.equal((await repo.getSessionByTokenHash("th3"))!.revokedAt, null);                          // other user untouched
  });

  test(`[${name}] auth tokens: single use, kind must match, expiry enforced`, async () => {
    const repo = await factory(); await repo.createUser(user());
    await repo.createAuthToken(token());
    assert.equal(await repo.consumeAuthToken("password_reset", "h1", at(1)), null);       // wrong kind
    assert.equal(await repo.consumeAuthToken("email_verification", "other", at(1)), null);
    assert.equal(await repo.consumeAuthToken("email_verification", "h1", at(3_600_000)), null); // expired (boundary: expiresAt <= now)
    const first = await repo.consumeAuthToken("email_verification", "h1", at(1));
    assert.equal(first!.userId, "u1"); assert.notEqual(first!.usedAt, null);
    assert.equal(await repo.consumeAuthToken("email_verification", "h1", at(2)), null);   // already used
  });

  test(`[${name}] auth tokens: two simultaneous consumes - exactly one succeeds`, async () => {
    const repo = await factory(); await repo.createUser(user()); await repo.createAuthToken(token());
    const results = await Promise.all([repo.consumeAuthToken("email_verification", "h1", at(1)), repo.consumeAuthToken("email_verification", "h1", at(1)), repo.consumeAuthToken("email_verification", "h1", at(1))]);
    assert.equal(results.filter((r) => r !== null).length, 1);
  });

  test(`[${name}] auth tokens: invalidate makes unused tokens of that kind unusable, other kinds and users untouched`, async () => {
    const repo = await factory(); await repo.createUser(user()); await repo.createUser(user({ id: "u2", email: "b@example.com" }));
    await repo.createAuthToken(token()); await repo.createAuthToken(token({ id: "t2", tokenHash: "h2", kind: "password_reset" })); await repo.createAuthToken(token({ id: "t3", tokenHash: "h3", userId: "u2" }));
    await repo.invalidateAuthTokens("u1", "email_verification", at(5));
    assert.equal(await repo.consumeAuthToken("email_verification", "h1", at(6)), null);
    assert.notEqual(await repo.consumeAuthToken("password_reset", "h2", at(6)), null);
    assert.notEqual(await repo.consumeAuthToken("email_verification", "h3", at(6)), null);
  });
}
