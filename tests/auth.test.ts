import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCRYPT_PARAMS, checkPasswordPolicy, hashPassword, needsRehash, verifyPassword, type ScryptParams } from "../src/server/auth/password.ts";
import { buildClearedSessionCookie, buildSessionCookie, generateToken, hashToken, readSessionToken } from "../src/server/auth/tokens.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { AuthService, DEFAULT_AUTH_CONFIG, normaliseEmail } from "../src/server/auth/auth-service.ts";
import { runAuthRepositoryContract } from "./contracts/auth-repository.contract.ts";

const FAST: ScryptParams = { logN: 10, r: 8, p: 1 }; // fast for tests only
const NOW0 = new Date("2026-06-01T12:00:00Z");
const GOOD_PASSWORD = "correct horse battery";

runAuthRepositoryContract("MemoryAuthRepository", () => new MemoryAuthRepository());

function setup() {
  const clock = { now: new Date(NOW0) };
  const repo = new MemoryAuthRepository(); const outbox = new MemoryEmailOutbox(); let id = 0;
  const limiter = new InMemoryRateLimiter(3, 600_000, 900_000);
  const config = { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: FAST };
  const service = new AuthService({ repo, email: outbox, limiter, now: () => clock.now, newId: () => `id${++id}`, config });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  const tokenFromEmail = (index = -1) => new URL(outbox.messages.at(index)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  return { service, repo, outbox, clock, advance, tokenFromEmail, limiter };
}
async function registered(s = setup(), email = "Ann@Example.com") {
  assert.deepEqual(await s.service.register({ email, password: GOOD_PASSWORD, name: " Ann " }), { ok: true });
  await s.service.verifyEmail(s.tokenFromEmail());
  return s;
}

// ---------- passwords ----------
test("password hashing: round trip, salted, parameters stored in the hash, wrong/odd inputs rejected", async () => {
  const hash = await hashPassword("a long enough password", FAST);
  assert.match(hash, /^scrypt\$10\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword("a long enough password", hash), true);
  assert.equal(await verifyPassword("a long enough passwore", hash), false);
  assert.equal(await verifyPassword("", hash), false);
  assert.notEqual(await hashPassword("a long enough password", FAST), hash);                  // fresh salt every time
  assert.ok(!hash.includes("long enough"));
  assert.equal(await verifyPassword("é", await hashPassword("é", FAST)), true);               // unicode
  assert.equal(await verifyPassword("e\u0301", await hashPassword("é", FAST)), true);         // NFKC-normalised: same visible text
});

test("tampered, malformed or dangerous stored hashes never verify and never throw", async () => {
  const good = await hashPassword("secret-secret", FAST);
  const parts = good.split("$");
  const bad = ["", "plain", "scrypt$10$8$1$x$y", "bcrypt$10$8$1$a$b", `scrypt$30$8$1$${parts[4]}$${parts[5]}`, `scrypt$10$999$1$${parts[4]}$${parts[5]}`, `scrypt$10$8$99$${parts[4]}$${parts[5]}`, `scrypt$abc$8$1$${parts[4]}$${parts[5]}`, `${good}$extra`, good.slice(0, -4)];
  for (const stored of bad) assert.equal(await verifyPassword("secret-secret", stored), false, stored.slice(0, 40));
});

test("a stored hash demanding huge memory/CPU is refused INSTANTLY (denial-of-service guard), not computed", async () => {
  const parts = (await hashPassword("secret-secret", FAST)).split("$");
  const started = Date.now();
  assert.equal(await verifyPassword("secret-secret", `scrypt$19$8$1$${parts[4]}$${parts[5]}`), false);
  assert.ok(Date.now() - started < 300, `took ${Date.now() - started}ms: parameters were not rejected up front`);
});

test("default hashing cost really is the strong setting and works within memory limits", async () => {
  assert.deepEqual(DEFAULT_SCRYPT_PARAMS, { logN: 17, r: 8, p: 1 });
  const hash = await hashPassword("some password here", DEFAULT_SCRYPT_PARAMS);
  assert.ok(hash.startsWith("scrypt$17$8$1$")); assert.equal(await verifyPassword("some password here", hash), true);
  assert.equal(needsRehash(hash, DEFAULT_SCRYPT_PARAMS), false);
});

test("hash upgrade detection: weaker stored parameters or garbage need a rehash", async () => {
  const weak = await hashPassword("x".repeat(12), FAST);
  assert.equal(needsRehash(weak, DEFAULT_SCRYPT_PARAMS), true); assert.equal(needsRehash(weak, FAST), false); assert.equal(needsRehash("garbage", FAST), true);
});

test("password policy: length, repetition, common passwords, own email - in plain words", () => {
  assert.deepEqual(checkPasswordPolicy("correct horse battery", "a@example.com"), []);
  assert.match(checkPasswordPolicy("short", "a@example.com")[0]!, /at least 10/);
  assert.ok(checkPasswordPolicy("x".repeat(129), "a@example.com").some((p) => /at most 128/.test(p)));
  assert.ok(checkPasswordPolicy("aaaaaaaaaaaa", "a@example.com").some((p) => /repetitive/.test(p)));
  assert.ok(checkPasswordPolicy("Password123", "a@example.com").some((p) => /common/.test(p)));
  assert.ok(checkPasswordPolicy("anna@example.com", "anna@example.com").some((p) => /email/.test(p)));
  assert.ok(checkPasswordPolicy("annalouise", "annalouise@example.com").some((p) => /email/.test(p)));
  assert.deepEqual(checkPasswordPolicy("pass phrase with spaces!", "a@example.com"), []);     // no forced symbol rules
});

// ---------- tokens, cookies ----------
test("tokens: random, long, only the hash is derivable; cookie attributes are secure", () => {
  const a = generateToken(), b = generateToken();
  assert.notEqual(a.token, b.token); assert.ok(a.token.length >= 40); assert.equal(a.tokenHash, hashToken(a.token)); assert.notEqual(a.token, a.tokenHash);
  const secure = buildSessionCookie(a.token, new Date(NOW0.getTime() + 3600_000), NOW0, true);
  for (const part of ["__Host-clipforge_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=3600", "Secure"]) assert.ok(secure.includes(part), part);
  assert.ok(!secure.includes("Domain"));
  const dev = buildSessionCookie(a.token, new Date(NOW0.getTime() + 3600_000), NOW0, false);
  assert.ok(dev.startsWith("clipforge_session=") && !dev.includes("Secure") && dev.includes("HttpOnly"));
  assert.ok(buildClearedSessionCookie(true).includes("Max-Age=0"));
  assert.ok(buildSessionCookie("t".repeat(43), new Date(NOW0.getTime() - 5), NOW0, true).includes("Max-Age=0"));  // never negative
});

test("reading the session cookie: only our names, only well-formed values, no injection", () => {
  const t = "A".repeat(43);
  assert.equal(readSessionToken(`a=b; __Host-clipforge_session=${t}; c=d`), t);
  assert.equal(readSessionToken(`clipforge_session=${t}`), t);
  for (const bad of [null, undefined, "", "other=1", "clipforge_session=short", `clipforge_session=${t}!`, `clipforge_session=${"A".repeat(200)}`, "x".repeat(9000), `evil_clipforge_session=${t}`]) assert.equal(readSessionToken(bad as never), null, String(bad).slice(0, 30));
});

// ---------- rate limiter ----------
test("rate limiter: locks after repeated failures, expires, and a success clears it", () => {
  const limiter = new InMemoryRateLimiter(3, 600_000, 900_000);
  for (let i = 0; i < 2; i++) limiter.recordFailure("k", NOW0);
  assert.equal(limiter.check("k", NOW0).allowed, true);
  limiter.recordFailure("k", NOW0);
  const locked = limiter.check("k", NOW0); assert.equal(locked.allowed, false); assert.equal(locked.retryAfterSeconds, 900);
  assert.equal(limiter.check("other", NOW0).allowed, true);
  assert.equal(limiter.check("k", new Date(NOW0.getTime() + 900_001)).allowed, true);
  limiter.recordFailure("j", NOW0); limiter.reset("j"); limiter.recordFailure("j", NOW0); limiter.recordFailure("j", NOW0); assert.equal(limiter.check("j", NOW0).allowed, true);
});

// ---------- registration & verification ----------
test("register: normalises the email, stores only a hash, sends one verification email, account starts unverified", async () => {
  const s = setup();
  assert.deepEqual(await s.service.register({ email: "  Ann@Example.COM ", password: GOOD_PASSWORD, name: "  Ann  " }), { ok: true });
  const user = [...s.repo.users.values()][0]!;
  assert.deepEqual([user.email, user.name, user.emailVerifiedAt, user.role], ["ann@example.com", "Ann", null, "user"]);
  assert.ok(user.passwordHash!.startsWith("scrypt$")); assert.ok(!JSON.stringify([...s.repo.users.values()]).includes(GOOD_PASSWORD));
  assert.equal(s.outbox.messages.length, 1); assert.equal(s.outbox.messages[0]!.to, "ann@example.com"); assert.match(s.outbox.messages[0]!.text, /\/verify-email\?token=/);
  const raw = s.tokenFromEmail(); const stored = [...s.repo.tokens.values()][0]!;
  assert.equal(stored.tokenHash, hashToken(raw)); assert.ok(!JSON.stringify([...s.repo.tokens.values()]).includes(raw)); // raw token never stored
});

test("register: invalid email/password rejected with reasons; nothing created or sent", async () => {
  const s = setup();
  for (const input of [{ email: "nope", password: GOOD_PASSWORD }, { email: "a@b", password: GOOD_PASSWORD }, { email: 5, password: GOOD_PASSWORD }, { email: "a@example.com", password: "short" }, { email: "a@example.com", password: 12345 }, { email: "a b@example.com", password: GOOD_PASSWORD }]) {
    const r = await s.service.register(input); assert.equal(r.ok, false, JSON.stringify(input)); assert.ok(!r.ok && r.problems.length > 0);
  }
  assert.equal(s.repo.users.size, 0); assert.equal(s.outbox.messages.length, 0);
});

test("register: an already-registered email gets the SAME answer and no second account or email (no enumeration)", async () => {
  const s = setup(); await s.service.register({ email: "ann@example.com", password: GOOD_PASSWORD });
  const again = await s.service.register({ email: "ANN@example.com", password: "another good password" });
  assert.deepEqual(again, { ok: true }); assert.equal(s.repo.users.size, 1); assert.equal(s.outbox.messages.length, 1);
});

test("verification: works once, expires after 24h, rejects junk; resend invalidates the old link", async () => {
  const s = setup(); await s.service.register({ email: "ann@example.com", password: GOOD_PASSWORD });
  const first = s.tokenFromEmail();
  assert.deepEqual(await s.service.resendVerification("ann@example.com"), { ok: true });
  assert.equal(s.outbox.messages.length, 2);
  assert.deepEqual(await s.service.verifyEmail(first), { ok: false });                    // older link no longer works
  const second = s.tokenFromEmail();
  assert.deepEqual(await s.service.verifyEmail(second), { ok: true });
  assert.deepEqual(await s.service.verifyEmail(second), { ok: false });                   // single use
  for (const junk of [undefined, null, 5, "", "short", "x".repeat(200)]) assert.deepEqual(await s.service.verifyEmail(junk), { ok: false });
  const late = setup(); await late.service.register({ email: "b@example.com", password: GOOD_PASSWORD });
  const t = late.tokenFromEmail(); late.advance(24 * 3_600_000 + 1);
  assert.deepEqual(await late.service.verifyEmail(t), { ok: false });
  assert.deepEqual(await s.service.resendVerification("nobody@example.com"), { ok: true }); assert.equal(s.outbox.messages.length, 2); // unknown: same answer, no mail
  assert.deepEqual(await s.service.resendVerification("ann@example.com"), { ok: true }); assert.equal(s.outbox.messages.length, 2);   // already verified: no mail
});

// ---------- login & sessions ----------
test("login: correct password after verification creates a session; the cookie token is not stored, only its hash", async () => {
  const s = await registered();
  const r = await s.service.login({ email: "ANN@example.com", password: GOOD_PASSWORD });
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(await s.service.getSessionUserId(r.sessionToken), r.userId);
  const stored = [...s.repo.sessions.values()][0]!;
  assert.equal(stored.tokenHash, hashToken(r.sessionToken)); assert.ok(!JSON.stringify([...s.repo.sessions.values()]).includes(r.sessionToken));
  assert.equal(r.expiresAt.getTime(), NOW0.getTime() + 30 * 86_400_000);
});

test("login: unknown account and wrong password give the IDENTICAL answer; unverified email cannot log in", async () => {
  const s = await registered();
  const wrong = await s.service.login({ email: "ann@example.com", password: "wrong password here" });
  const unknown = await s.service.login({ email: "ghost@example.com", password: "wrong password here" });
  assert.deepEqual(wrong, unknown); assert.deepEqual(wrong, { ok: false, code: "invalid_credentials" });
  assert.deepEqual(await s.service.login({ email: 5, password: null }), { ok: false, code: "invalid_credentials" });
  assert.deepEqual(await s.service.login({ email: "ann@example.com", password: "x".repeat(5000) }), { ok: false, code: "invalid_credentials" });
  await s.service.register({ email: "bob@example.com", password: GOOD_PASSWORD });       // never verified
  assert.deepEqual(await s.service.login({ email: "bob@example.com", password: GOOD_PASSWORD }), { ok: false, code: "email_not_verified" });
  assert.equal([...s.repo.sessions.values()].length, 0);
});

test("login: repeated failures lock the account (even for the right password), then it unlocks; success clears the count", async () => {
  const s = await registered();
  for (let i = 0; i < 3; i++) assert.equal((await s.service.login({ email: "ann@example.com", password: "bad password 123" })).ok, false);
  const locked = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD });
  assert.deepEqual([locked.ok, !locked.ok && locked.code, !locked.ok && locked.retryAfterSeconds], [false, "rate_limited", 900]);
  s.advance(900_001);
  assert.equal((await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD })).ok, true);
  for (let i = 0; i < 2; i++) await s.service.login({ email: "ann@example.com", password: "bad password 123" });
  await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD });         // success resets
  for (let i = 0; i < 2; i++) await s.service.login({ email: "ann@example.com", password: "bad password 123" });
  assert.equal((await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD })).ok, true);
  // Locking is per email: another account is unaffected; unknown emails are limited too.
  const ghost = { email: "ghost@example.com", password: "x".repeat(12) };
  for (let i = 0; i < 3; i++) await s.service.login(ghost);
  assert.equal((await s.service.login(ghost) as { code: string }).code, "rate_limited");
});

