import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createLocalRuntime } from "../src/server/runtime.ts";
import { registerRoute, adminLoginRoute } from "../src/server/auth/auth-routes.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashPassword } from "../src/server/auth/password.ts";

const password = "A strong admin password 2026!";
const now = new Date("2026-11-13T00:00:00.000Z");
test("Admin login refuses an unverified Admin even when ordinary login verification is disabled", async () => {
  const repo = new MemoryAuthRepository();
  const unverifiedPassword = await hashPassword(password, { logN: 10, r: 8, p: 1 });
  await repo.createUser({ id: "unverified-admin", email: "admin@example.test", emailVerifiedAt: null, passwordHash: unverifiedPassword, name: null, role: "admin", createdAt: now });
  const auth = new AuthService({ repo, email: new MemoryEmailOutbox(), limiter: new InMemoryRateLimiter(), now: () => now, newId: () => "session-id", config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: { logN: 10, r: 8, p: 1 }, requireVerifiedEmail: false } });
  const runtime = { ...createLocalRuntime(), auth };
  const body = new URLSearchParams({ email: "admin@example.test", password });
  const response = await adminLoginRoute(() => runtime)(new Request("http://localhost:3000/api/admin/login", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location")?.includes("admin_login_failed"), true);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("normal signup ignores role: admin", async () => {
  const runtime = createLocalRuntime({ scrypt: { logN: 10, r: 8, p: 1 } });
  const authRepo = new MemoryAuthRepository();
  const auth = new AuthService({ repo: authRepo, email: runtime.outbox!, limiter: new InMemoryRateLimiter(), now: () => now, newId: () => randomBytes(12).toString("hex"), config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: { logN: 10, r: 8, p: 1 }, requireVerifiedEmail: true } });
  const signupRuntime = { ...runtime, auth };
  const body = new URLSearchParams({ email: "ordinary@example.test", password, role: "admin" });
  const response = await registerRoute(() => signupRuntime)(new Request("http://localhost:3000/api/auth/register", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body }));
  assert.equal(response.status, 303);
  const user = await authRepo.getUserByEmail("ordinary@example.test");
  assert.equal(user?.role, "user");
});

