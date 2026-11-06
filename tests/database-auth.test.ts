// Database-mode authentication. The Neon cases run only when DATABASE_URL is set.
// A refused database must surface as database_unavailable and must not create an in-memory account.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { UnavailableEmailSender } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashToken } from "../src/server/auth/tokens.ts";
import { AppError } from "../src/server/errors.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { createDatabaseRuntime, getRuntime, setDatabaseConnectorForTests, setRuntimeForTests } from "../src/server/runtime.ts";
import { registerRoute } from "../src/server/auth/auth-routes.ts";

const FAST = { logN: 10, r: 8, p: 1 };
const PASSWORD = "a real database password";
const databaseUrlAtStart = process.env["DATABASE_URL"];
const hasDatabase = Boolean(databaseUrlAtStart);
let sequence: Promise<unknown> = Promise.resolve();
const serial = <T>(work: () => Promise<T>): Promise<T> => {
  const run = sequence.then(work, work);
  sequence = run.then(() => undefined, () => undefined);
  return run;
};

test("a database connection failure is reported and does not fall back to memory", async () => serial(async () => {
  const previous = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = "postgresql://127.0.0.1:9/clipforge";
  setDatabaseConnectorForTests(async () => { throw new Error("connection refused"); });
  setRuntimeForTests(null);
  try {
    const runtime = getRuntime();
    assert.equal(runtime.mode, "database");
    assert.equal(runtime.emailDelivery, "unavailable");
    assert.equal(runtime.outbox, undefined);
    await assert.rejects(() => runtime.auth!.register({ email: "ann@example.com", password: PASSWORD }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "database_unavailable");
      return true;
    });
    const response = await registerRoute(() => runtime)(new Request("http://localhost:3000/api/auth/register", {
      method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "ann@example.com", password: PASSWORD }).toString(),
    }));
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /error=database_unavailable$/);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    setDatabaseConnectorForTests(null);
    setRuntimeForTests(null);
    if (previous === undefined) delete process.env["DATABASE_URL"]; else process.env["DATABASE_URL"] = previous;
    delete (globalThis as { __clipforgeDatabaseRuntime?: unknown }).__clipforgeDatabaseRuntime;
  }
}));

test("database mode does not send or store a verification message", async () => {
  const email = new UnavailableEmailSender();
  let calls = 0;
  const runtime = createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => {
    calls += 1;
    return { user: { async create() { return {}; }, async findUnique() { return null; } } } as unknown as PrismaClientLike;
  }, { scrypt: FAST });
  assert.deepEqual(await runtime.auth!.register({ email: "Ann@Example.com", password: PASSWORD }), { ok: true });
  assert.equal(calls, 1);
  await assert.rejects(() => email.send({ to: "ann@example.com", subject: "no", text: "no" }), (error: unknown) => error instanceof AppError && error.code === "email_not_configured");
});

test("Neon registration, duplicate email, bad password, login, logout, and session expiry", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => serial(async () => {
  const connectionString = databaseUrlAtStart as string;
  const db = await createPrismaClient(connectionString);
  const closer = db as unknown as { $disconnect(): Promise<void>; user: { delete(args: { where: { email: string } }): Promise<unknown> } };
  const email = `phase3a-${randomUUID()}@clipforge.test`;
  const repo = new PrismaAuthRepository(db);
  const clock = { now: new Date("2026-11-06T12:00:00Z") };
  const service = new AuthService({
    repo, email: new UnavailableEmailSender(), limiter: new InMemoryRateLimiter(), now: () => clock.now, newId: () => randomUUID(),
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), requireVerifiedEmail: false, scrypt: FAST, sessionAbsoluteMs: 60_000, sessionIdleMs: 30_000 },
  });
  try {
    assert.deepEqual(await service.register({ email: `  ${email.toUpperCase()} `, password: "short" }), { ok: false, problems: ["Password must be at least 10 characters."] });
    assert.equal((await service.register({ email, password: PASSWORD })).ok, true);
    const stored = await repo.getUserByEmail(email);
    assert.ok(stored);
    assert.equal(stored.email, email);
    assert.equal(stored.emailVerifiedAt, null);
    const passwordHash = stored.passwordHash ?? "";
    assert.ok(passwordHash.startsWith("scrypt$"));
    assert.equal(passwordHash.includes(PASSWORD), false);
    assert.equal((await service.register({ email, password: PASSWORD })).ok, true);
    assert.equal((await repo.getUserByEmail(email))?.id, stored.id);

    const sessions = db as unknown as { session: { count(args: { where: { userId: string } }): Promise<number> } };
    const wrong = await service.login({ email, password: "not the password" });
    assert.deepEqual(wrong, { ok: false, code: "invalid_credentials" });
    assert.equal(await sessions.session.count({ where: { userId: stored.id } }), 0);

    const login = await service.login({ email, password: PASSWORD });
    assert.equal(login.ok, true);
    if (!login.ok) return;
    assert.equal(await service.getSessionUserId(login.sessionToken), stored.id);
    const session = await repo.getSessionByTokenHash(hashToken(login.sessionToken));
    assert.ok(session);
    assert.notEqual(session.tokenHash, login.sessionToken);
    assert.equal(session.userId, stored.id);

    await service.logout(login.sessionToken);
    assert.equal(await service.getSessionUserId(login.sessionToken), null);
    assert.ok((await repo.getSessionByTokenHash(hashToken(login.sessionToken)))?.revokedAt);

    const again = await service.login({ email, password: PASSWORD });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    clock.now = new Date(clock.now.getTime() + 31_000);
    assert.equal(await service.getSessionUserId(again.sessionToken), null);
    const third = await service.login({ email, password: PASSWORD });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    clock.now = new Date(clock.now.getTime() + 61_000);
    assert.equal(await service.getSessionUserId(third.sessionToken), null);
  } finally {
    await closer.user.delete({ where: { email } }).catch(() => undefined);
    await closer.$disconnect();
  }
}));

after(() => { setDatabaseConnectorForTests(null); setRuntimeForTests(null); });