test("login: every login makes a NEW session (no fixation)", async () => {
  const s = await registered();
  const a = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD }); const b = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD });
  assert.ok(a.ok && b.ok && a.sessionToken !== b.sessionToken && s.repo.sessions.size === 2);
});

test("login: a stored hash weaker than today's settings is silently upgraded after a correct password", async () => {
  const s = await registered();
  const user = [...s.repo.users.values()][0]!; const weakHash = user.passwordHash!; assert.ok(weakHash.startsWith("scrypt$10$"));
  const stronger = new AuthService({ repo: s.repo, email: s.outbox, limiter: new InMemoryRateLimiter(), now: () => s.clock.now, newId: () => `x${Math.random()}`, config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: { logN: 11, r: 8, p: 1 } } });
  assert.equal((await stronger.login({ email: "ann@example.com", password: "wrong password here" })).ok, false);
  assert.equal(user.passwordHash, weakHash);                                                  // wrong password: untouched
  assert.equal((await stronger.login({ email: "ann@example.com", password: GOOD_PASSWORD })).ok, true);
  assert.ok(user.passwordHash!.startsWith("scrypt$11$")); assert.notEqual(user.passwordHash, weakHash);
  assert.equal(await verifyPassword(GOOD_PASSWORD, user.passwordHash!), true);
});

