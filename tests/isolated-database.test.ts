// Proves unconfigured checks do not inherit a database URL, and a non-local URL is refused before a connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRuntime, setRuntimeForTests } from "../src/server/runtime.ts";
import { isolatedDatabaseUrl, withoutDatabaseEnv } from "./helpers/isolated-database.ts";

const LOCAL = "postgresql://arbazkhan@127.0.0.1:5434/clipforge_local_test";
const REMOTE = "postgresql://local:secret-value@ep-example.neon.tech/neondb";
const PORT_ENV = "CLIPFORGE_TEST_DATABASE_PORT";

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("unconfigured mode ignores an inherited database URL and restores it", async () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  delete process.env[PORT_ENV];
  process.env["DATABASE_URL"] = LOCAL;
  process.env["DIRECT_URL"] = LOCAL;
  setRuntimeForTests(null);
  try {
    assert.equal(getRuntime().mode, "database");
    await withoutDatabaseEnv(() => {
      setRuntimeForTests(null);
      assert.equal(process.env["DATABASE_URL"], undefined);
      assert.equal(process.env["DIRECT_URL"], undefined);
      assert.equal(getRuntime().mode, "unconfigured");
      assert.equal(getRuntime().auth, undefined);
    });
    assert.equal(process.env["DATABASE_URL"], LOCAL);
    assert.equal(process.env["DIRECT_URL"], LOCAL);
    assert.equal(getRuntime().mode, "database");
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
    setRuntimeForTests(null);
    delete (globalThis as { __clipforgeDatabaseRuntime?: unknown }).__clipforgeDatabaseRuntime;
  }
});

test("a non-local database URL is refused before any connection", () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  delete process.env[PORT_ENV];
  process.env["DATABASE_URL"] = REMOTE;
  delete process.env["DIRECT_URL"];
  try {
    assert.throws(() => isolatedDatabaseUrl(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "DATABASE_URL is not the isolated local test database. Refusing to connect.");
      assert.equal(error.message.includes("secret-value"), false);
      assert.equal(error.message.includes("neon.tech"), false);
      return true;
    });
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
  }
});

test("an explicitly configured isolated port is enforced for DATABASE_URL and DIRECT_URL", () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  const configured = "61531";
  const isolated = `postgresql://clipforge_test:fake@127.0.0.1:${configured}/clipforge_local_test`;
  try {
    process.env[PORT_ENV] = configured;
    process.env["DATABASE_URL"] = isolated;
    process.env["DIRECT_URL"] = isolated;
    assert.equal(isolatedDatabaseUrl(), isolated);

    process.env["DIRECT_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:5434/clipforge_local_test";
    assert.throws(() => isolatedDatabaseUrl(), /DIRECT_URL is not the isolated local test database/);
    process.env["DIRECT_URL"] = isolated;
    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:5434/clipforge_local_test";
    assert.throws(() => isolatedDatabaseUrl(), /DATABASE_URL is not the isolated local test database/);
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
  }
});

test("an explicit override cannot select port 5434 or an invalid TCP port", () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  try {
    process.env["DATABASE_URL"] = LOCAL;
    delete process.env["DIRECT_URL"];
    process.env[PORT_ENV] = "5434";
    assert.throws(() => isolatedDatabaseUrl(), /CLIPFORGE_TEST_DATABASE_PORT is not an allowed isolated test port/);
    process.env[PORT_ENV] = "65536";
    assert.throws(() => isolatedDatabaseUrl(), /CLIPFORGE_TEST_DATABASE_PORT is not an allowed isolated test port/);
    process.env[PORT_ENV] = "";
    assert.throws(() => isolatedDatabaseUrl(), /CLIPFORGE_TEST_DATABASE_PORT must be a valid TCP port/);
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
  }
});

test("an explicit port does not relax the loopback host or database-name allowlist", () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  try {
    process.env[PORT_ENV] = "61531";
    delete process.env["DIRECT_URL"];
    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@localhost:61531/clipforge_local_test";
    assert.throws(() => isolatedDatabaseUrl(), /DATABASE_URL is not the isolated local test database/);
    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@127.0.0.2:61531/clipforge_local_test";
    assert.throws(() => isolatedDatabaseUrl(), /DATABASE_URL is not the isolated local test database/);
    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:61531/other_database";
    assert.throws(() => isolatedDatabaseUrl(), /DATABASE_URL is not the isolated local test database/);
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
  }
});

test("an explicitly configured port must match the target URL and DIRECT_URL", () => {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  const previousPort = process.env[PORT_ENV];
  try {
    process.env[PORT_ENV] = "61531";
    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:61532/clipforge_local_test";
    delete process.env["DIRECT_URL"];
    assert.throws(() => isolatedDatabaseUrl(), /DATABASE_URL is not the isolated local test database/);

    process.env["DATABASE_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:61531/clipforge_local_test";
    process.env["DIRECT_URL"] = "postgresql://clipforge_test:fake@127.0.0.1:61532/clipforge_local_test";
    assert.throws(() => isolatedDatabaseUrl(), /DIRECT_URL is not the isolated local test database/);
  } finally {
    restore("DATABASE_URL", previousDatabase);
    restore("DIRECT_URL", previousDirect);
    restore(PORT_ENV, previousPort);
  }
});
