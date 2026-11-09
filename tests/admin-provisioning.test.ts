import { test } from "node:test";
import assert from "node:assert/strict";
import * as provisioning from "../scripts/provision-admin-once.ts";
import { assertDatabaseIdentity, assertReadOnlyPrivileges, inspectAdminProvisioningTarget, runProvisioningCli } from "../scripts/provision-admin-once.ts";
import type { ModelDelegate, PrismaClientLike, Row } from "../src/server/prisma/prisma-client-like.ts";

interface TestUser { id: string; email: string; emailVerified: Date | null; passwordHash: string | null; role: string; }
interface TestSession { id: string; userId: string; revokedAt: Date | null; }
interface TestAudit extends Row { actorId: null; action: string; entityType: string; entityId: string; metadata: Row; }
interface State { users: TestUser[]; sessions: TestSession[]; audits: TestAudit[]; }

const NOW = new Date("2026-11-08T12:00:00.000Z");
const USER = { id: "trusted-user-001", email: "trusted-person@example.test", emailVerified: NOW, passwordHash: "opaque-fake-password-hash", role: "user" } satisfies TestUser;

const safePrivileges = {
  safeRoleAttributes: true, noRoleMemberships: true, noDatabaseCreate: true, noDatabaseTemporary: true,
  noSchemaCreate: true, noUserRowSecurity: true, noObjectWrites: true, noColumnWrites: true, noSequenceWrites: true, noLargeObjectWrites: true,
  noOwnedObjects: true, noExecutableSecurityDefinerFunctions: true,
};

function makeDb(options: { users?: TestUser[]; sessions?: TestSession[]; failAudit?: boolean; failTransaction?: boolean; privileges?: Partial<typeof safePrivileges>; missingPrivilegeRow?: boolean; malformedPrivilegeRow?: boolean; userSelectAccess?: boolean; connectedRole?: string; roleVerified?: boolean; userRowSecurity?: boolean; missingReadPreflight?: boolean; beforeTransaction?: (state: State) => void } = {}) {
  let state: State = structuredClone({ users: options.users ?? [USER], sessions: options.sessions ?? [], audits: [] });
  let auditFails = options.failAudit ?? false;
  let lockCalls = 0;
  let transactionCalls = 0;
  let writes = 0;
  let transactionQueue = Promise.resolve();
  const events: string[] = [];
  const lookupArgs: Array<Record<string, unknown>> = [];
  const countArgs: Array<Record<string, unknown>> = [];
  const privilegeQueries: string[] = [];
  const userSelectQueries: string[] = [];

  const makeClient = (readState: () => State, inTransaction: boolean): PrismaClientLike => {
    const userDelegate = {
      findUnique: async (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        events.push(`${inTransaction ? "tx" : "root"}:user.findUnique`);
        lookupArgs.push(structuredClone(args));
        const row = readState().users.find((candidate) => candidate.id === args.where["id"]);
        if (!row) return null;
        if (!args.select) return row;
        return Object.fromEntries(Object.keys(args.select).map((field) => [field, row[field as keyof TestUser]]));
      },
      count: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        events.push(`${inTransaction ? "tx" : "root"}:user.count`);
        if (where) countArgs.push(structuredClone(where));
        if (where?.["id"] && typeof where["passwordHash"] === "object") return readState().users.filter((row) => row.id === where["id"] && row.passwordHash !== null && row.passwordHash !== "").length;
        return where?.["role"] === "admin" ? readState().users.filter((row) => row.role === "admin").length : readState().users.length;
      },
      updateMany: async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        const id = where?.["id"];
        const row = readState().users.find((candidate) => candidate.id === id);
        if (!row || row.role !== where?.["role"] || row.role !== "user" || where?.["emailVerified"] === undefined || where?.["passwordHash"] === undefined || !row.emailVerified || !row.passwordHash) return { count: 0 };
        row.role = String(data["role"]);
        events.push(`${inTransaction ? "tx" : "root"}:user.updateMany`);
        writes++;
        return { count: 1 };
      },
    } as unknown as ModelDelegate;
    const sessionDelegate = {
      updateMany: async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = readState().sessions.filter((row) => row.userId === where?.["userId"] && row.revokedAt === null);
        for (const row of matches) row.revokedAt = data["revokedAt"] as Date;
        events.push(`${inTransaction ? "tx" : "root"}:session.updateMany`);
        if (matches.length) writes++;
        return { count: matches.length };
      },
    } as unknown as ModelDelegate;
    const auditDelegate = {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (auditFails) throw new Error("simulated audit insert failure");
        events.push(`${inTransaction ? "tx" : "root"}:audit.create`);
        readState().audits.push(structuredClone(data) as TestAudit);
        writes++;
        return data;
      },
    } as unknown as ModelDelegate;
    const client = {
      user: userDelegate,
      session: sessionDelegate,
      auditLog: auditDelegate,
      $queryRaw: async (strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("hasRequiredUserSelect")) {
          events.push(`${inTransaction ? "tx" : "root"}:user.select-preflight`);
          userSelectQueries.push(query);
          if (options.missingReadPreflight) return [];
          return [{ connectedRole: options.connectedRole ?? "clipforge_admin_readonly", roleVerified: options.roleVerified ?? true, noUserRowSecurity: options.userRowSecurity ?? true, hasRequiredUserSelect: options.userSelectAccess ?? true }];
        }
        if (query.includes("safeRoleAttributes")) {
          events.push("root:role.privileges");
          privilegeQueries.push(query);
          if (options.missingPrivilegeRow) return [];
          if (options.malformedPrivilegeRow) return [{ ...safePrivileges, noOwnedObjects: undefined }];
          return [{ ...safePrivileges, ...options.privileges }];
        }
        if (query.includes("current_database()")) {
          events.push("root:database.identity");
          return [{ databaseName: "clipforge_local_test", host: "127.0.0.1", port: 5434 }];
        }
        if (!query.includes("pg_advisory_xact_lock")) throw new Error("unexpected raw query");
        if (!inTransaction) throw new Error("lock must be acquired in a transaction");
        events.push("tx:advisory.lock");
        lockCalls++;
        return [];
      },
      $transaction: async <T>(work: (tx: PrismaClientLike) => Promise<T>): Promise<T> => {
        if (inTransaction) throw new Error("nested transaction is not supported in this fake");
        transactionCalls++;
        let release!: () => void;
        const next = new Promise<void>((resolve) => { release = resolve; });
        const previous = transactionQueue;
        transactionQueue = previous.then(() => next);
        await previous;
        options.beforeTransaction?.(state);
        const draft = structuredClone(state);
        try {
          const result = await work(makeClient(() => draft, true));
          if (options.failTransaction) throw new Error("simulated transaction failure");
          state = draft;
          return result;
        } finally {
          release();
        }
      },
    } as unknown as PrismaClientLike;
    return client;
  };
  return {
    client: makeClient(() => state, false),
    state: () => structuredClone(state),
    lockCalls: () => lockCalls,
    transactionCalls: () => transactionCalls,
    writes: () => writes,
    events: () => [...events],
    lookupArgs: () => structuredClone(lookupArgs),
    countArgs: () => structuredClone(countArgs),
    privilegeQueries: () => [...privilegeQueries],
    userSelectQueries: () => [...userSelectQueries],
    failAudit: (value: boolean) => { auditFails = value; },
  };
}