test("sessions: logout ends it; absolute expiry (30 days) and idle expiry (7 days) end it; garbage tokens do nothing", async () => {
  const s = await registered();
  const login = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD }); assert.ok(login.ok); if (!login.ok) return;
  assert.equal(await s.service.getSessionUserId(login.sessionToken), login.userId);
  await s.service.logout(login.sessionToken);
  assert.equal(await s.service.getSessionUserId(login.sessionToken), null);
  for (const junk of [null, "", "nope", "A".repeat(43)]) assert.equal(await s.service.getSessionUserId(junk), null);
  await s.service.logout(null); await s.service.logout("A".repeat(43));                    // harmless

  const idle = await registered(setup(), "idle@example.com"); const li = await idle.service.login({ email: "idle@example.com", password: GOOD_PASSWORD }); assert.ok(li.ok); if (!li.ok) return;
  idle.advance(6 * 86_400_000); assert.equal(await idle.service.getSessionUserId(li.sessionToken), li.userId);   // used on day 6: stays alive
  idle.advance(6 * 86_400_000); assert.equal(await idle.service.getSessionUserId(li.sessionToken), li.userId);   // day 12 but used within 7 days
  idle.advance(7 * 86_400_000 + 1); assert.equal(await idle.service.getSessionUserId(li.sessionToken), null);    // idle too long
  assert.ok([...idle.repo.sessions.values()].some((session) => session.revokedAt));

  const abs = await registered(setup(), "abs@example.com"); const la = await abs.service.login({ email: "abs@example.com", password: GOOD_PASSWORD }); assert.ok(la.ok); if (!la.ok) return;
  for (let day = 0; day < 29; day++) { abs.advance(86_400_000); assert.equal(await abs.service.getSessionUserId(la.sessionToken), la.userId); }
  abs.advance(2 * 86_400_000); assert.equal(await abs.service.getSessionUserId(la.sessionToken), null);           // past 30 days even though active
  assert.ok([...abs.repo.sessions.values()].some((session) => session.revokedAt));
});

