import { test } from "node:test";
import assert from "node:assert/strict";
import { runFirstAdminSeed } from "../scripts/seed-first-admin.ts";
import type { ModelDelegate, PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { POST as disabledBootstrapPost } from "../app/api/admin/bootstrap/route.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { adminLoginRoute } from "../src/server/auth/auth-routes.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { createLocalRuntime } from "../src/server/runtime.ts";
import { hashPassword } from "../src/server/auth/password.ts";

const connection = "postgresql://private-user:private-password@neon.example.test:5432/clipforge_test?sslmode=require&schema=public";
const target = "neon.example.test:5432/clipforge_test";
const password = "Synthetic strong admin password 2040!";

function environment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DIRECT_URL: connection,
    ADMIN_SEED_ALLOW_REMOTE: "true",
    ADMIN_SEED_EXPECTED_TARGET: target,
    ...overrides,
  };
}

function client(options: { admins?: number; existingUser?: boolean } = {}) {
  const users: Array<Record<string, unknown>> = options.admins
    ? Array.from({ length: options.admins }, (_, index) => ({ id: 'admin-' + index, email: 'admin-' + index + '@example.test', role: "admin" }))
    : [];
  if (options.existingUser) users.push({ id: "existing-user", email: "first-admin@example.test", role: "user" });
  const sessions: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; data: Record<string, unknown> }> = [];
  let lockCount = 0;
  let identityChecks = 0;
  let queue = Promise.resolve();
  const user = {
    count: async ({ where }: { where?: Record<string, unknown> } = {}) => where?.["role"] ? users.filter((row) => row["role"] === where["role"]).length : users.length,
    findUnique: async ({ where }: { where: Record<string, unknown> }) => users.find((row) => row["email"] === where["email"] || row["id"] === where["id"]) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = structuredClone(data); users.push(row); writes.push({ table: "user", data: row }); return row; },
  } as unknown as ModelDelegate;
  const session = { updateMany: async () => ({ count: sessions.length }) } as unknown as ModelDelegate;
  const auditLog = { create: async ({ data }: { data: Record<string, unknown> }) => { const row = structuredClone(data); audits.push(row); writes.push({ table: "auditLog", data: row }); return row; } } as unknown as ModelDelegate;
  const database = {
    user, session, auditLog,
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("current_database()")) {
        identityChecks++;
        return [{ databaseName: "clipforge_test", schemaName: "public" }];
      }
      lockCount++;
      return [{ locked: true }];
    },
    $transaction: async (work: (tx: PrismaClientLike) => Promise<unknown>) => {
      let release!: () => void;
      const next = new Promise<void>((resolve) => { release = resolve; });
      const previous = queue;
      queue = next;
      await previous;
      try { return await work(database as unknown as PrismaClientLike); }
      finally { release(); }
    },
    $disconnect: async () => undefined,
  };
  return { database: database as unknown as PrismaClientLike, writes, lockCount: () => lockCount, identityChecks: () => identityChecks };
}

test("target preview prints hostname and database only, without connecting", async () => {
  let connectCount = 0;
  let output = "";
  await runFirstAdminSeed(["--inspect-target"], {
    environment: { DIRECT_URL: connection },
    createClient: async () => { connectCount++; throw new Error("must not connect"); },
    write: (text) => { output += text; },
  });
  assert.equal(connectCount, 0);
  assert.match(output, /Candidate host: neon\.example\.test/);
  assert.match(output, /Candidate database: clipforge_test/);
  assert.doesNotMatch(output, /private-user|private-password|postgresql:\/\//);
});

test("remote target requires explicit allow flag before connecting", async () => {
  let connectCount = 0;
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment({ ADMIN_SEED_ALLOW_REMOTE: undefined }),
    createClient: async () => { connectCount++; throw new Error("must not connect"); },
  }), /ADMIN_SEED_ALLOW_REMOTE=true/);
  assert.equal(connectCount, 0);
});

test("expected target mismatch refuses connection", async () => {
  let connectCount = 0;
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment({ ADMIN_SEED_EXPECTED_TARGET: "other.example.test:5432/other_db" }),
    createClient: async () => { connectCount++; throw new Error("must not connect"); },
  }), /must exactly match/);
  assert.equal(connectCount, 0);
});

test("existing Admin blocks creation without writes", async () => {
  const fake = client({ admins: 1 });
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async (phrase) => phrase,
  }), /An Admin already exists/);
  assert.equal(fake.writes.length, 0);
});

test("existing email account is rejected and never promoted", async () => {
  const fake = client({ existingUser: true });
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async (phrase) => phrase,
  }), /existing users are never promoted/);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.lockCount(), 1);
});