const target = "127.0.0.1:5434/clipforge_local_test";
const readonlyUrl = "postgresql://readonly:fake@127.0.0.1:5434/clipforge_local_test";
const promotionUrl = "postgresql://promote:fake@127.0.0.1:5434/clipforge_local_test";
function dependencies(db: ReturnType<typeof makeDb>, mode: "dry-run" | "promote" = "promote") {
  const createdWith: string[] = [];
  const output: string[] = [];
  return {
    createdWith,
    output,
    dependencies: {
      environment: {
        CLIPFORGE_ADMIN_PROVISION_READONLY_DATABASE_URL: readonlyUrl,
        CLIPFORGE_ADMIN_PROVISION_DATABASE_URL: promotionUrl,
      },
      createClient: async (connectionString: string) => { createdWith.push(connectionString); return db.client; },
      confirmExactId: async (userId: string) => `PROMOTE ${userId}`,
      write: (message: string) => output.push(message),
    },
    args: ["--mode", mode, "--user-id", USER.id, "--expected-target", target, ...(mode === "promote" ? ["--approval-reference", "OPS-123"] : [])],
  };
}

test("dry-run reports eligibility without exposing full email or changing data", async () => {
  const db = makeDb({ sessions: [{ id: "active", userId: USER.id, revokedAt: null }] });
  const before = db.state();
  const report = await inspectAdminProvisioningTarget(db.client, USER.id);
  assert.equal(report.eligible, true);
  assert.equal(report.maskedEmail, "t***@example.test");
  assert.doesNotMatch(JSON.stringify(report), /trusted-person@example\.test|opaque-fake-password-hash/);
  assert.deepEqual(db.state(), before);
  assert.equal(db.writes(), 0);
  assert.equal(db.lockCalls(), 0);
  assert.deepEqual(Object.keys(db.lookupArgs()[0]?.["select"] as object).sort(), ["email", "emailVerified", "id", "role"]);
  assert.equal("passwordHash" in (db.lookupArgs()[0]?.["select"] as object), false);
  assert.equal(JSON.stringify(db.lookupArgs()).includes("passwordHash"), false);
  assert.ok(db.countArgs().some((where) => where["id"] === USER.id && typeof where["passwordHash"] === "object"));
});