test("login: email and IP limits are separate, a restart clears only the limiter, and the lock expires", async () => {
  const s = await registered();
  const ip = "203.0.113.10";
  for (let i = 0; i < 3; i++) assert.equal((await s.service.login({ email: "ann@example.com", password: "bad password 123", ip })).ok, false);
  const byEmail = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD, ip: "203.0.113.11" });
  assert.equal(!byEmail.ok && byEmail.code, "rate_limited");
  const other = await s.service.login({ email: "ghost@example.com", password: "bad password 123", ip: "203.0.113.11" });
  assert.equal(!other.ok && other.code, "invalid_credentials");
  for (let i = 0; i < 3; i++) await s.service.login({ email: "ghost@example.com", password: "bad password 123", ip });
  const byIp = await s.service.login({ email: "ghost@example.com", password: "another bad password", ip });
  const knownOnSameIp = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD, ip });
  assert.equal(!byIp.ok && byIp.code, "rate_limited");
  assert.deepEqual(knownOnSameIp, byIp);
  const restarted = new AuthService({ repo: s.repo, email: s.outbox, limiter: new InMemoryRateLimiter(3, 600_000, 900_000), now: () => s.clock.now, newId: () => `restart-${Math.random()}`, config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: FAST } });
  assert.equal((await restarted.login({ email: "ann@example.com", password: GOOD_PASSWORD, ip })).ok, true);
  const again = await registered();
  for (let i = 0; i < 3; i++) await again.service.login({ email: "ann@example.com", password: "bad password 123", ip });
  const lockedAgain = await again.service.login({ email: "ann@example.com", password: GOOD_PASSWORD, ip });
  assert.equal(lockedAgain.ok, false);
  if (!lockedAgain.ok) assert.equal(lockedAgain.code, "rate_limited");
  again.advance(900_001);
  assert.equal((await again.service.login({ email: "ann@example.com", password: GOOD_PASSWORD, ip })).ok, true);
});