test("wrong confirmation prevents transaction and all writes", async () => {
  const fake = client();
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async () => "no",
  }), /Confirmation phrase did not match/);
  assert.equal(fake.lockCount(), 0);
  assert.equal(fake.writes.length, 0);
});

test("successful provisioning hashes the password and creates a verified Admin and audit row atomically without logging credentials", async () => {
  const fake = client(); let output = "";
  let hashInput = "";
  await runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async (phrase) => phrase,
    hashPassword: async (value) => { hashInput = value; return "synthetic-hash-" + value.length; },
    newId: () => "new-admin-id", now: () => new Date("2040-01-01T00:00:00.000Z"),
    write: (text) => { output += text; },
  });
  assert.equal(fake.lockCount(), 1);
  assert.equal(fake.writes.length, 2);
  assert.deepEqual(fake.writes[0], {
    table: "user",
    data: {
      id: "new-admin-id", email: "first-admin@example.test", emailVerified: new Date("2040-01-01T00:00:00.000Z"),
      passwordHash: `synthetic-hash-${password.length}`, name: null, role: "admin", createdAt: new Date("2040-01-01T00:00:00.000Z"),
    },
  });
  assert.equal(fake.writes[1]?.table, "auditLog");
  assert.equal(fake.writes[1]?.data["action"], "admin.first_account_seeded");
  assert.equal(hashInput, password);
  assert.equal((fake.writes[0]?.data["emailVerified"] as Date).getTime(), new Date("2040-01-01T00:00:00.000Z").getTime());
  assert.doesNotMatch(output, new RegExp(password));
  assert.doesNotMatch(output, /private-user|private-password|postgresql:\/\//);
});

test("concurrent seed attempts create at most one Admin", async () => {
  const fake = client();
  const seed = (email: string) => runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email, password }), confirm: async (phrase) => phrase,
    hashPassword: async () => "synthetic-password-hash", newId: () => email,
  });
  const results = await Promise.allSettled([seed("first-admin@example.test"), seed("second-admin@example.test")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(fake.writes.filter((write) => write.table === "user" && write.data["role"] === "admin").length, 1);
  assert.equal(fake.writes.filter((write) => write.table === "auditLog").length, 1);
});

test("a competing provisioning lock fails without holding a transaction open or writing", async () => {
  const fake = client();
  fake.database.$queryRaw = async (strings: TemplateStringsArray) => strings.join("").includes("current_database()")
    ? [{ databaseName: "clipforge_test", schemaName: "public" }]
    : [{ locked: false }];
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async (phrase) => phrase,
  }), /Another Admin provisioning operation is in progress/);
  assert.equal(fake.writes.length, 0);
});

test("incorrect typed target confirmation prevents writes", async () => {
  const fake = client();
  await assert.rejects(runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }), confirm: async () => "wrong target",
  }), /Confirmation phrase did not match/);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.lockCount(), 0);
});

test("the former public bootstrap endpoint is disabled", async () => {
  const response = disabledBootstrapPost();
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), { error: "admin_bootstrap_disabled" });
});

test("the provisioned verified Admin can sign in through the existing Admin login flow", async () => {
  const fake = client();
  await runFirstAdminSeed([], {
    environment: environment(), createClient: async () => fake.database,
    promptCredentials: async () => ({ email: "first-admin@example.test", password }),
    confirm: async (phrase) => phrase,
    hashPassword: async (value) => hashPassword(value, { logN: 10, r: 8, p: 1 }),
    newId: () => "login-admin", now: () => new Date("2040-01-01T00:00:00.000Z"), write: () => undefined,
  });
  const created = fake.writes.find((write) => write.table === "user")!.data;
  const authRepo = new MemoryAuthRepository();
  await authRepo.createUser({
    id: String(created["id"]), email: String(created["email"]), name: null, role: "admin",
    passwordHash: String(created["passwordHash"]), emailVerifiedAt: created["emailVerified"] as Date,
    createdAt: created["createdAt"] as Date,
  });
  const auth = new AuthService({
    repo: authRepo, email: new MemoryEmailOutbox(), limiter: new InMemoryRateLimiter(),
    newId: () => "session-id", now: () => new Date("2040-01-01T00:01:00.000Z"),
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), scrypt: { logN: 10, r: 8, p: 1 }, requireVerifiedEmail: true },
  });
  const runtime = { ...createLocalRuntime(), auth };
  const response = await adminLoginRoute(() => runtime)(new Request("http://localhost:3000/api/admin/login", {
    method: "POST",
    headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "first-admin@example.test", password }),
  }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin");
  assert.match(response.headers.get("set-cookie") ?? "", /clipforge_session=/);
});