test("dry-run requires the exact existing ID and blocks unsafe account states", async () => {
  const missing = makeDb();
  assert.equal((await inspectAdminProvisioningTarget(missing.client, "other-user")).blockers.includes("target_user_not_found"), true);
  await assert.rejects(inspectAdminProvisioningTarget(missing.client, ` ${USER.id}`), /exact existing user ID/);

  const cases: Array<{ user: TestUser; admins?: TestUser[]; blocker: string }> = [
    { user: { ...USER, role: "admin" }, blocker: "target_role_is_not_user" },
    { user: { ...USER, emailVerified: null }, blocker: "email_not_verified" },
    { user: { ...USER, passwordHash: null }, blocker: "password_login_not_available" },
    { user: { ...USER, passwordHash: "" }, blocker: "password_login_not_available" },
    { user: USER, admins: [{ ...USER, id: "another-admin", role: "admin" }], blocker: "an_admin_account_already_exists" },
  ];
  for (const item of cases) {
    const db = makeDb({ users: [item.user, ...(item.admins ?? [])] });
    const report = await inspectAdminProvisioningTarget(db.client, item.user.id);
    assert.equal(report.eligible, false);
    assert.ok(report.blockers.includes(item.blocker));
    assert.equal(db.writes(), 0);
  }
});

test("required User column SELECT access and role/catalog evidence are verified before Prisma reads", async () => {
  for (const options of [{ userSelectAccess: false }, { roleVerified: false }, { userRowSecurity: false }, { connectedRole: "" }, { missingReadPreflight: true }]) {
    const db = makeDb(options);
    await assert.rejects(inspectAdminProvisioningTarget(db.client, USER.id), /Required user read access could not be verified/);
    assert.equal(db.lookupArgs().length, 0);
    assert.equal(db.countArgs().length, 0);
    assert.equal(db.writes(), 0);
  }
  const db = makeDb();
  await inspectAdminProvisioningTarget(db.client, USER.id);
  const events = db.events();
  assert.ok(events.indexOf("root:user.select-preflight") < events.indexOf("root:user.findUnique"));
  const selectQuery = db.userSelectQueries()[0] ?? "";
  assert.match(selectQuery, /has_column_privilege\(current_user, c\.oid, a\.attnum, 'SELECT'\)/);
  assert.match(selectQuery, /c\.relrowsecurity OR c\.relforcerowsecurity/);
  for (const column of ["id", "email", "emailVerified", "role", "passwordHash"]) assert.ok(selectQuery.includes(`'${column}'::name`));
});

test("dry-run fails closed on missing or malformed privilege catalog evidence before any User query", async () => {
  for (const options of [{ missingPrivilegeRow: true }, { malformedPrivilegeRow: true }]) {
    const db = makeDb(options);
    const run = dependencies(db, "dry-run");
    await assert.rejects(runProvisioningCli(run.args, run.dependencies), /could not be verified as read-only/);
    assert.equal(db.lookupArgs().length, 0);
    assert.equal(db.countArgs().length, 0);
    assert.equal(db.writes(), 0);
  }
});

test("no exported promotion helper can bypass CLI target and confirmation checks", () => {
  assert.equal("provisionAdminAccount" in provisioning, false);
});

test("caller cannot substitute a different expected database target", async () => {
  const db = makeDb();
  const run = dependencies(db, "dry-run");
  const wrongTargetArgs = run.args.map((arg, index, all) => index === all.indexOf("--expected-target") + 1 ? "127.0.0.1:5432/clipforge" : arg);
  await assert.rejects(runProvisioningCli(wrongTargetArgs, run.dependencies), /Only the explicitly approved isolated local test database/);
  assert.deepEqual(run.createdWith, []);
  assert.equal(db.events().length, 0);
});