// ---------- password reset ----------
test("password reset: generic answers, verified accounts only, 1h expiry, single use, new password works, old does not, ALL sessions end", async () => {
  const s = await registered();
  const s1 = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD }); const s2 = await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD });
  assert.ok(s1.ok && s2.ok); if (!s1.ok || !s2.ok) return;
  const before = s.outbox.messages.length;
  assert.deepEqual(await s.service.requestPasswordReset("ghost@example.com"), { ok: true }); assert.equal(s.outbox.messages.length, before);   // unknown: same answer, no mail
  await s.service.register({ email: "bob@example.com", password: GOOD_PASSWORD }); const afterReg = s.outbox.messages.length;
  assert.deepEqual(await s.service.requestPasswordReset("bob@example.com"), { ok: true }); assert.equal(s.outbox.messages.length, afterReg); // unverified: no reset mail
  assert.deepEqual(await s.service.requestPasswordReset("ANN@example.com"), { ok: true });
  assert.match(s.outbox.messages.at(-1)!.text, /\/reset-password\?token=/);
  const token = s.tokenFromEmail();

  assert.deepEqual(await s.service.resetPassword(token, "short"), { ok: false, problems: ["Password must be at least 10 characters."] });  // typo does NOT burn the link
  assert.deepEqual(await s.service.resetPassword("junk", "a brand new password"), { ok: false, problems: ["This reset link is not valid or has expired."] });
  assert.deepEqual(await s.service.resetPassword(token, "a brand new password"), { ok: true });
  assert.equal((await s.service.resetPassword(token, "another new password")).ok, false);                         // single use
  assert.equal(await s.service.getSessionUserId(s1.sessionToken), null); assert.equal(await s.service.getSessionUserId(s2.sessionToken), null);
  assert.equal((await s.service.login({ email: "ann@example.com", password: GOOD_PASSWORD })).ok, false);
  assert.equal((await s.service.login({ email: "ann@example.com", password: "a brand new password" })).ok, true);

  assert.deepEqual(await s.service.requestPasswordReset("ann@example.com"), { ok: true });
  const t2 = s.tokenFromEmail(); s.advance(3_600_001);
  assert.equal((await s.service.resetPassword(t2, "yet another password")).ok, false);                            // expired
  s.advance(900_001);                                                                                             // the reset rate limit unlocked
  await s.service.requestPasswordReset("ann@example.com"); const t3 = s.tokenFromEmail();
  s.advance(900_001);
  await s.service.requestPasswordReset("ann@example.com");                                                         // newer request replaces older link
  assert.equal((await s.service.resetPassword(t3, "yet another password")).ok, false);
});

test("password reset: a password that is the email does not consume the link, and one of two races wins", async () => {
  const s = await registered(setup(), "clipforgeuser@example.com");
  await s.service.requestPasswordReset("clipforgeuser@example.com");
  const token = s.tokenFromEmail();
  const rejected = await s.service.resetPassword(token, "clipforgeuser");
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.ok(rejected.problems.some((problem) => /email/i.test(problem)));
  assert.equal((await s.service.resetPassword(token, "a brand new password")).ok, true);
});

test("password reset: two simultaneous uses of one link - exactly one succeeds", async () => {
  const s = await registered(); await s.service.requestPasswordReset("ann@example.com"); const token = s.tokenFromEmail();
  const results = await Promise.all([s.service.resetPassword(token, "winner password one"), s.service.resetPassword(token, "winner password two")]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("email normalisation is consistent", () => { assert.equal(normaliseEmail("  A@B.Com "), "a@b.com"); });
