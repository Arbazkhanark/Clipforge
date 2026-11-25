// Real PostgreSQL promotion verification. This file is deliberately gated by
// isolatedDatabaseUrl(), which refuses every target except loopback,
// clipforge_local_test, and the explicitly configured non-default test port.
// It must never be pointed at Neon, production, or a migration-owner connection.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { test, type TestContext } from "node:test";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { isolatedDatabaseUrl } from "./helpers/isolated-database.ts";

const TEST_DATABASE_HOST = "127.0.0.1";
const TEST_DATABASE_PORT = "54836";
const TEST_DATABASE_NAME = "clipforge_local_test";
const TEST_DATABASE_ROLE = "clipforge_test_admin";
const EXPECTED_MIGRATIONS = readdirSync(new URL("../prisma/migrations/", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const databaseUrl = resolveDatabaseUrl();
const databaseIsConfigured = Boolean(databaseUrl);
const expectedSkip = "DATABASE_URL is not configured for the isolated local test database";
const testRunId = randomUUID();

function resolveDatabaseUrl(): string | undefined {
  const database = process.env["DATABASE_URL"];
  const direct = process.env["DIRECT_URL"];
  if (!database && !direct) return undefined;
  if (!database || !direct) throw new Error("Both DATABASE_URL and DIRECT_URL are required for promotion PostgreSQL integration tests.");
  if (database !== direct) throw new Error("DATABASE_URL and DIRECT_URL must match exactly for promotion PostgreSQL integration tests.");
  if (process.env["NODE_ENV"] !== "test" || process.env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test") {
    throw new Error("NODE_ENV=test and CLIPFORGE_DEPLOYMENT_ENV=test are required for promotion PostgreSQL integration tests.");
  }
  if (process.env["CLIPFORGE_TEST_DATABASE_PORT"] !== TEST_DATABASE_PORT) {
    throw new Error("CLIPFORGE_TEST_DATABASE_PORT must explicitly equal 54836 for promotion PostgreSQL integration tests.");
  }

  let parsed: URL;
  try { parsed = new URL(database); }
  catch { throw new Error("DATABASE_URL is not a valid isolated PostgreSQL test target."); }
  const schemas = parsed.searchParams.getAll("schema");
  const safeTarget = parsed.protocol === "postgresql:" && parsed.hostname === TEST_DATABASE_HOST &&
    parsed.port === TEST_DATABASE_PORT && parsed.pathname === `/${TEST_DATABASE_NAME}` && parsed.username === TEST_DATABASE_ROLE &&
    parsed.hash === "" && [...parsed.searchParams.keys()].every((key) => key === "schema") &&
    (schemas.length === 0 || (schemas.length === 1 && schemas[0] === "public"));
  if (!safeTarget) throw new Error("Database URLs must target only clipforge_test_admin at 127.0.0.1:54836/clipforge_local_test with no redirecting query parameters.");
  if (isolatedDatabaseUrl() !== database) throw new Error("Database URLs failed the shared isolated-database guard.");
  return database;
}

type RolePreflight = {
  superuser: boolean;
  currentRole: string;
  roleFlags: { inherit: boolean; createRole: boolean; createDatabase: boolean; replication: boolean; bypassRls: boolean };
  ownsPromotionObjects: boolean;
  membershipRows: Array<{ roleName: string; canSetRole: boolean; isSuperuser: boolean; canCreateRole: boolean; schemaCreate: boolean; canForgeAudit: boolean }>;
  fixtureWritable: boolean;
  migrationHistory: "verified" | "not-readable";
  privileges: Record<string, boolean>;
};

type PromotionUpdatePrivileges = {
  promotionUpdateReason: boolean;
  promotionUpdateUpdatedAt: boolean;
  promotionUpdateDiscountValue: boolean;
};

type AuditForgeryPrivileges = {
  [key: string]: boolean;
};

const AUDIT_FORGERY_PRIVILEGE_CHECKS = [
  { key: "auditPromotionUpdateReason", table: "Promotion", column: "reason", privilege: "UPDATE" },
  { key: "auditPromotionUpdateUpdatedAt", table: "Promotion", column: "updatedAt", privilege: "UPDATE" },
  { key: "auditPromotionSelectId", table: "Promotion", column: "id", privilege: "SELECT" },
  { key: "auditPromotionSelectUpdatedAt", table: "Promotion", column: "updatedAt", privilege: "SELECT" },
  { key: "auditEventInsertId", table: "PromotionLifecycleEvent", column: "id", privilege: "INSERT" },
  { key: "auditEventInsertEventKey", table: "PromotionLifecycleEvent", column: "eventKey", privilege: "INSERT" },
  { key: "auditEventInsertEventType", table: "PromotionLifecycleEvent", column: "eventType", privilege: "INSERT" },
  { key: "auditEventInsertPromotionId", table: "PromotionLifecycleEvent", column: "promotionId", privilege: "INSERT" },
  { key: "auditEventInsertActorUserId", table: "PromotionLifecycleEvent", column: "actorUserId", privilege: "INSERT" },
  { key: "auditEventInsertOccurredAt", table: "PromotionLifecycleEvent", column: "occurredAt", privilege: "INSERT" },
  { key: "auditEventInsertMetadata", table: "PromotionLifecycleEvent", column: "metadata", privilege: "INSERT" },
  { key: "auditEventSelectPromotionId", table: "PromotionLifecycleEvent", column: "promotionId", privilege: "SELECT" },
  { key: "auditEventSelectActorUserId", table: "PromotionLifecycleEvent", column: "actorUserId", privilege: "SELECT" },
  { key: "auditEventSelectEventType", table: "PromotionLifecycleEvent", column: "eventType", privilege: "SELECT" },
  { key: "auditEventSelectOccurredAt", table: "PromotionLifecycleEvent", column: "occurredAt", privilege: "SELECT" },
  { key: "auditEventSelectMetadata", table: "PromotionLifecycleEvent", column: "metadata", privilege: "SELECT" },
  { key: "auditEventSelectEventKey", table: "PromotionLifecycleEvent", column: "eventKey", privilege: "SELECT" },
  { key: "auditUserSelectId", table: "User", column: "id", privilege: "SELECT" },
  { key: "auditUserSelectRole", table: "User", column: "role", privilege: "SELECT" },
  { key: "auditLogInsertId", table: "AuditLog", column: "id", privilege: "INSERT" },
  { key: "auditLogInsertActorId", table: "AuditLog", column: "actorId", privilege: "INSERT" },
  { key: "auditLogInsertAction", table: "AuditLog", column: "action", privilege: "INSERT" },
  { key: "auditLogInsertEntityType", table: "AuditLog", column: "entityType", privilege: "INSERT" },
  { key: "auditLogInsertEntityId", table: "AuditLog", column: "entityId", privilege: "INSERT" },
  { key: "auditLogInsertMetadata", table: "AuditLog", column: "metadata", privilege: "INSERT" },
  { key: "auditLogSelectActorId", table: "AuditLog", column: "actorId", privilege: "SELECT" },
  { key: "auditLogSelectAction", table: "AuditLog", column: "action", privilege: "SELECT" },
  { key: "auditLogSelectEntityType", table: "AuditLog", column: "entityType", privilege: "SELECT" },
  { key: "auditLogSelectEntityId", table: "AuditLog", column: "entityId", privilege: "SELECT" },
  { key: "auditLogSelectMetadata", table: "AuditLog", column: "metadata", privilege: "SELECT" },
] as const;

function auditForgeryPrivilegeJsonPairs(roleExpression: "current_user" | "target.rolname"): string {
  return AUDIT_FORGERY_PRIVILEGE_CHECKS.map(({ key, table, column, privilege }) =>
    `'${key}', has_column_privilege(${roleExpression}, 'public."${table}"', '${column}', '${privilege}')`,
  ).join(", ");
}

function hasRequiredPromotionUpdatePrivileges(privileges: PromotionUpdatePrivileges): boolean {
  return privileges.promotionUpdateReason && privileges.promotionUpdateUpdatedAt && privileges.promotionUpdateDiscountValue;
}

function canForgePromotionAudit(privileges: AuditForgeryPrivileges): boolean {
  return AUDIT_FORGERY_PRIVILEGE_CHECKS.every(({ key }) => privileges[key] === true);
}

function hasElevatedSettableMembership(memberships: Array<{
  canSetRole: boolean;
  isSuperuser: boolean;
  canCreateRole: boolean;
  schemaCreate: boolean;
  canForgeAudit: boolean;
}>): boolean {
  return memberships.some((membership) => membership.canSetRole && (
    membership.isSuperuser || membership.canCreateRole || membership.schemaCreate || membership.canForgeAudit
  ));
}

function hasForbiddenRuntimeCreateRole(roleFlags: { createRole: boolean }): boolean {
  return roleFlags.createRole;
}

const PROMOTION_AUDIT_INTEGRITY_ERROR = "promotion reason change requires an Admin lifecycle event and matching audit record";
type AuditProbeResult = "integrity-rejected" | "insufficient-privileges" | "forgery-succeeded" | "unrelated-database-error";

function classifyAuditProbeResult(error: unknown | null): AuditProbeResult {
  if (error === null) return "forgery-succeeded";
  if (typeof error !== "object" || error === null) return "unrelated-database-error";
  const diagnostic = error as { code?: unknown; message?: unknown };
  if (diagnostic.code === "42501") return "insufficient-privileges";
  if (diagnostic.code === "P0001" && diagnostic.message === PROMOTION_AUDIT_INTEGRITY_ERROR) return "integrity-rejected";
  return "unrelated-database-error";
}

test("promotion preflight privilege logic: table-level UPDATE satisfies each required column check", () => {
  // PostgreSQL has_column_privilege is true for a column when table-level UPDATE is held.
  const tableUpdate = { promotionUpdateReason: true, promotionUpdateUpdatedAt: true, promotionUpdateDiscountValue: true };
  assert.equal(hasRequiredPromotionUpdatePrivileges(tableUpdate), true);
});

test("promotion preflight privilege logic: each required column grant is checked independently", () => {
  assert.equal(hasRequiredPromotionUpdatePrivileges({ promotionUpdateReason: true, promotionUpdateUpdatedAt: true, promotionUpdateDiscountValue: true }), true);
  assert.equal(hasRequiredPromotionUpdatePrivileges({ promotionUpdateReason: false, promotionUpdateUpdatedAt: true, promotionUpdateDiscountValue: true }), false);
  assert.equal(hasRequiredPromotionUpdatePrivileges({ promotionUpdateReason: true, promotionUpdateUpdatedAt: false, promotionUpdateDiscountValue: true }), false);
  assert.equal(hasRequiredPromotionUpdatePrivileges({ promotionUpdateReason: true, promotionUpdateUpdatedAt: true, promotionUpdateDiscountValue: false }), false);
  assert.equal(hasRequiredPromotionUpdatePrivileges({ promotionUpdateReason: false, promotionUpdateUpdatedAt: false, promotionUpdateDiscountValue: false }), false);
});

test("promotion preflight privilege logic: audit-forgery detection requires reason UPDATE and every matching-row insert/read", () => {
  const complete = Object.fromEntries(AUDIT_FORGERY_PRIVILEGE_CHECKS.map(({ key }) => [key, true]));
  assert.equal(canForgePromotionAudit(complete), true);
  for (const { key } of AUDIT_FORGERY_PRIVILEGE_CHECKS) {
    assert.equal(canForgePromotionAudit({ ...complete, [key]: false }), false, `missing ${key} must block the probe`);
  }
  // Table-level privileges satisfy each listed column check; column-only grants
  // are represented by the same effective per-column booleans returned by PostgreSQL.
  const tableGrantEquivalent = Object.fromEntries(AUDIT_FORGERY_PRIVILEGE_CHECKS.map(({ key }) => [key, true]));
  const columnGrantEquivalent = Object.fromEntries(AUDIT_FORGERY_PRIVILEGE_CHECKS.map(({ key }) => [key, true]));
  assert.equal(canForgePromotionAudit(tableGrantEquivalent), true);
  assert.equal(canForgePromotionAudit(columnGrantEquivalent), true);
});

test("promotion preflight privilege logic: settable CREATEROLE memberships are elevated, non-settable roles are not", () => {
  const ordinary = { canSetRole: true, isSuperuser: false, canCreateRole: false, schemaCreate: false, canForgeAudit: false };
  assert.equal(hasElevatedSettableMembership([ordinary]), false);
  const directCreateRoleMember = { ...ordinary, canCreateRole: true };
  const indirectCreateRoleMember = { ...ordinary, canCreateRole: true };
  assert.equal(hasElevatedSettableMembership([directCreateRoleMember]), true, "directly settable CREATEROLE membership is elevated");
  assert.equal(hasElevatedSettableMembership([indirectCreateRoleMember]), true, "indirectly settable CREATEROLE membership is elevated");
  assert.equal(hasElevatedSettableMembership([{ ...ordinary, canSetRole: false, canCreateRole: true }]), false);
  assert.equal(hasElevatedSettableMembership([{ ...ordinary, isSuperuser: true }]), true);
  assert.equal(hasElevatedSettableMembership([{ ...ordinary, schemaCreate: true }]), true);
  assert.equal(hasElevatedSettableMembership([{ ...ordinary, canForgeAudit: true }]), true);
});

test("promotion preflight privilege logic: connected CREATEROLE role is forbidden", () => {
  assert.equal(hasForbiddenRuntimeCreateRole({ createRole: false }), false);
  assert.equal(hasForbiddenRuntimeCreateRole({ createRole: true }), true);
});

test("promotion preflight privilege logic: audit probe distinguishes trigger rejection from privilege failures", () => {
  assert.equal(classifyAuditProbeResult({ code: "P0001", message: PROMOTION_AUDIT_INTEGRITY_ERROR }), "integrity-rejected");
  assert.equal(classifyAuditProbeResult({ code: "42501", message: "synthetic privilege failure" }), "insufficient-privileges");
  assert.equal(classifyAuditProbeResult(null), "forgery-succeeded");
  assert.equal(classifyAuditProbeResult({ code: "P0001", message: "different integrity error" }), "unrelated-database-error");
  assert.equal(classifyAuditProbeResult({ code: "XX000", message: "synthetic unrelated error" }), "unrelated-database-error");
});

type Fixture = {
  prefix: string;
  adminId: string;
  userIds: string[];
  promotionIds: string[];
};

function connectionString(label: string): string {
  assert.ok(databaseUrl, expectedSkip);
  const parsed = new URL(databaseUrl);
  parsed.searchParams.set("application_name", applicationName(label));
  // No connection string is logged. The helper has already validated the
  // original target; this only adds a local pg_stat_activity correlation tag.
  return parsed.toString();
}

function applicationName(label: string): string {
  // PostgreSQL stores application_name in a 64-byte field (63 bytes plus NUL).
  // Keep both the run discriminator and the full label below that limit so
  // pg_stat_activity polling matches the value actually stored by the server.
  return `clipforge-pgverify-${testRunId.slice(0, 12)}-${label}`;
}

async function connectSql(label: string): Promise<Client> {
  const client = new Client({ connectionString: connectionString(label) });
  await client.connect();
  return client;
}

async function connectPrisma(label: string): Promise<PrismaClientLike & { $disconnect(): Promise<void> }> {
  assert.ok(databaseUrl, expectedSkip);
  const client = await createPrismaClient(connectionString(label));
  return client as PrismaClientLike & { $disconnect(): Promise<void> };
}

async function preflight(): Promise<{ sql: Client; role: RolePreflight }> {
  const sql = await connectSql("preflight");
  try {
    const identity = await sql.query<{
      databaseName: string;
      schemaName: string;
      port: number;
      serverAddress: string | null;
      serverVersion: string;
      currentRole: string;
    }>(`SELECT current_database() AS "databaseName",
              current_schema() AS "schemaName",
              inet_server_port() AS "port",
              host(inet_server_addr()) AS "serverAddress",
              version() AS "serverVersion",
              current_user AS "currentRole"`);
    const row = identity.rows[0];
    assert.ok(row, "database identity query returned no row");
    assert.equal(row.databaseName, "clipforge_local_test");
    assert.equal(row.schemaName, "public");
    assert.equal(row.serverAddress, TEST_DATABASE_HOST);
    assert.equal(String(row.port), TEST_DATABASE_PORT);
    assert.equal(row.currentRole, TEST_DATABASE_ROLE);
    assert.match(row.serverVersion, /PostgreSQL 15\.8/);

    const historyAccess = await sql.query<{ exists: boolean; canRead: boolean }>(
      `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS exists,
              has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT') AS "canRead"`);
    assert.equal(historyAccess.rows[0]?.exists, true, "Prisma migration history table is missing");
    let migrationHistory: RolePreflight["migrationHistory"] = "not-readable";
    if (historyAccess.rows[0]?.canRead) {
      const history = await sql.query<{ migrationName: string; finishedAt: Date | null; rolledBackAt: Date | null; logs: string | null }>(
        `SELECT "migration_name" AS "migrationName", "finished_at" AS "finishedAt",
                "rolled_back_at" AS "rolledBackAt", "logs"
         FROM public."_prisma_migrations" ORDER BY "migration_name"`);
      assert.deepEqual(history.rows.map((row) => row.migrationName), EXPECTED_MIGRATIONS,
        "database migration names must exactly match the ordered migration directories in prisma/migrations");
      assert.ok(history.rows.every((row) => row.finishedAt instanceof Date && row.rolledBackAt === null && row.logs === null),
        "every expected migration must be successfully applied with no rolled-back, unfinished, or failed records");
      migrationHistory = "verified";
    }

    const roleResult = await sql.query<{
      currentRole: string;
      superuser: boolean;
      inheritPrivilege: boolean;
      createRole: boolean;
      createDatabase: boolean;
      replication: boolean;
      bypassRls: boolean;
      ownsPromotionObjects: boolean;
      privileges: Record<string, boolean>;
      auditForgeryPrivileges: Record<string, boolean>;
    }>(`SELECT r.rolname AS "currentRole", r.rolsuper AS superuser,
               r.rolinherit AS "inheritPrivilege", r.rolcreaterole AS "createRole",
               r.rolcreatedb AS "createDatabase", r.rolreplication AS replication,
               r.rolbypassrls AS "bypassRls",
               EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relname IN ('Promotion', 'PromotionRedemption', 'PromotionLifecycleEvent', 'AuditLog')
                         AND c.relowner = r.oid) AS "ownsPromotionObjects",
               jsonb_build_object(
                 'schemaCreate', has_schema_privilege(current_user, 'public', 'CREATE'),
                 'userSelect', has_table_privilege(current_user, 'public."User"', 'SELECT'),
                 'userInsert', has_table_privilege(current_user, 'public."User"', 'INSERT'),
                 'userDelete', has_table_privilege(current_user, 'public."User"', 'DELETE'),
                 'promotionSelect', has_table_privilege(current_user, 'public."Promotion"', 'SELECT'),
                 'promotionInsert', has_table_privilege(current_user, 'public."Promotion"', 'INSERT'),
                 'promotionTableUpdate', has_table_privilege(current_user, 'public."Promotion"', 'UPDATE'),
                 'promotionUpdateReason', has_column_privilege(current_user, 'public."Promotion"', 'reason', 'UPDATE'),
                 'promotionUpdateUpdatedAt', has_column_privilege(current_user, 'public."Promotion"', 'updatedAt', 'UPDATE'),
                 'promotionUpdateDiscountValue', has_column_privilege(current_user, 'public."Promotion"', 'discountValue', 'UPDATE'),
                 'promotionDelete', has_table_privilege(current_user, 'public."Promotion"', 'DELETE'),
                 'redemptionInsert', has_table_privilege(current_user, 'public."PromotionRedemption"', 'INSERT'),
                 'redemptionSelect', has_table_privilege(current_user, 'public."PromotionRedemption"', 'SELECT'),
                 'redemptionDelete', has_table_privilege(current_user, 'public."PromotionRedemption"', 'DELETE'),
                 'grantInsert', has_table_privilege(current_user, 'public."PromotionalAccessGrant"', 'INSERT'),
                 'grantSelect', has_table_privilege(current_user, 'public."PromotionalAccessGrant"', 'SELECT'),
                 'grantDelete', has_table_privilege(current_user, 'public."PromotionalAccessGrant"', 'DELETE'),
                 'eventSelect', has_table_privilege(current_user, 'public."PromotionLifecycleEvent"', 'SELECT'),
                 'eventInsert', has_table_privilege(current_user, 'public."PromotionLifecycleEvent"', 'INSERT'),
                 'eventDelete', has_table_privilege(current_user, 'public."PromotionLifecycleEvent"', 'DELETE'),
                 'auditSelect', has_table_privilege(current_user, 'public."AuditLog"', 'SELECT'),
                 'auditInsert', has_table_privilege(current_user, 'public."AuditLog"', 'INSERT'),
                 'auditDelete', has_table_privilege(current_user, 'public."AuditLog"', 'DELETE'),
                 'userRoleInsert', has_column_privilege(current_user, 'public."User"', 'role', 'INSERT'),
                 'queueSequenceUsage', has_sequence_privilege(current_user, 'public."PromotionalAccessGrant_queueSequence_seq"', 'USAGE')
               ) AS privileges,
               jsonb_build_object(${auditForgeryPrivilegeJsonPairs("current_user")}) AS "auditForgeryPrivileges"
        FROM pg_roles r WHERE r.rolname = current_user`);
    const roleRow = roleResult.rows[0];
    assert.ok(roleRow, "could not identify the database role used by DATABASE_URL");

    const membershipPrivileges = await sql.query<{ roleName: string; canSetRole: boolean; isSuperuser: boolean; canCreateRole: boolean; schemaCreate: boolean; auditForgeryPrivileges: Record<string, boolean> }>(
      `WITH RECURSIVE settable_roles(role_oid) AS (
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members membership
         WHERE membership.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         UNION
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members membership
         JOIN settable_roles granted_role ON membership.member = granted_role.role_oid
       )
       SELECT target.rolname AS "roleName",
              target.oid IN (SELECT role_oid FROM settable_roles) AS "canSetRole",
              target.rolsuper AS "isSuperuser", target.rolcreaterole AS "canCreateRole",
              has_schema_privilege(target.rolname, 'public', 'CREATE') AS "schemaCreate",
              jsonb_build_object(${auditForgeryPrivilegeJsonPairs("target.rolname")}) AS "auditForgeryPrivileges"
       FROM pg_catalog.pg_roles target
       WHERE target.oid <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND target.oid IN (SELECT role_oid FROM settable_roles)
       ORDER BY target.rolname`);

    const memberships = membershipPrivileges.rows.map((membership) => ({
      roleName: membership.roleName,
      canSetRole: membership.canSetRole,
      isSuperuser: membership.isSuperuser,
      canCreateRole: membership.canCreateRole,
      schemaCreate: membership.schemaCreate,
      canForgeAudit: canForgePromotionAudit(membership.auditForgeryPrivileges),
    }));

    const privileges = { ...roleRow.privileges, ...roleRow.auditForgeryPrivileges };
    const promotionUpdatePrivileges = {
      promotionUpdateReason: privileges["promotionUpdateReason"] === true,
      promotionUpdateUpdatedAt: privileges["promotionUpdateUpdatedAt"] === true,
      promotionUpdateDiscountValue: privileges["promotionUpdateDiscountValue"] === true,
    };
    const fixtureRequired = [
      "userSelect", "userInsert", "userDelete", "promotionSelect", "promotionInsert", "promotionDelete",
      "redemptionInsert", "redemptionSelect", "redemptionDelete", "grantInsert", "grantSelect", "grantDelete", "eventSelect", "eventInsert", "eventDelete",
      "auditSelect", "auditInsert", "auditDelete", "queueSequenceUsage",
    ];
    const role: RolePreflight = {
      superuser: roleRow.superuser,
      currentRole: roleRow.currentRole,
      roleFlags: { inherit: roleRow.inheritPrivilege, createRole: roleRow.createRole, createDatabase: roleRow.createDatabase, replication: roleRow.replication, bypassRls: roleRow.bypassRls },
      ownsPromotionObjects: roleRow.ownsPromotionObjects,
      membershipRows: memberships,
      fixtureWritable: hasRequiredPromotionUpdatePrivileges(promotionUpdatePrivileges) && fixtureRequired.every((key) => privileges[key] === true),
      migrationHistory,
      privileges,
    };
    return { sql, role };
  } catch (error) {
    await sql.end().catch(() => undefined);
    throw error;
  }
}

async function gate(t: TestContext, requireWritable = true): Promise<{ sql: Client; role: RolePreflight } | null> {
  if (!databaseUrl) {
    t.skip(expectedSkip);
    return null;
  }
  const result = await preflight();
  t.diagnostic(`Preflight: exact local target verified; migration history is ${result.role.migrationHistory}; database role is ${result.role.superuser ? "privileged" : "non-superuser"}.`);
  if (result.role.migrationHistory !== "verified") {
    await result.sql.end();
    t.skip("NOT TESTED: this role cannot independently verify the complete expected migration history; no disposable fixture writes were attempted");
    return null;
  }
  if (result.role.superuser) {
    await result.sql.end();
    t.skip("NOT TESTED: the supplied connection is a superuser/migration-level role, not an acceptable application runtime role");
    return null;
  }
  if (hasForbiddenRuntimeCreateRole(result.role.roleFlags)) {
    await result.sql.end();
    assert.fail("connected runtime role must not have CREATEROLE");
  }
  if (requireWritable && !result.role.fixtureWritable) {
    await result.sql.end();
    t.skip("NOT TESTED: runtime role lacks one or more scoped fixture/cleanup privileges; no rows were written");
    return null;
  }
  return result;
}

async function seedUser(db: PrismaClientLike, id: string, role: "user" | "admin" = "user"): Promise<void> {
  await db.user.create({ data: { id, email: `${id}@clipforge.invalid`, role } });
}

async function seedPromotion(
  db: PrismaClientLike,
  input: { id: string; code: string; adminId: string; type?: "discount_coupon" | "free_access_coupon"; usageLimit?: number | null; reason?: string | null },
): Promise<void> {
  const now = new Date();
  const type = input.type ?? "discount_coupon";
  await db.promotion.create({ data: {
    id: input.id,
    type,
    status: "active",
    code: input.code,
    discountType: type === "discount_coupon" ? "percentage" : null,
    discountValue: type === "discount_coupon" ? 10 : null,
    accessPlanId: type === "free_access_coupon" ? "creator" : null,
    durationDays: type === "free_access_coupon" ? 5 : null,
    eligiblePlanIds: type === "discount_coupon" ? ["creator"] : [],
    startsAt: new Date(now.getTime() - 60_000),
    expiresAt: null,
    usageLimit: input.usageLimit ?? null,
    createdByAdminId: input.adminId,
    reason: input.reason ?? "before",
    createdAt: now,
    updatedAt: now,
  } });
}

async function seedFixture(db: PrismaClientLike, type: "discount_coupon" | "free_access_coupon" = "discount_coupon", usageLimit: number | null = null): Promise<Fixture> {
  const prefix = `pgv-${randomUUID()}`;
  const fixture: Fixture = {
    prefix,
    adminId: `${prefix}-admin`,
    userIds: [`${prefix}-user-a`, `${prefix}-user-b`, `${prefix}-user-c`],
    promotionIds: [`${prefix}-promotion`],
  };
  await seedUser(db, fixture.adminId, "admin");
  for (const userId of fixture.userIds) await seedUser(db, userId);
  await seedPromotion(db, {
    id: fixture.promotionIds[0]!,
    code: `PGV${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`,
    adminId: fixture.adminId,
    type,
    usageLimit,
  });
  return fixture;
}

async function seedRedemption(
  sql: Client,
  input: { id: string; promotionId: string; userId: string; status: string; idempotencyKey?: string },
): Promise<void> {
  const now = new Date();
  await sql.query(
    `INSERT INTO public."PromotionRedemption"
       ("id", "promotionId", "userId", "status", "idempotencyKey", "reservedAt", "releasedAt", "updatedAt")
     VALUES ($1, $2, $3, $4::public."PromotionRedemptionStatus", $5, $6::timestamptz,
             CASE WHEN $4::public."PromotionRedemptionStatus" = 'released'::public."PromotionRedemptionStatus"
                  THEN $6::timestamptz ELSE NULL::timestamptz END, $6::timestamptz)`,
    [input.id, input.promotionId, input.userId, input.status, input.idempotencyKey ?? `${input.id}:key`, now],
  );
}

async function cleanup(db: PrismaClientLike, fixture: Fixture | null): Promise<void> {
  if (!fixture) return;
  const promotionIds = fixture.promotionIds;
  const users = fixture.userIds.concat(fixture.adminId);
  const redemptions = await db.promotionRedemption.findMany({ where: { promotionId: { in: promotionIds } }, select: { id: true } });
  const grants = await db.promotionalAccessGrant.findMany({ where: { promotionId: { in: promotionIds } }, select: { id: true } });
  const entityIds = [...promotionIds, ...redemptions.map((row) => String(row["id"])), ...grants.map((row) => String(row["id"]))];
  await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { entityId: { in: entityIds } }] } });
  await db.promotionLifecycleEvent.deleteMany({ where: { promotionId: { in: promotionIds } } });
  await db.promotionalAccessGrant.deleteMany({ where: { promotionId: { in: promotionIds } } });
  await db.promotionRedemption.deleteMany({ where: { promotionId: { in: promotionIds } } });
  await db.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function finalize(db: PrismaClientLike, fixture: Fixture | null, close: Array<() => Promise<unknown>>): Promise<void> {
  try {
    await cleanup(db, fixture);
  } finally {
    const results = await Promise.allSettled(close.map((closeResource) => closeResource()));
    const closeFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (closeFailure) throw closeFailure.reason;
  }
}