test("connection-string target overrides are rejected before client creation", async () => {
  const db = makeDb();
  const run = dependencies(db, "dry-run");
  run.dependencies.environment.CLIPFORGE_ADMIN_PROVISION_READONLY_DATABASE_URL = `${readonlyUrl}?host=/tmp/other-postgres`;
  await assert.rejects(runProvisioningCli(run.args, run.dependencies), /target or session override/);
  assert.deepEqual(run.createdWith, []);
  assert.equal(db.events().length, 0);
});

test("dry-run completes as read-only and never prompts or enters the promotion transaction", async () => {
  const db = makeDb();
  const run = dependencies(db, "dry-run");
  let confirmationCalls = 0;
  run.dependencies.confirmExactId = async () => { confirmationCalls++; throw new Error("dry-run must not prompt"); };
  await runProvisioningCli(run.args, run.dependencies);
  assert.equal(confirmationCalls, 0);
  assert.equal(db.transactionCalls(), 0);
  assert.equal(db.lockCalls(), 0);
  assert.equal(db.writes(), 0);
  assert.equal(run.output.some((line) => line.includes("Provisioning complete")), false);
});

test("connected database identity must exactly match expected host, port, and database", () => {
  assert.doesNotThrow(() => assertDatabaseIdentity({ databaseName: "clipforge_local_test", host: "127.0.0.1", port: 5434 }, "127.0.0.1:5434/clipforge_local_test"));
  assert.throws(() => assertDatabaseIdentity({ databaseName: "other_db", host: "127.0.0.1", port: 5434 }, "127.0.0.1:5434/clipforge_local_test"), /identity does not match/);
  assert.throws(() => assertDatabaseIdentity({ databaseName: "clipforge_local_test", host: "127.0.0.1", port: 5432 }, "127.0.0.1:5434/clipforge_local_test"), /identity does not match/);
  assert.throws(() => assertDatabaseIdentity({ databaseName: "clipforge_local_test", host: "10.0.0.2", port: 5434 }, "127.0.0.1:5434/clipforge_local_test"), /identity does not match/);
});

test("dry-run privilege verification accepts only a role with no write or escalation privileges", () => {
  const readonly = { ...safePrivileges };
  assert.doesNotThrow(() => assertReadOnlyPrivileges(readonly));
  for (const key of Object.keys(readonly) as Array<keyof typeof readonly>) {
    assert.throws(() => assertReadOnlyPrivileges({ ...readonly, [key]: false }), /could not be verified as read-only/);
  }
});

test("CLI selects the mode-specific credential and rejects identity or read-only privilege failures before writes", async () => {
  for (const failure of ["identity", "privileges"] as const) {
    const db = makeDb();
    if (failure === "identity") {
      const raw = db.client.$queryRaw;
      db.client.$queryRaw = async (strings, ...values) => {
        if (strings.join("").includes("current_database()")) return [{ databaseName: "wrong_db", host: "127.0.0.1", port: 5434 }];
        return raw(strings, ...values);
      };
    } else {
      const raw = db.client.$queryRaw;
      db.client.$queryRaw = async (strings, ...values) => {
        if (strings.join("").includes("safeRoleAttributes")) return [{ ...safePrivileges, noObjectWrites: false }];
        return raw(strings, ...values);
      };
    }
    const run = dependencies(db, "dry-run");
    await assert.rejects(runProvisioningCli(run.args, run.dependencies), failure === "identity" ? /identity does not match/ : /could not be verified as read-only/);
    assert.equal(db.writes(), 0);
    assert.deepEqual(run.createdWith, [readonlyUrl]);
    assert.equal(db.events().some((event) => event.endsWith("user.updateMany") || event.endsWith("session.updateMany") || event.endsWith("audit.create")), false);
  }
});