/* Retired fake-repository tests for the removed email-verification bootstrap implementation. */
/*
// Small transactional in-memory Prisma double. Fake repository results are not PostgreSQL verification.
type State = { users: Row[]; sessions: Row[]; registrations: Row[]; audits: Row[] };
const matches = (row: Row, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, expected]) => {
  const actual = row[key];
  if (expected && typeof expected === "object" && !(expected instanceof Date)) {
    const operators = expected as Record<string, unknown>;
    return Object.entries(operators).every(([op, value]) => op === "gt" ? actual instanceof Date && value instanceof Date && actual > value : op === "not" ? actual !== value : false);
  }
  return actual === expected;
});
function fakePrisma(initial: State = { users: [], sessions: [], registrations: [], audits: [] }) {
  let current = structuredClone(initial); let queue = Promise.resolve();
  const delegates = (state: State): PrismaClientLike => {
    const make = (table: keyof State): ModelDelegate => ({
      findUnique: async ({ where }) => state[table].find((row) => matches(row, where)) ?? null,
      findFirst: async ({ where } = {}) => state[table].find((row) => matches(row, where)) ?? null,
      findMany: async ({ where } = {}) => state[table].filter((row) => matches(row, where)),
      count: async ({ where } = {}) => state[table].filter((row) => matches(row, where)).length,
      create: async ({ data }) => { const row = structuredClone(data); if (table === "users" && row["role"] === undefined) row["role"] = "user"; state[table].push(row); return row; },
      createMany: async ({ data }) => { state[table].push(...structuredClone(data)); return { count: data.length }; },
      update: async ({ where, data }) => { const row = state[table].find((item) => matches(item, where)); if (!row) throw new Error("missing row"); Object.assign(row, data); return row; },
      updateMany: async ({ where, data }) => { const rows = state[table].filter((item) => matches(item, where)); for (const row of rows) Object.assign(row, data); return { count: rows.length }; },
      upsert: async ({ where, create, update }) => { const row = state[table].find((item) => matches(item, where)); if (row) { Object.assign(row, update); return row; } state[table].push(structuredClone(create)); return create; },
      aggregate: async () => ({ _sum: {} }), groupBy: async () => [], deleteMany: async () => ({ count: 0 }),
    });
    const client = {
      user: make("users"), session: make("sessions"), adminRegistration: make("registrations"), auditLog: make("audits"),
      $queryRaw: async () => [],
      $transaction: async <T>(work: (tx: PrismaClientLike) => Promise<T>) => work(delegates(state)),
    } as unknown as PrismaClientLike;
    return client;
  };
  const db = {
    ...delegates(current),
    $transaction: async <T>(work: (tx: PrismaClientLike) => Promise<T>): Promise<T> => {
      let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); const previous = queue; queue = next; await previous;
      const draft = structuredClone(current);
      try { const result = await work(delegates(draft)); current = draft; return result; } finally { release(); }
    },
  } as unknown as PrismaClientLike;
  return { db, get state() { return current; } };
}
const registrationInput = (id: string, tokenHash: string, expiresAt = new Date(now.getTime() + 86_400_000)) => ({ id, email: "arbaazkhanark23@gmail.com", passwordHash: "scrypt$synthetic", tokenHash, expiresAt, now });

test("repository serializes duplicate first-Admin registration and writes only one pending registration", async () => {
  const fake = fakePrisma(); const repo = new PrismaAdminBootstrapRepository(fake.db);
  const outcomes = await Promise.all([repo.requestRegistration(registrationInput("one", "hash-one")), repo.requestRegistration(registrationInput("two", "hash-two"))]);
  assert.deepEqual(outcomes.sort(), ["pending", "registration_pending"]);
  assert.equal(fake.state.registrations.length, 1);
  assert.equal(fake.state.users.filter((user) => user["role"] === "admin").length, 0);
  assert.equal(fake.state.audits.length, 1);
});

test("repository blocks an existing Admin and an account conflict", async () => {
  const admin = fakePrisma({ users: [{ id: "a", email: "admin@example.test", role: "admin" }], sessions: [], registrations: [], audits: [] });
  const adminRepo = new PrismaAdminBootstrapRepository(admin.db);
  assert.equal(await adminRepo.isFirstAdminAvailable(), false);
  assert.equal(await adminRepo.requestRegistration(registrationInput("x", "h")), "admin_exists");
  const conflict = fakePrisma({ users: [{ id: "other", email: "arbaazkhanark23@gmail.com", role: "owner" }], sessions: [], registrations: [], audits: [] });
  assert.equal(await new PrismaAdminBootstrapRepository(conflict.db).requestRegistration(registrationInput("x", "h")), "account_conflict");
});

test("repository verification creates verified Admin, consumes token, revokes sessions and audits atomically", async () => {
  const tokenHash = hashToken("c".repeat(43));
  const fake = fakePrisma({
    users: [{ id: "existing-user", email: "arbaazkhanark23@gmail.com", role: "user", emailVerified: null, passwordHash: null }],
    sessions: [{ id: "session", userId: "existing-user", revokedAt: null }],
    registrations: [{ id: "reg", email: "arbaazkhanark23@gmail.com", passwordHash: "scrypt$synthetic", tokenHash, expiresAt: new Date(now.getTime() + 1000), usedAt: null }], audits: [],
  });
  const repo = new PrismaAdminBootstrapRepository(fake.db);
  assert.deepEqual(await repo.verifyRegistration({ tokenHash, userId: "unused", now }), { status: "activated", userId: "existing-user", revokedSessions: 1 });
  assert.equal(fake.state.users[0]?.["role"], "admin");
  assert.equal((fake.state.users[0]?.["emailVerified"] as Date).getTime(), now.getTime());
  assert.equal(fake.state.users[0]?.["passwordHash"], "scrypt$synthetic");
  assert.equal(fake.state.sessions[0]?.["revokedAt"], now);
  assert.equal(fake.state.registrations[0]?.["usedAt"], now);
  assert.equal(fake.state.registrations[0]?.["passwordHash"], null);
  assert.equal(fake.state.audits.at(-1)?.["action"], "admin.first_bootstrap_activated");
});

test("repository creates a new user with the database normal-user default before setting Admin inside verification transaction", async () => {
  const tokenHash = hashToken("n".repeat(43));
  const fake = fakePrisma({ users: [], sessions: [], registrations: [{ id: "reg-new", email: "arbaazkhanark23@gmail.com", passwordHash: "scrypt$new", tokenHash, expiresAt: new Date(now.getTime() + 1000), usedAt: null }], audits: [] });
  const result = await new PrismaAdminBootstrapRepository(fake.db).verifyRegistration({ tokenHash, userId: "new-admin", now });
  assert.deepEqual(result, { status: "activated", userId: "new-admin", revokedSessions: 0 });
  assert.equal(fake.state.users[0]?.["role"], "admin");
  assert.equal((fake.state.users[0]?.["emailVerified"] as Date).getTime(), now.getTime());
  assert.equal(fake.state.audits.at(-1)?.["action"], "admin.first_bootstrap_activated");
});

test("repository rejects expired or reused verification tokens and concurrent activation has one winner", async () => {
  const expiredHash = hashToken("d".repeat(43));
  const fake = fakePrisma({ users: [], sessions: [], registrations: [{ id: "expired", email: "arbaazkhanark23@gmail.com", passwordHash: "hash", tokenHash: expiredHash, expiresAt: new Date(now.getTime() - 1), usedAt: null }], audits: [] });
  const repo = new PrismaAdminBootstrapRepository(fake.db);
  assert.deepEqual(await repo.verifyRegistration({ tokenHash: expiredHash, userId: "x", now }), { status: "invalid" });
  const validHash = hashToken("e".repeat(43));
  await repo.requestRegistration(registrationInput("active", validHash));
  const results = await Promise.all([repo.verifyRegistration({ tokenHash: validHash, userId: "one", now }), repo.verifyRegistration({ tokenHash: validHash, userId: "two", now })]);
  assert.equal(results.filter((result) => result.status === "activated").length, 1);
  assert.equal(fake.state.users.filter((user) => user["role"] === "admin").length, 1);
});

test("audit failure rolls back registration, and a failed mail can invalidate the pending hash", async () => {
  const fake = fakePrisma(); const base = fake.db;
  const failing = { ...base, $transaction: async <T>(work: (tx: PrismaClientLike) => Promise<T>) => base.$transaction(async (tx) => work({ ...tx, auditLog: { create: async () => { throw new Error("audit unavailable"); } } as unknown as ModelDelegate })) } as PrismaClientLike;
  await assert.rejects(() => new PrismaAdminBootstrapRepository(failing).requestRegistration(registrationInput("x", "hash")));
  assert.equal(fake.state.registrations.length, 0);
  assert.equal(fake.state.audits.length, 0);

  const tokenHash = hashToken("f".repeat(43));
  await new PrismaAdminBootstrapRepository(fake.db).requestRegistration(registrationInput("x", tokenHash));
  await new PrismaAdminBootstrapRepository(fake.db).invalidateRegistration(tokenHash, now);
  assert.equal(fake.state.registrations[0]?.["passwordHash"], null);
  assert.equal(fake.state.registrations[0]?.["usedAt"], now);
  assert.equal(fake.state.audits.at(-1)?.["action"], "admin.bootstrap_email_failed");
});
*/
