// Database-mode authentication. Persistence cases run only for the isolated local database.
// A refused database must surface as database_unavailable and must not create an in-memory account.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { MemoryEmailOutbox, UnavailableEmailSender } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashToken } from "../src/server/auth/tokens.ts";
import { AppError } from "../src/server/errors.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { createDatabaseRuntime, getRuntime, setDatabaseConnectorForTests, setRuntimeForTests } from "../src/server/runtime.ts";
import { registerRoute } from "../src/server/auth/auth-routes.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const FAST = { logN: 10, r: 8, p: 1 };
const PASSWORD = "a real database password";
const databaseUrlAtStart = isolatedDatabaseUrl();
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

test("production selects the PostgreSQL runtime from DATABASE_URL, never DIRECT_URL or memory flags", async () => serial(async () => {
  const client = new FakePrismaClient();
  let receivedConnectionString: string | undefined;
  const logs: string[] = [];
  const previousInfo = console.info;
  const previousError = console.error;
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  setRuntimeForTests(null);
  setDatabaseConnectorForTests(async (connectionString) => { receivedConnectionString = connectionString; return client; });
  try {
    const runtime = getRuntime({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.example/clipforge",
      DIRECT_URL: "postgresql://direct.example/clipforge",
      CLIPFORGE_LOCAL_AUTH: "true",
      CLIPFORGE_DEMO_MODE: "true",
    });
    assert.equal(runtime.mode, "database");
    assert.deepEqual(await runtime.auth!.login({ email: "nobody@example.test", password: PASSWORD }), { ok: false, code: "invalid_credentials" });
    assert.equal(receivedConnectionString, "postgresql://database.example/clipforge");

    setDatabaseConnectorForTests(async () => client);
    const noRuntimeUrl = getRuntime({ NODE_ENV: "production", DIRECT_URL: "postgresql://direct.example/clipforge" });
    assert.equal(noRuntimeUrl.mode, "unconfigured");
    assert.equal(noRuntimeUrl.auth, undefined);
    assert.match(logs.join("\n"), /database_runtime_unconfigured/);
    assert.match(logs.join("\n"), /"errorCategory":"missing_configuration"/);
    assert.doesNotMatch(logs.join("\n"), /database\.example|direct\.example|postgresql:\/\//);
  } finally {
    setDatabaseConnectorForTests(null);
    setRuntimeForTests(null);
    console.info = previousInfo;
    console.error = previousError;
  }
}));

test("failed database ping is logged without secrets and the same runtime can retry", async () => serial(async () => {
  const client = new FakePrismaClient();
  const originalQuery = client.$queryRaw.bind(client);
  let attempts = 0;
  const lines: string[] = [];
  const oldInfo = console.info;
  const oldError = console.error;
  const oldDateNow = Date.now;
  let fakeTime = 100_000;
  Date.now = () => fakeTime;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const runtime = createDatabaseRuntime("postgresql://do-not-log:private-marker@db.example/clipforge", async () => {
    attempts += 1;
    if (attempts === 1) client.$queryRaw = async () => { throw Object.assign(new Error("private-marker"), { code: "P1001" }); };
    else client.$queryRaw = originalQuery;
    return client;
  }, { scrypt: FAST });
  try {
    await assert.rejects(() => runtime.auth!.register({ email: "nobody@example.test", password: PASSWORD }), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
    await assert.rejects(() => runtime.auth!.register({ email: "nobody@example.test", password: PASSWORD }), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
    assert.equal(attempts, 1); // A brief outage does not trigger a connection attempt and log on every request.
    fakeTime += 5_000;
    assert.deepEqual(await runtime.auth!.register({ email: "nobody@example.test", password: PASSWORD }), { ok: true });
    assert.equal(attempts, 2);
    const logs = lines.join("\n");
    assert.match(logs, /database_connection_check_started/);
    assert.match(logs, /database_connection_failed/);
    assert.match(logs, /database_connection_success/);
    assert.match(logs, /"errorCode":"P1001"/);
    assert.doesNotMatch(logs, /private-marker|do-not-log|db\.example|clipforge/);
  } finally {
    console.info = oldInfo;
    console.error = oldError;
    Date.now = oldDateNow;
  }
}));

test("database auth query failures are logged with a safe category, not their message", async () => serial(async () => {
  const client = new FakePrismaClient();
  const lines: string[] = [];
  const oldInfo = console.info;
  const oldError = console.error;
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  client.user.create = async () => { throw Object.assign(new Error("email-and-password-must-not-be-logged"), { code: "P2022" }); };
  const runtime = createDatabaseRuntime("postgresql://private-marker@db.example/clipforge", async () => client);
  try {
    await assert.rejects(() => runtime.auth!.register({ email: "private-email@example.test", password: PASSWORD }), (error: unknown) => error instanceof AppError && error.code === "database_unavailable");
    const logs = lines.join("\n");
    assert.match(logs, /database_connection_success/);
    assert.match(logs, /database_query_failed/);
    assert.match(logs, /"operation":"auth.createUser"/);
    assert.match(logs, /"errorCategory":"schema"/);
    assert.match(logs, /"errorCode":"P2022"/);
    assert.doesNotMatch(logs, /email-and-password|private-email|private-marker|db\.example/);
  } finally {
    console.info = oldInfo;
    console.error = oldError;
  }
}));

test("complimentary schema mismatch maps to setup-required and logs only safe diagnostics", async () => serial(async () => {
  const client = new FakePrismaClient();
  const lines: string[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  client.complimentaryAccessGrant.findMany = async () => {
    throw Object.assign(new Error("private database detail and user marker"), {
      code: "P2021",
      meta: { table: "public.ComplimentaryAccessGrant", user: "private-user-marker" },
    });
  };
  const runtime = createDatabaseRuntime("postgresql://private-marker@db.example/clipforge", async () => client);
  try {
    await assert.rejects(() => runtime.repo.listComplimentaryAccessForUser("private-user-marker"), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "complimentary_access_setup_required");
      assert.match(error.message, /DATABASE_URL/);
      return true;
    });
    const logs = lines.join("\n");
    assert.match(logs, /"event":"database_query_failed"/);
    assert.match(logs, /"operation":"repository.listComplimentaryAccessForUser"/);
    assert.match(logs, /"errorCategory":"schema"/);
    assert.match(logs, /"errorCode":"P2021"/);
    assert.doesNotMatch(logs, /private database detail|private-user-marker|private-marker|db\.example|clipforge|postgresql:\/\//);
  } finally {
    console.error = oldError;
  }
}));

test("signup and login persist users and sessions through the PostgreSQL auth repository", async () => {
  const client = new FakePrismaClient();
  const runtime = createDatabaseRuntime("postgresql://private-marker@db.example/clipforge", async () => client, { scrypt: FAST });
  const email = `persist-${randomUUID()}@example.test`;
  assert.deepEqual(await runtime.auth!.register({ email, password: PASSWORD }), { ok: true });
  assert.equal(await client.user.count(), 1);
  const login = await runtime.auth!.login({ email, password: PASSWORD });
  assert.equal(login.ok, true);
  assert.equal(await client.session.count(), 1);
  const google = await runtime.auth!.completeGoogleSignIn({ sub: `google-${randomUUID()}`, email: `google-${randomUUID()}@example.test`, emailVerified: true, name: "Google User" }, null);
  assert.equal(google.ok && google.created, true);
  assert.equal(await client.googleIdentity.count(), 1);
  assert.equal(await client.session.count(), 2);
});

test("database mode does not send or store a verification message", async () => {
  const email = new UnavailableEmailSender();
  let calls = 0;
  const runtime = createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => {
    calls += 1;
    return { $queryRaw: async () => [], user: { async create() { return {}; }, async findUnique() { return null; } } } as unknown as PrismaClientLike;
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
    assert.ok((await repo.getSessionByTokenHash(hashToken(again.sessionToken)))?.revokedAt);
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

test("password reset on PostgreSQL commits the password and session revocation together", { skip: hasDatabase ? false : "DATABASE_URL is not set for this process" }, async () => serial(async () => {
  const db = await createPrismaClient(databaseUrlAtStart as string);
  const closer = db as unknown as { $disconnect(): Promise<void>; user: { delete(args: { where: { email: string } }): Promise<unknown> } };
  const email = `phase10f-${randomUUID()}@clipforge.test`;
  const local = email.split("@")[0]!;
  const repo = new PrismaAuthRepository(db);
  const outbox = new MemoryEmailOutbox();
  const clock = { now: new Date("2026-11-07T12:00:00Z") };
  const service = new AuthService({
    repo, email: outbox, limiter: new InMemoryRateLimiter(), now: () => clock.now, newId: () => randomUUID(),
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), requireVerifiedEmail: true, scrypt: FAST },
  });
  const tokenFrom = () => new URL(outbox.messages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
  try {
    assert.equal((await service.register({ email, password: PASSWORD })).ok, true);
    assert.equal((await service.verifyEmail(tokenFrom())).ok, true);
    const first = await service.login({ email, password: PASSWORD });
    const second = await service.login({ email, password: PASSWORD });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    await service.requestPasswordReset(email);
    const reset = tokenFrom();
    const rejected = await service.resetPassword(reset, local);
    assert.equal(rejected.ok, false);
    assert.equal(await service.getSessionUserId(first.sessionToken), first.userId);
    const raced = await Promise.all([service.resetPassword(reset, "replacement database password"), service.resetPassword(reset, "other replacement password")]);
    assert.equal(raced.filter((result) => result.ok).length, 1);
    assert.equal(await service.getSessionUserId(first.sessionToken), null);
    assert.equal(await service.getSessionUserId(second.sessionToken), null);
    assert.ok((await repo.getSessionByTokenHash(hashToken(first.sessionToken)))?.revokedAt);
    assert.equal((await service.login({ email, password: PASSWORD })).ok, false);
    const changed = await service.login({ email, password: "replacement database password" });
    if (!changed.ok) {
      const alternate = await service.login({ email, password: "other replacement password" });
      assert.equal(alternate.ok, true);
    }
  } finally {
    await closer.user.delete({ where: { email } }).catch(() => undefined);
    await closer.$disconnect();
  }
}));

after(() => { setDatabaseConnectorForTests(null); setRuntimeForTests(null); });