test("every additional privilege condition fails closed and the PostgreSQL 15 query separates sequence checks", async () => {
  const conditions: Array<keyof typeof safePrivileges> = [
    "noDatabaseTemporary", "noUserRowSecurity", "noColumnWrites", "noSequenceWrites", "noLargeObjectWrites", "noOwnedObjects", "noExecutableSecurityDefinerFunctions",
  ];
  for (const condition of conditions) {
    const db = makeDb({ privileges: { [condition]: false } });
    const run = dependencies(db, "dry-run");
    await assert.rejects(runProvisioningCli(run.args, run.dependencies), /could not be verified as read-only/);
    assert.equal(db.writes(), 0, `${condition} must block before writes`);
  }
  const db = makeDb();
  const run = dependencies(db, "dry-run");
  await runProvisioningCli(run.args, run.dependencies);
  const query = db.privilegeQueries()[0] ?? "";
  assert.match(query, /has_column_privilege\(current_user, c\.oid, a\.attnum, p\.privilege\)/);
  assert.match(query, /has_database_privilege\(current_user, current_database\(\), 'TEMP'\)/);
  assert.match(query, /c\.relrowsecurity OR c\.relforcerowsecurity/);
  assert.match(query, /has_sequence_privilege\(current_user, c\.oid, 'USAGE'\)/);
  assert.match(query, /has_sequence_privilege\(current_user, c\.oid, 'UPDATE'\)/);
  assert.match(query, /aclexplode\(COALESCE\(l\.lomacl/);
  assert.match(query, /pg_proc p[\s\S]*p\.prosecdef[\s\S]*has_function_privilege/);
  const tablePrivilegeSection = query.split('AS "noObjectWrites"')[0]?.split('NOT EXISTS').at(-1) ?? "";
  assert.doesNotMatch(tablePrivilegeSection, /relkind = 'S'/);
  assert.match(query, /FROM pg_shdepend d[\s\S]*d\.deptype = 'o'[\s\S]*d\.dbid IN \(0,/);
  assert.ok(query.includes("pg_largeobject_metadata"), "large-object ACLs are checked separately from ownership dependencies");
  assert.equal(db.writes(), 0);
});

test("promotion rechecks eligibility after acquiring the advisory lock, before any write", async () => {
  const db = makeDb({ beforeTransaction: (state) => state.users.push({ ...USER, id: "new-admin", role: "admin" }) });
  const run = dependencies(db);
  await assert.rejects(runProvisioningCli(run.args, run.dependencies), /transaction-time provisioning precondition/);
  const events = db.events();
  assert.ok(events.indexOf("tx:advisory.lock") < events.indexOf("tx:user.count"));
  assert.equal(db.state().users.find((row) => row.id === USER.id)?.role, "user");
  assert.equal(db.writes(), 0);
  assert.deepEqual(run.createdWith, [promotionUrl]);
});

test("a confirmation that does not exactly name the target is rejected before transaction start", async () => {
  const db = makeDb();
  const run = dependencies(db);
  run.dependencies.confirmExactId = async () => "PROMOTE someone-else";
  await assert.rejects(runProvisioningCli(run.args, run.dependencies), /Confirmation did not match/);
  assert.equal(db.lockCalls(), 0);
  assert.equal(db.writes(), 0);
});

test("role update, session revocation, and audit all use the same transaction client", async () => {
  const db = makeDb({ sessions: [{ id: "session-a", userId: USER.id, revokedAt: null }] });
  const run = dependencies(db);
  await runProvisioningCli(run.args, run.dependencies);
  assert.equal(db.state().users.find((row) => row.id === USER.id)?.role, "admin");
  assert.equal(db.state().sessions[0]?.revokedAt instanceof Date, true);
  assert.equal(db.state().audits.length, 1);
  for (const operation of ["user.updateMany", "session.updateMany", "audit.create"]) assert.ok(db.events().includes(`tx:${operation}`));
  assert.equal(db.events().some((event) => ["root:user.updateMany", "root:session.updateMany", "root:audit.create"].includes(event)), false);
});

test("audit failure and transaction failure both reject and roll back all state", async () => {
  for (const options of [{ failAudit: true }, { failTransaction: true }]) {
    const db = makeDb({ ...options, sessions: [{ id: "session-a", userId: USER.id, revokedAt: null }] });
    const before = db.state();
    const run = dependencies(db);
    await assert.rejects(runProvisioningCli(run.args, run.dependencies));
    assert.deepEqual(db.state(), before);
    assert.equal(run.output.some((line) => line.includes("Provisioning complete")), false);
  }
});

test("concurrent CLI promotion attempts serialize and only one admin is committed", async () => {
  const second = { ...USER, id: "trusted-user-002", email: "second@example.test" };
  const db = makeDb({ users: [USER, second] });
  const first = dependencies(db);
  const otherArgs = first.args.map((arg, index, all) => index === all.indexOf("--user-id") + 1 ? second.id : arg);
  const outcomes = await Promise.allSettled([
    runProvisioningCli(first.args, first.dependencies),
    runProvisioningCli(otherArgs, first.dependencies),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(db.state().users.filter((row) => row.role === "admin").length, 1);
  assert.equal(db.state().audits.length, 1);
  assert.equal(db.events().filter((event) => event === "tx:advisory.lock").length, 2);
});
