import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { assertWebDatabaseIdentity, assertWorkerDatabaseIdentity, parseSafeDatabaseTarget, WorkerDatabaseIdentityError } from "../src/server/workers/database-identity-guard.ts";
import { getRuntime, setDatabaseConnectorForTests, setRuntimeForTests } from "../src/server/runtime.ts";
import { runContinuousWorker, type WorkerSignals } from "../src/server/workers/continuous-worker.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";

test("production worker requires the configured database host and name to match without exposing the URL", () => {
  const url = "postgresql://private-user:private-password@db.dev.example:5432/clipforge_dev?sslmode=require";
  const expected = { CLIPFORGE_EXPECTED_DATABASE_HOST: "DB.DEV.EXAMPLE", CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_dev", CLIPFORGE_EXPECTED_DATABASE_PORT: "5432" };
  assert.doesNotThrow(() => assertWorkerDatabaseIdentity({
    NODE_ENV: "production", DATABASE_URL: url, ...expected,
  }));
  for (const env of [
    { NODE_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_HOST: "db.prod.example" },
    { NODE_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_prod" },
    { NODE_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_PORT: "6432" },
    { NODE_ENV: "production", DATABASE_URL: "postgresql://private-user:private-password@db.dev.example:6432/clipforge_dev?sslmode=require", ...expected },
    { NODE_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_PORT: "70000" },
    { NODE_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_PORT: undefined },
    { NODE_ENV: "production", DATABASE_URL: "not-a-url", ...expected },
    { NODE_ENV: "development", CLIPFORGE_DEPLOYMENT_ENV: "production", DATABASE_URL: url, ...expected, CLIPFORGE_EXPECTED_DATABASE_HOST: undefined },
    ...[
      "host=redirect.example", "port=6432", "hostaddr=192.0.2.9", "service=other", "target_session_attrs=any",
      "load_balance_hosts=disable", "%68ost=redirect.example", "HOST=redirect.example", "host=one&%68ost=two",
      "host%00=redirect.example", "sslmode=require&sslmode=disable", "application_name=one&%61pplication_name=two",
      "unexpected=value", "sslmode=%ZZ", "?",
    ].map((query) => ({ NODE_ENV: "production", DATABASE_URL: `${url.split("?")[0]}?${query}`, ...expected })),
  ]) {
    assert.throws(() => assertWorkerDatabaseIdentity(env), (error: unknown) => {
      assert.ok(error instanceof WorkerDatabaseIdentityError);
      assert.doesNotMatch(error.message, /private-user|private-password|db\.dev|postgresql/);
      return true;
    });
  }
});

test("deployed database URL accepts approved non-routing options and encoded safe values", () => {
  assert.doesNotThrow(() => assertWorkerDatabaseIdentity({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://private-user:private-password@db.dev.example/clipforge_dev?sslmode=%72equire&application_name=clipforge-worker",
    CLIPFORGE_EXPECTED_DATABASE_HOST: "db.dev.example",
    CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_dev",
    CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
  }));
});

test("safe database target parser decodes username and exposes no password field", () => {
  const target = parseSafeDatabaseTarget("postgresql://clipforge_test%5Fadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test");
  assert.deepEqual(target, { host: "127.0.0.1", database: "clipforge_local_test", port: 54836, username: "clipforge_test_admin" });
  assert.equal("password" in target, false);
  assert.throws(() => parseSafeDatabaseTarget("postgresql://clipforge_test%ZZadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test"), WorkerDatabaseIdentityError);
});

test("Prisma client rejects routing overrides before loading or constructing the adapter", async () => {
  await assert.rejects(
    async () => createPrismaClient("postgresql://synthetic-user:synthetic-password@db.example/clipforge?%68ost=redirect.example"),
    WorkerDatabaseIdentityError,
  );
});

test("non-production workers retain local/test behavior without expected identity variables", () => {
  assert.doesNotThrow(() => assertWorkerDatabaseIdentity({ NODE_ENV: "development", DATABASE_URL: "postgresql://127.0.0.1/db" }));
  assert.doesNotThrow(() => assertWorkerDatabaseIdentity({ NODE_ENV: "test" }));
});

test("web runtime identity guard requires valid production and staging database pins", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://private-user:private-password@db.staging.example:5432/clipforge_stage?sslmode=require",
    CLIPFORGE_EXPECTED_DATABASE_HOST: "DB.STAGING.EXAMPLE",
    CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_stage",
    CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
  };
  assert.doesNotThrow(() => assertWebDatabaseIdentity(base));
  assert.doesNotThrow(() => assertWebDatabaseIdentity({ ...base, NODE_ENV: "development", CLIPFORGE_DEPLOYMENT_ENV: "staging" }));
  assert.doesNotThrow(() => assertWebDatabaseIdentity({ ...base, VERCEL_ENV: "preview", CLIPFORGE_EXPECTED_DATABASE_HOST: undefined }));
  assert.doesNotThrow(() => assertWebDatabaseIdentity({ NODE_ENV: "production" }), "no DATABASE_URL preserves the unconfigured runtime");

  const rejected = [
    { ...base, CLIPFORGE_EXPECTED_DATABASE_HOST: undefined },
    { ...base, CLIPFORGE_EXPECTED_DATABASE_NAME: undefined },
    { ...base, CLIPFORGE_EXPECTED_DATABASE_PORT: undefined },
    { ...base, CLIPFORGE_EXPECTED_DATABASE_HOST: "https://db.staging.example/path" },
    { ...base, DATABASE_URL: "not-a-database-url" },
    { ...base, DATABASE_URL: "postgresql://db.staging.example/clipforge%2Fstage" },
    { ...base, CLIPFORGE_EXPECTED_DATABASE_HOST: "db.production.example" },
    { ...base, CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_prod" },
  ];
  for (const env of rejected) {
    assert.throws(() => assertWebDatabaseIdentity(env), (error: unknown) => {
      assert.ok(error instanceof WorkerDatabaseIdentityError);
      assert.doesNotMatch(error.message, /private-user|private-password|db\.staging|postgresql/);
      return true;
    });
  }
});

test("getRuntime enforces production database pins before runtime initialization", () => {
  let connected = false;
  setRuntimeForTests(null);
  setDatabaseConnectorForTests(async () => { connected = true; throw new Error("must not connect"); });
  try {
    assert.throws(() => getRuntime({
      NODE_ENV: "production", DATABASE_URL: "postgresql://private-user:private-password@wrong.example/db",
      CLIPFORGE_EXPECTED_DATABASE_HOST: "expected.example", CLIPFORGE_EXPECTED_DATABASE_NAME: "db", CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
    }), WorkerDatabaseIdentityError);
    assert.equal(connected, false);
  } finally {
    setDatabaseConnectorForTests(null);
    setRuntimeForTests(null);
  }
});

test("SIGTERM stops future claims, drains the current job, then disposes resources", async () => {
  const emitter = new EventEmitter();
  const signals = emitter as unknown as WorkerSignals;
  let finishJob!: (result: "worked") => void;
  let claims = 0;
  let disposed = false;
  const loop = runContinuousWorker({
    signals,
    runOnce: () => { claims += 1; return new Promise((resolve) => { finishJob = resolve; }); },
    idleDelayMs: () => 0,
    dispose: async () => { disposed = true; },
    shutdownTimeoutMs: 1_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  emitter.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 1);
  assert.equal(disposed, false);
  finishJob("worked");
  await loop;
  assert.equal(claims, 1);
  assert.equal(disposed, true);
});

test("SIGINT interrupts the idle wait before another job can be claimed", async () => {
  const emitter = new EventEmitter();
  let claims = 0;
  let disposed = false;
  const loop = runContinuousWorker({
    signals: emitter as unknown as WorkerSignals,
    runOnce: async () => { claims += 1; return "idle"; },
    idleDelayMs: () => 10_000,
    dispose: async () => { disposed = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  emitter.emit("SIGINT");
  await loop;
  assert.equal(claims, 1);
  assert.equal(disposed, true);
});

test("worker shutdown has a bounded drain and skips disposing resources still used by in-flight work", async () => {
  const emitter = new EventEmitter();
  const signals = emitter as unknown as WorkerSignals;
  let disposed = false;
  const loop = runContinuousWorker({
    signals,
    runOnce: () => new Promise<"done">(() => undefined),
    idleDelayMs: () => 0,
    dispose: async () => { disposed = true; },
    shutdownTimeoutMs: 10,
    forceExit: (code) => { assert.equal(code, 1); throw new Error("forced exit"); },
  });
  const rejected = assert.rejects(loop, /forced exit/);
  await new Promise((resolve) => setImmediate(resolve));
  emitter.emit("SIGTERM");
  await rejected;
  assert.equal(disposed, false);
});