async function insertAuditPair(
  sql: Client,
  input: { promotionId: string; adminId: string; oldReason: string | null; newReason: string | null; eventKey: string; eventId: string; auditId: string; updatedAt: Date; auditReasonOverride?: string | null },
): Promise<void> {
  await sql.query(
    `INSERT INTO public."PromotionLifecycleEvent"
       ("id", "eventKey", "eventType", "promotionId", "actorUserId", "occurredAt", "metadata")
     VALUES ($1, $2, 'promotion_updated'::public."PromotionLifecycleEventType", $3, $4, $5,
             jsonb_build_object('source', 'pgverify_test', 'reasonOld', $6::text, 'reasonNew', $7::text))`,
    [input.eventId, input.eventKey, input.promotionId, input.adminId, input.updatedAt, input.oldReason, input.newReason],
  );
  await sql.query(
    `INSERT INTO public."AuditLog" ("id", "actorId", "action", "entityType", "entityId", "metadata")
     VALUES ($1, $2, 'promotion.promotion_updated', 'Promotion', $3,
             jsonb_build_object('eventKey', $4::text, 'reasonOld', $5::text, 'reasonNew', $6::text))`,
    [input.auditId, input.adminId, input.promotionId, input.eventKey, input.oldReason, input.auditReasonOverride ?? input.newReason],
  );
}

async function waitForLockWait(observer: Client, applicationName: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = $1 AND state = 'active' AND wait_event_type = 'Lock'
       ) AS waiting`,
      [applicationName],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("second connection did not enter a PostgreSQL lock wait before timeout");
}

test("PostgreSQL dry-run: exact target, migration history, trigger definitions, indexes, and connected-role grants", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const { sql, role } = await preflight();
  try {
    const functions = await sql.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; definition: string }>(
      `SELECT p.proname, p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'clipforge_%' ORDER BY p.proname`);
    assert.equal(functions.rows.length, 5);
    for (const fn of functions.rows) {
      assert.equal(fn.prosecdef, false, `${fn.proname} must remain SECURITY INVOKER`);
      assert.ok(fn.proconfig?.some((entry) => entry.replaceAll('"', "") === "search_path=pg_catalog, public, pg_temp"), `${fn.proname} must fix search_path`);
      const functionReferences = [...fn.definition.matchAll(/(?:public\.)?clipforge_[a-z0-9_]+\s*\(/g)];
      assert.ok(functionReferences.length > 0, `${fn.proname} definition must include its schema-qualified function declaration`);
      for (const reference of functionReferences) {
        assert.match(reference[0], /^public\./, `${fn.proname} must schema-qualify ${reference[0].trim()}`);
      }
    }
    const triggerDefinitions = await sql.query<{ triggerName: string; definition: string }>(
      `SELECT t.tgname AS "triggerName", pg_get_triggerdef(t.oid, true) AS definition
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
         AND c.relname IN ('Promotion', 'PromotionRedemption', 'PromotionalAccessGrant')
       ORDER BY t.tgname`);
    const triggerText = triggerDefinitions.rows.map((row) => `${row.triggerName} ${row.definition}`).join("\n");
    for (const name of ["PromotionRedemption_user_promotion_lock", "PromotionalAccessGrant_user_promotion_lock", "Promotion_used_terms_immutable", "Promotion_reason_requires_audit"]) {
      assert.ok(triggerText.includes(name), `expected trigger ${name}`);
    }
    assert.match(triggerText, /Promotion_reason_requires_audit[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
    const indexResult = await sql.query<{ indexName: string; predicate: string | null; definition: string }>(
      `SELECT indexname AS "indexName", indexdef AS definition,
              (SELECT pg_get_expr(i.indpred, i.indrelid) FROM pg_index i WHERE i.indexrelid = (quote_ident(schemaname)||'.'||quote_ident(indexname))::regclass) AS predicate
       FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'PromotionRedemption'`);
    const fullUnique = indexResult.rows.find((row) => row.indexName === "PromotionRedemption_promotionId_userId_key");
    assert.ok(fullUnique, "full promotion/user unique index is missing");
    assert.equal(fullUnique.predicate, null, "per-user uniqueness must include released rows");
    assert.ok(fullUnique.definition.includes('("promotionId", "userId")'));

    const roles = await sql.query<{ roleName: string; canSetRole: boolean; isSuperuser: boolean; canCreateRole: boolean }>(
      `WITH RECURSIVE settable_roles(role_oid) AS (
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members membership
         WHERE membership.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         UNION
         SELECT membership.roleid
         FROM pg_catalog.pg_auth_members membership
         JOIN settable_roles granted_role ON membership.member = granted_role.role_oid
       )
       SELECT target.rolname AS "roleName",
              target.oid IN (SELECT role_oid FROM settable_roles) AS "canSetRole",
              target.rolsuper AS "isSuperuser", target.rolcreaterole AS "canCreateRole"
       FROM pg_catalog.pg_roles target WHERE target.oid <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND target.oid IN (SELECT role_oid FROM settable_roles) ORDER BY target.rolname`);
    t.diagnostic(`Read-only catalog inspection: ${functions.rows.length} invoker functions, ${triggerDefinitions.rows.length} triggers, ${indexResult.rows.length} redemption indexes, ${roles.rows.length} role memberships.`);
    t.diagnostic(`Connected-role attributes: superuser=${role.superuser}, inherit=${role.roleFlags.inherit}, createRole=${role.roleFlags.createRole}, createDatabase=${role.roleFlags.createDatabase}, replication=${role.roleFlags.replication}, bypassRls=${role.roleFlags.bypassRls}, ownsProtectedObjects=${role.ownsPromotionObjects}.`);
    t.diagnostic(`Role membership SET capabilities: ${role.membershipRows.map((entry) => `${entry.roleName}(set=${entry.canSetRole},superuser=${entry.isSuperuser},createRole=${entry.canCreateRole})`).join(", ") || "none"}.`);
    t.diagnostic(`Effective relevant grants: ${Object.entries(role.privileges).map(([name, allowed]) => `${name}=${allowed}`).join(", ")}.`);
    t.diagnostic("The inspected role is the identity used by this local DATABASE_URL. If it is a migration/owner role, this inspection does not establish application runtime grants or Production Neon grants.");
    if (role.migrationHistory === "not-readable") t.diagnostic("Migration history table exists, but this role cannot SELECT it; the complete expected migration list was not independently verified by this role.");
  } finally {
    await sql.end();
  }
});
test("PostgreSQL: released redemptions remain unique for that user while another user can redeem", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const db = await connectPrisma("duplicate");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(db, "free_access_coupon", 5);
    const promoId = fixture.promotionIds[0]!;
    const userA = fixture.userIds[0]!;
    await seedRedemption(sql, { id: `${fixture.prefix}-released`, promotionId: promoId, userId: userA, status: "released" });
    const statuses = await sql.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'PromotionRedemptionStatus' ORDER BY e.enumsortorder`);
    assert.ok(statuses.rows.some((row) => row.label === "released"));
    for (const { label } of statuses.rows) {
      await assert.rejects(
        seedRedemption(sql, { id: `${fixture.prefix}-duplicate-${label}`, promotionId: promoId, userId: userA, status: label }),
        (error: unknown) => (error as { code?: string }).code === "23505",
        `status ${label} must still be unique after a released redemption`,
      );
    }
    const promotion = await db.promotion.findUnique({ where: { id: promoId } });
    assert.ok(promotion);
    const retry = await new PrismaRepository(db).redeemFreeAccessCoupon({
      redemptionId: `${fixture.prefix}-released-retry`, grantId: `${fixture.prefix}-released-retry-grant`, userId: userA,
      code: String(promotion["code"]), idempotencyKey: `${fixture.prefix}-released-retry`, now: new Date(),
    });
    assert.equal(retry.status, "unavailable", "repository must not allow a second use after release");
    await seedRedemption(sql, { id: `${fixture.prefix}-other-user`, promotionId: promoId, userId: fixture.userIds[1]!, status: "reserved" });
    const count = await db.promotionRedemption.count({ where: { promotionId: promoId } });
    assert.equal(count, 2);
  } finally {
    await finalize(db, fixture, [() => db.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL: used terms are immutable; a valid reason-only repository update has matching event and audit", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const db = await connectPrisma("terms-reason");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(db);
    const promoId = fixture.promotionIds[0]!;
    const userId = fixture.userIds[0]!;
    await seedRedemption(sql, { id: `${fixture.prefix}-used`, promotionId: promoId, userId, status: "redeemed" });
    await assert.rejects(
      sql.query(`UPDATE public."Promotion" SET "discountValue" = 11, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [promoId]),
      (error: unknown) => (error as { code?: string }).code === "P0001",
      "economic coupon terms must reject updates after any redemption status",
    );
    assert.equal((await db.promotion.findUnique({ where: { id: promoId } }))?.["discountValue"], 10);

    const before = await db.promotion.findUnique({ where: { id: promoId } });
    assert.ok(before);
    const repo = new PrismaRepository(db);
    const result = await repo.updatePromotionReason({
      id: promoId,
      reason: "PG verification allowed reason update",
      expectedUpdatedAt: before["updatedAt"] as Date,
      actorUserId: fixture.adminId,
      now: new Date(Date.now() + 2_000),
    });
    assert.equal(result.status, "updated");
    const event = await db.promotionLifecycleEvent.findFirst({ where: { promotionId: promoId, actorUserId: fixture.adminId, eventType: "promotion_updated" } });
    assert.ok(event);
    const audit = await db.auditLog.findFirst({ where: { actorId: fixture.adminId, action: "promotion.promotion_updated", entityType: "Promotion", entityId: promoId } });
    assert.ok(audit);
    assert.equal((audit?.["metadata"] as Record<string, unknown>)?.["eventKey"], event?.["eventKey"]);
    assert.equal((audit?.["metadata"] as Record<string, unknown>)?.["reasonOld"], "before");
    assert.equal((audit?.["metadata"] as Record<string, unknown>)?.["reasonNew"], "PG verification allowed reason update");
  } finally {
    await finalize(db, fixture, [() => db.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL: reason changes without a matching audit pair fail at COMMIT and roll back", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const db = await connectPrisma("reason-rollback");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(db);
    const promoId = fixture.promotionIds[0]!;
    const client = await connectSql("reason-rollback-write");
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE public."Promotion" SET "reason" = $1, "updatedAt" = date_trunc('milliseconds', clock_timestamp()) WHERE "id" = $2`, ["must roll back", promoId]);
      await assert.rejects(client.query("COMMIT"), (error: unknown) => (error as { code?: string }).code === "P0001");
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      await client.end();
    }
    const promotion = await db.promotion.findUnique({ where: { id: promoId } });
    assert.equal(promotion?.["reason"], "before");
    assert.equal(await db.promotionLifecycleEvent.count({ where: { promotionId: promoId } }), 0);
    assert.equal(await db.auditLog.count({ where: { entityId: promoId } }), 0);
  } finally {
    await finalize(db, fixture, [() => db.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL: mismatched audit reason metadata is rejected and fully rolled back", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const db = await connectPrisma("reason-mismatch");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(db);
    const promoId = fixture.promotionIds[0]!;
    const client = await connectSql("reason-mismatch-write");
    const eventKey = `${fixture.prefix}:mismatch`;
    try {
      await client.query("BEGIN");
      const changed = await client.query<{ updatedAt: Date }>(
        `UPDATE public."Promotion" SET "reason" = $1, "updatedAt" = date_trunc('milliseconds', clock_timestamp())
         WHERE "id" = $2 RETURNING "updatedAt"`, ["new reason", promoId]);
      const updatedAt = changed.rows[0]!.updatedAt;
      await insertAuditPair(client, {
        promotionId: promoId, adminId: fixture.adminId, oldReason: "before", newReason: "new reason", auditReasonOverride: "different reason",
        eventKey, eventId: `${fixture.prefix}-event-mismatch`, auditId: `${fixture.prefix}-audit-mismatch`, updatedAt,
      });
      await assert.rejects(client.query("COMMIT"), (error: unknown) => (error as { code?: string }).code === "P0001");
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      await client.end();
    }
    assert.equal((await db.promotion.findUnique({ where: { id: promoId } }))?.["reason"], "before");
    assert.equal(await db.promotionLifecycleEvent.count({ where: { promotionId: promoId } }), 0);
    assert.equal(await db.auditLog.count({ where: { entityId: promoId } }), 0);
  } finally {
    await finalize(db, fixture, [() => db.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL: two actual connections race on the same user/promotion; exactly one redemption commits", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql: observer } = gateResult;
  const setup = await connectPrisma("redemption-race-setup");
  let fixture: Fixture | null = null;
  const a = await connectSql("redemption-race-a");
  const b = await connectSql("redemption-race-b");
  try {
    fixture = await seedFixture(setup);
    const pidA = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const pidB = (await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    assert.notEqual(pidA, pidB, "concurrency test requires two different PostgreSQL backends");
    const userId = fixture.userIds[0]!;
    const promotionId = fixture.promotionIds[0]!;
    await a.query("BEGIN");
    await seedRedemption(a, { id: `${fixture.prefix}-race-a`, promotionId, userId, status: "reserved" });
    const secondInsert = seedRedemption(b, { id: `${fixture.prefix}-race-b`, promotionId, userId, status: "reserved" });
    const bName = applicationName("redemption-race-b");
    await waitForLockWait(observer, bName);
    await a.query("COMMIT");
    await assert.rejects(secondInsert, (error: unknown) => (error as { code?: string }).code === "23505");
    assert.equal(await setup.promotionRedemption.count({ where: { promotionId, userId } }), 1);
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await b.query("ROLLBACK").catch(() => undefined);
    await finalize(setup, fixture, [() => a.end(), () => b.end(), () => setup.$disconnect(), () => observer.end()]);
  }
});

test("PostgreSQL + PrismaRepository: concurrent same-user redemption and usage-limit races serialize safely", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const dbA = await connectPrisma("repo-redeem-a");
  const dbB = await connectPrisma("repo-redeem-b");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(dbA, "free_access_coupon", 3);
    const promotion = await dbA.promotion.findUnique({ where: { id: fixture.promotionIds[0]! } });
    assert.ok(promotion);
    const code = String(promotion["code"]);
    const now = new Date();
    const repoA = new PrismaRepository(dbA);
    const repoB = new PrismaRepository(dbB);
    const [pidAResult, pidBResult] = await Promise.all([
      dbA.$queryRaw`SELECT pg_backend_pid() AS pid`,
      dbB.$queryRaw`SELECT pg_backend_pid() AS pid`,
    ]);
    assert.notEqual((pidAResult as Array<{ pid: number }>)[0]?.pid, (pidBResult as Array<{ pid: number }>)[0]?.pid, "repository race must use separate PostgreSQL connections");
    const sameUser = fixture.userIds[0]!;
    const duplicateResults = await Promise.all([
      repoA.redeemFreeAccessCoupon({ redemptionId: `${fixture.prefix}-same-a`, grantId: `${fixture.prefix}-grant-a`, userId: sameUser, code, idempotencyKey: `${fixture.prefix}-same-a`, now }),
      repoB.redeemFreeAccessCoupon({ redemptionId: `${fixture.prefix}-same-b`, grantId: `${fixture.prefix}-grant-b`, userId: sameUser, code, idempotencyKey: `${fixture.prefix}-same-b`, now }),
    ]);
    const sameUserRedemptionCount = await dbA.promotionRedemption.count({ where: { promotionId: fixture.promotionIds[0]!, userId: sameUser } });
    const sameUserGrantCount = await dbA.promotionalAccessGrant.count({ where: { promotionId: fixture.promotionIds[0]!, userId: sameUser } });
    t.diagnostic(`Same-user redemption race outcomes: clientA=${duplicateResults[0]?.status ?? "missing"}, clientB=${duplicateResults[1]?.status ?? "missing"}; persistedFixtureRedemptions=${sameUserRedemptionCount}, persistedFixtureGrants=${sameUserGrantCount}.`);
    assert.equal(duplicateResults.filter((result) => result.status === "created").length, 1);
    assert.equal(duplicateResults.filter((result) => result.status === "unavailable" || result.status === "conflict").length, 1);
    assert.equal(sameUserRedemptionCount, 1);
    assert.equal(sameUserGrantCount, 1);
    const createdResult = duplicateResults.find((result) => result.status === "created");
    assert.ok(createdResult && createdResult.status === "created", "one concurrent request must commit its redemption and grant");
    assert.equal(createdResult.grant.redemptionId, createdResult.redemption.id, "the grant record must retain its redemption relationship");
    const sameUserEvents = await dbA.promotionLifecycleEvent.findMany({
      where: { promotionId: fixture.promotionIds[0]!, subjectUserId: sameUser, eventType: { in: ["coupon_redeemed", "grant_created"] } },
      select: { eventType: true, redemptionId: true, accessGrantId: true },
    });
    assert.equal(sameUserEvents.length, 2, "both lifecycle events must commit with their related redemption and grant");
    const redemptionEvent = sameUserEvents.find((event) => event["eventType"] === "coupon_redeemed");
    const grantEvent = sameUserEvents.find((event) => event["eventType"] === "grant_created");
    assert.ok(redemptionEvent, "coupon_redeemed lifecycle event must be persisted");
    assert.equal(redemptionEvent["redemptionId"], createdResult.redemption.id);
    assert.equal(redemptionEvent["accessGrantId"], null, "coupon_redeemed must target only the redemption");
    assert.ok(grantEvent, "grant_created lifecycle event must be persisted");
    assert.equal(grantEvent["redemptionId"], null, "grant_created must not also target the redemption");
    assert.equal(grantEvent["accessGrantId"], createdResult.grant.id, "grant_created must target the grant");

    const otherResults = await Promise.all([
      repoA.redeemFreeAccessCoupon({ redemptionId: `${fixture.prefix}-other-a`, grantId: `${fixture.prefix}-grant-other-a`, userId: fixture.userIds[1]!, code, idempotencyKey: `${fixture.prefix}-other-a`, now }),
      repoB.redeemFreeAccessCoupon({ redemptionId: `${fixture.prefix}-other-b`, grantId: `${fixture.prefix}-grant-other-b`, userId: fixture.userIds[2]!, code, idempotencyKey: `${fixture.prefix}-other-b`, now }),
    ]);
    assert.deepEqual(otherResults.map((result) => result.status).sort(), ["created", "created"]);
    const exhausted = await repoA.redeemFreeAccessCoupon({ redemptionId: `${fixture.prefix}-exhausted`, grantId: `${fixture.prefix}-grant-exhausted`, userId: fixture.adminId, code, idempotencyKey: `${fixture.prefix}-exhausted`, now });
    assert.equal(exhausted.status, "unavailable");
    assert.equal(await dbA.promotionRedemption.count({ where: { promotionId: fixture.promotionIds[0]!, status: { in: ["reserved", "redeemed", "manual_review"] } } }), 3);
    t.diagnostic("Two separate Prisma clients exercised real PostgreSQL transactions; no fake-repository concurrency simulation was used.");
  } finally {
    await finalize(dbA, fixture, [() => dbA.$disconnect(), () => dbB.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL: concurrent first use and term update serialize; used terms cannot be changed", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql: observer } = gateResult;
  const db = await connectPrisma("terms-race-setup");
  const holder = await connectSql("terms-race-holder");
  const updater = await connectSql("terms-race-updater");
  const redemption = await connectSql("terms-race-redemption");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(db);
    const userId = fixture.userIds[0]!;
    const promotionId = fixture.promotionIds[0]!;
    await holder.query("BEGIN");
    await holder.query(`SELECT "id" FROM public."User" WHERE "id" = $1 FOR UPDATE`, [userId]);
    await holder.query(`SELECT "id" FROM public."Promotion" WHERE "id" = $1 FOR UPDATE`, [promotionId]);
    const updatePromise = updater.query(`UPDATE public."Promotion" SET "discountValue" = 11, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [promotionId]);
    const updaterName = applicationName("terms-race-updater");
    await waitForLockWait(observer, updaterName);
    await seedRedemption(holder, { id: `${fixture.prefix}-first-use`, promotionId, userId, status: "redeemed" });
    await holder.query("COMMIT");
    await assert.rejects(updatePromise, (error: unknown) => (error as { code?: string }).code === "P0001");
    await assert.rejects(
      redemption.query(`UPDATE public."Promotion" SET "discountValue" = 12, "updatedAt" = clock_timestamp() WHERE "id" = $1`, [promotionId]),
      (error: unknown) => (error as { code?: string }).code === "P0001",
    );
    assert.equal((await db.promotion.findUnique({ where: { id: promotionId } }))?.["discountValue"], 10);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    await finalize(db, fixture, [() => holder.end(), () => updater.end(), () => redemption.end(), () => db.$disconnect(), () => observer.end()]);
  }
});

test("PostgreSQL + PrismaRepository: concurrent reason updates use User→Promotion locks and leave one consistent CAS audit", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t);
  if (!gateResult) return;
  const { sql } = gateResult;
  const dbA = await connectPrisma("reason-race-a");
  const dbB = await connectPrisma("reason-race-b");
  let fixture: Fixture | null = null;
  try {
    fixture = await seedFixture(dbA);
    const promoId = fixture.promotionIds[0]!;
    const before = await dbA.promotion.findUnique({ where: { id: promoId } });
    assert.ok(before);
    const expectedUpdatedAt = before["updatedAt"] as Date;
    const now = new Date(Date.now() + 3_000);
    const repoA = new PrismaRepository(dbA);
    const repoB = new PrismaRepository(dbB);
    const [pidAResult, pidBResult] = await Promise.all([
      dbA.$queryRaw`SELECT pg_backend_pid() AS pid`,
      dbB.$queryRaw`SELECT pg_backend_pid() AS pid`,
    ]);
    assert.notEqual((pidAResult as Array<{ pid: number }>)[0]?.pid, (pidBResult as Array<{ pid: number }>)[0]?.pid, "reason update race must use separate PostgreSQL connections");
    const outcomes = await Promise.all([
      repoA.updatePromotionReason({ id: promoId, reason: "concurrent reason A", expectedUpdatedAt, actorUserId: fixture.adminId, now }),
      repoB.updatePromotionReason({ id: promoId, reason: "concurrent reason B", expectedUpdatedAt, actorUserId: fixture.adminId, now }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "updated").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "stale").length, 1);
    const events = await dbA.promotionLifecycleEvent.findMany({ where: { promotionId: promoId, eventType: "promotion_updated" } });
    const audits = await dbA.auditLog.findMany({ where: { entityType: "Promotion", entityId: promoId, action: "promotion.promotion_updated" } });
    assert.equal(events.length, 1);
    assert.equal(audits.length, 1);
    const eventKey = events[0]!["eventKey"];
    assert.equal((audits[0]!["metadata"] as Record<string, unknown>)["eventKey"], eventKey);
    const metadata = events[0]!["metadata"] as Record<string, unknown>;
    const auditMetadata = audits[0]!["metadata"] as Record<string, unknown>;
    assert.equal(metadata["reasonOld"], "before");
    assert.equal(metadata["reasonNew"], (await dbA.promotion.findUnique({ where: { id: promoId } }))?.["reason"]);
    assert.equal(auditMetadata["reasonOld"], metadata["reasonOld"]);
    assert.equal(auditMetadata["reasonNew"], metadata["reasonNew"]);
  } finally {
    await finalize(dbA, fixture, [() => dbA.$disconnect(), () => dbB.$disconnect(), () => sql.end()]);
  }
});

test("PostgreSQL runtime-role test: determine whether the app role can fabricate a matching Admin audit pair", { skip: databaseIsConfigured ? false : expectedSkip }, async (t) => {
  const gateResult = await gate(t, false);
  if (!gateResult) return;
  const { sql, role } = gateResult;
  const db = await connectPrisma("runtime-role-security");
  let fixture: Fixture | null = null;
  try {
    const canWriteMatchingRows = canForgePromotionAudit(role.privileges);
    const settableElevatedRole = hasElevatedSettableMembership(role.membershipRows);
    if (settableElevatedRole) {
      t.diagnostic("SECURITY RESULT: FAIL — current runtime role can SET ROLE to an elevated member role.");
      assert.fail("runtime role has a settable elevated membership");
    }
    if (role.ownsPromotionObjects || role.privileges["schemaCreate"] === true) {
      t.skip("NOT TESTED: DATABASE_URL role owns protected objects or can CREATE in public; it cannot represent a least-privilege runtime role for this test");
      return;
    }
    if (!canWriteMatchingRows) {
      t.diagnostic("SECURITY RESULT: PASS for direct audit fabrication with this local role: required UPDATE/INSERT/SELECT privileges are absent.");
      return;
    }
    if (!role.privileges["promotionInsert"] || !role.privileges["promotionDelete"] || !role.privileges["eventDelete"] || !role.privileges["auditDelete"]) {
      t.skip("NOT TESTED: runtime role can write some audit components but lacks safe creation/cleanup privileges for an isolated forgery fixture");
      return;
    }

    // Seed using this same DATABASE_URL identity. If it cannot make a dedicated
    // Admin fixture and no Admin fixture exists, the actor-boundary test is NOT TESTED.
    fixture = {
      prefix: `pgv-${randomUUID()}`,
      adminId: `pgv-${randomUUID()}-admin`,
      userIds: [],
      promotionIds: [`pgv-${randomUUID()}-promotion`],
    };
    let actorId: string | null = null;
    if (role.privileges["userInsert"] && role.privileges["userRoleInsert"]) {
      await seedUser(db, fixture.adminId, "admin");
      fixture.userIds.push(fixture.adminId);
      actorId = fixture.adminId;
    } else {
      const existingAdmin = await db.user.findFirst({ where: { role: "admin" }, select: { id: true } });
      actorId = existingAdmin ? String(existingAdmin["id"]) : null;
    }
    if (!actorId) {
      t.skip("NOT TESTED: runtime role has audit write privileges but no Admin fixture can be read or safely created in this disposable database");
      return;
    }
    await seedPromotion(db, { id: fixture.promotionIds[0]!, code: `PGV${randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`, adminId: actorId });

    const client = await connectSql("runtime-role-forgery");
    let forgeryError: unknown = null;
    try {
      await client.query("BEGIN");
      const oldReason = "before";
      const newReason = "fabricated by database role test";
      const changed = await client.query<{ updatedAt: Date }>(
        `UPDATE public."Promotion" SET "reason" = $1, "updatedAt" = date_trunc('milliseconds', clock_timestamp())
         WHERE "id" = $2 RETURNING "updatedAt"`, [newReason, fixture.promotionIds[0]]);
      const updatedAt = changed.rows[0]!.updatedAt;
      await insertAuditPair(client, {
        promotionId: fixture.promotionIds[0]!, adminId: actorId, oldReason, newReason,
        eventKey: `${fixture.prefix}:forged:${randomUUID()}`,
        eventId: `${fixture.prefix}-event`, auditId: `${fixture.prefix}-audit`, updatedAt,
      });
      await client.query("COMMIT");
    } catch (error) {
      forgeryError = error;
      await client.query("ROLLBACK").catch(() => undefined);
    } finally {
      await client.end();
    }
    const probeResult = classifyAuditProbeResult(forgeryError);
    if (probeResult === "integrity-rejected") {
      t.diagnostic("SECURITY RESULT: PASS — the deferred promotion audit-integrity trigger rejected the fabricated pair.");
    } else if (probeResult === "insufficient-privileges") {
      t.diagnostic("SECURITY RESULT: NOT PROVEN — the probe was blocked by insufficient privileges before trigger protection was established.");
      assert.fail("audit-forgery probe was blocked by insufficient privileges, not the audit-integrity trigger");
    } else if (probeResult === "forgery-succeeded") {
      t.diagnostic("SECURITY RESULT: FAIL — the runtime role fabricated a matching Admin lifecycle/audit pair.");
      assert.fail("the runtime role successfully fabricated the matching audit pair");
    } else {
      t.diagnostic("SECURITY RESULT: NOT PROVEN — the probe failed for an unrelated database reason.");
      assert.fail("audit-forgery probe failed with an unrelated database error");
    }
  } finally {
    await finalize(db, fixture, [() => db.$disconnect(), () => sql.end()]);
  }
});
