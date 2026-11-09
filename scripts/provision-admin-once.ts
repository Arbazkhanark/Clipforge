/**
 * One-time initial admin provisioning. This file deliberately does not load dotenv files.
 * Dry-run requires a separately configured read-only database credential. Promotion requires
 * an explicit target, an approval reference, and an interactive exact-ID confirmation.
 */
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PrismaClientLike, Row } from "../src/server/prisma/prisma-client-like.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";

const PROVISIONING_LOCK_KEY = 0x434c6970466f7267n;
const APPROVAL_REFERENCE = /^(?:CHG|SEC|OPS)-[A-Za-z0-9]{2,32}$/;
const REQUIRED_LOCAL_TEST_TARGET = "127.0.0.1:5434/clipforge_local_test";

export type ProvisioningMode = "dry-run" | "promote";
export interface ProvisioningInspection {
  userId: string;
  found: boolean;
  maskedEmail: string | null;
  currentRole: string | null;
  emailVerified: boolean;
  passwordLoginEligible: boolean;
  existingAdminCount: number;
  eligible: boolean;
  blockers: string[];
}
interface ProvisionAdminInput {
  userId: string;
  confirmation: string;
  approvalReference: string;
  now?: Date;
}
export interface ProvisionAdminResult { userId: string; revokedSessions: number; auditRecorded: true; }
export interface DatabaseIdentity { databaseName: string; host: string; port: number; }
export interface ReadOnlyPrivilegeReport {
  safeRoleAttributes: boolean;
  noRoleMemberships: boolean;
  noDatabaseCreate: boolean;
  noDatabaseTemporary: boolean;
  noSchemaCreate: boolean;
  noUserRowSecurity: boolean;
  noObjectWrites: boolean;
  noColumnWrites: boolean;
  noSequenceWrites: boolean;
  noLargeObjectWrites: boolean;
  noOwnedObjects: boolean;
  noExecutableSecurityDefinerFunctions: boolean;
}

function fail(message: string): never { throw new Error(message); }

function requireSingleRow(result: unknown, message: string): Record<string, unknown> {
  if (!Array.isArray(result) || result.length !== 1) fail(message);
  const row: unknown = result[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) fail(message);
  return row as Record<string, unknown>;
}

function requireId(userId: string): string {
  if (typeof userId !== "string" || userId.length < 1 || userId.length > 128 || userId.trim() !== userId || /[\u0000-\u001f\u007f]/.test(userId)) {
    return fail("A single exact existing user ID is required.");
  }
  return userId;
}

function maskEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return "[invalid email record]";
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function requireProvisioningCapabilities(client: PrismaClientLike): void {
  if (typeof client.user?.findUnique !== "function" || typeof client.user?.count !== "function") fail("Required user inspection capability is unavailable.");
  if (typeof client.$transaction !== "function") fail("Database transaction capability is unavailable.");
  if (typeof client.$queryRaw !== "function") fail("Transaction-scoped advisory locks are unavailable.");
  if (typeof client.user?.updateMany !== "function" || typeof client.session?.updateMany !== "function") fail("Conditional role or session update capability is unavailable.");
  if (typeof client.auditLog?.create !== "function") fail("Audit logging capability is unavailable.");
}

export async function inspectAdminProvisioningTarget(client: PrismaClientLike, inputUserId: string): Promise<ProvisioningInspection> {
  requireProvisioningCapabilities(client);
  const userId = requireId(inputUserId);
  await verifyRequiredUserSelectAccess(client);
  const userReader = client.user as unknown as {
    findUnique(args: { where: { id: string }; select: { id: true; email: true; emailVerified: true; role: true } }): Promise<Row | null>;
  };
  const [row, existingAdminCount, passwordLoginCount] = await Promise.all([
    userReader.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerified: true, role: true } }),
    client.user.count({ where: { role: "admin" } }),
    client.user.count({ where: { id: userId, passwordHash: { not: "" } } }),
  ]);
  const record: Row | null = row;
  const found = record !== null;
  const currentRole = found && typeof record["role"] === "string" ? record["role"] : null;
  const emailVerified = found && record["emailVerified"] instanceof Date && Number.isFinite(record["emailVerified"].getTime());
  const passwordLoginEligible = found && passwordLoginCount === 1;
  const blockers: string[] = [];
  if (!found) blockers.push("target_user_not_found");
  if (currentRole !== "user") blockers.push("target_role_is_not_user");
  if (!emailVerified) blockers.push("email_not_verified");
  if (!passwordLoginEligible) blockers.push("password_login_not_available");
  if (existingAdminCount !== 0) blockers.push("an_admin_account_already_exists");
  return {
    userId,
    found,
    maskedEmail: found ? maskEmail(record["email"]) : null,
    currentRole,
    emailVerified,
    passwordLoginEligible,
    existingAdminCount,
    eligible: blockers.length === 0,
    blockers,
  };
}

async function verifyRequiredUserSelectAccess(client: PrismaClientLike): Promise<void> {
  const result = await client.$queryRaw`
    SELECT
      current_user::text AS "connectedRole",
      (current_user = session_user AND EXISTS (
        SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
      )) AS "roleVerified",
      NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'User'
          AND (c.relrowsecurity OR c.relforcerowsecurity)
      ) AS "noUserRowSecurity",
      (
        SELECT count(a.attnum) = 5 AND COALESCE(bool_and(
          a.attnum IS NOT NULL AND has_column_privilege(current_user, c.oid, a.attnum, 'SELECT')
        ), false)
        FROM (VALUES
          ('id'::name), ('email'::name), ('emailVerified'::name), ('role'::name), ('passwordHash'::name)
        ) AS required(column_name)
        LEFT JOIN pg_namespace n ON n.nspname = 'public'
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = 'User' AND c.relkind IN ('r', 'p')
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = required.column_name
          AND a.attnum > 0 AND NOT a.attisdropped
      ) AS "hasRequiredUserSelect"`;
  const row = requireSingleRow(result, "Required user read access could not be verified.");
  if (typeof row["connectedRole"] !== "string" || row["connectedRole"].length === 0 ||
      row["roleVerified"] !== true || row["noUserRowSecurity"] !== true || row["hasRequiredUserSelect"] !== true) {
    fail("Required user read access could not be verified.");
  }
}

/**
 * Promotes the already-confirmed target and records its audit entry atomically.
 * The caller must get the interactive confirmation after displaying a dry-run result.
 */
async function provisionAdminAccount(client: PrismaClientLike, input: ProvisionAdminInput): Promise<ProvisionAdminResult> {
  requireProvisioningCapabilities(client);
  const userId = requireId(input.userId);
  if (input.confirmation !== `PROMOTE ${userId}`) fail("Explicit target confirmation did not match; no change was made.");
  if (!APPROVAL_REFERENCE.test(input.approvalReference)) fail("A valid non-secret approval reference is required.");
  const initialInspection = await inspectAdminProvisioningTarget(client, userId);
  if (!initialInspection.eligible) fail("The target failed a provisioning precondition; no change was made.");

  const now = input.now ?? new Date();
  return client.$transaction(async (tx) => {
    // A transaction-scoped advisory lock serializes every invocation of this one-time tool.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PROVISIONING_LOCK_KEY})`;
    const inspection = await inspectAdminProvisioningTarget(tx, userId);
    if (!inspection.eligible) fail("The target failed a transaction-time provisioning precondition; no change was made.");

    const updated = await tx.user.updateMany({
      where: { id: userId, role: "user", emailVerified: { not: null }, passwordHash: { not: null } },
      data: { role: "admin" },
    });
    if (updated.count !== 1) fail("The target changed concurrently; no change was made.");

    const revoked = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "admin.role_provisioned",
        entityType: "User",
        entityId: userId,
        metadata: {
          source: "one-time-admin-provisioning-cli",
          approvalReference: input.approvalReference,
          previousRole: "user",
          newRole: "admin",
          revokedSessions: revoked.count,
        },
      },
    });
    return { userId, revokedSessions: revoked.count, auditRecorded: true };
  });
}

function canonicalExpectedTarget(value: string): string {
  return canonicalTarget(value);
}

export function assertDatabaseIdentity(identity: DatabaseIdentity, expectedTarget: string): void {
  const expected = canonicalExpectedTarget(expectedTarget).split("/");
  const databasePart = expected[1];
  const authority = expected[0];
  const separator = authority?.lastIndexOf(":") ?? -1;
  const expectedHost = authority?.slice(0, separator);
  const expectedPort = Number(authority?.slice(separator + 1));
  if (!databasePart || !expectedHost || !Number.isInteger(expectedPort) ||
      identity.databaseName !== databasePart || identity.host.toLowerCase() !== expectedHost || identity.port !== expectedPort) {
    fail("Connected database identity does not match the explicitly expected target.");
  }
}

export function assertReadOnlyPrivileges(report: ReadOnlyPrivilegeReport): void {
  if (!report.safeRoleAttributes || !report.noDatabaseCreate || !report.noSchemaCreate ||
      !report.noDatabaseTemporary || !report.noObjectWrites || !report.noColumnWrites ||
      !report.noSequenceWrites || !report.noLargeObjectWrites || !report.noOwnedObjects || !report.noRoleMemberships ||
      !report.noExecutableSecurityDefinerFunctions || !report.noUserRowSecurity) {
    fail("Connected PostgreSQL role could not be verified as read-only.");
  }
}

async function verifyConnectedDatabaseIdentity(client: PrismaClientLike, expectedTarget: string): Promise<void> {
  const result = await client.$queryRaw`SELECT current_database() AS "databaseName", inet_server_addr()::text AS "host", inet_server_port() AS "port"`;
  const row = requireSingleRow(result, "Connected database identity could not be verified.");
  const databaseName = row["databaseName"];
  const host = row["host"];
  const port = row["port"];
  if (typeof databaseName !== "string" || typeof host !== "string" || typeof port !== "number") fail("Connected database identity could not be verified.");
  assertDatabaseIdentity({ databaseName, host, port }, expectedTarget);
}

async function verifyConnectedRoleIsReadOnly(client: PrismaClientLike): Promise<void> {
  // This is an effective-privilege guard: it checks table/column/sequence/large-object writes,
  // database and schema CREATE/TEMP, memberships, ownership dependencies, executable
  // SECURITY DEFINER routines, and User-table RLS. It does not prove extension or host-level
  // side effects are impossible, nor prevent an administrator changing grants after this check.
  // Any missing catalog access, unexpected result shape, or failed predicate stops dry-run.
  const result = await client.$queryRaw`
    SELECT
      (NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls) AS "safeRoleAttributes",
      NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS "noRoleMemberships",
      NOT has_database_privilege(current_user, current_database(), 'CREATE') AS "noDatabaseCreate",
      -- has_database_privilege checks effective access, including a grant to PUBLIC.
      NOT has_database_privilege(current_user, current_database(), 'TEMP') AS "noDatabaseTemporary",
      NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND has_schema_privilege(current_user, n.oid, 'CREATE')
      ) AS "noSchemaCreate",
      NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'User'
          AND (c.relrowsecurity OR c.relforcerowsecurity)
      ) AS "noUserRowSecurity",
      NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_table_privilege(current_user, c.oid, 'INSERT') OR
               has_table_privilege(current_user, c.oid, 'UPDATE') OR
               has_table_privilege(current_user, c.oid, 'DELETE') OR
               has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
               has_table_privilege(current_user, c.oid, 'REFERENCES') OR
               has_table_privilege(current_user, c.oid, 'TRIGGER'))
      ) AS "noObjectWrites",
      NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege)
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_column_privilege(current_user, c.oid, a.attnum, p.privilege)
      ) AS "noColumnWrites",
      NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND c.relkind = 'S'
          AND (has_sequence_privilege(current_user, c.oid, 'USAGE') OR
               has_sequence_privilege(current_user, c.oid, 'UPDATE'))
      ) AS "noSequenceWrites",
      NOT EXISTS (
        SELECT 1 FROM pg_shdepend d
        WHERE d.refclassid = 'pg_authid'::regclass
          AND d.refobjid = r.oid
          AND d.deptype = 'o'
          AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
      ) AS "noOwnedObjects",
      NOT EXISTS (
        SELECT 1 FROM pg_largeobject_metadata l
        CROSS JOIN LATERAL aclexplode(COALESCE(l.lomacl, '{}'::aclitem[])) acl
        WHERE acl.grantee IN (r.oid, 0) AND acl.privilege_type = 'UPDATE'
      ) AS "noLargeObjectWrites",
      NOT EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.prosecdef
          AND has_function_privilege(current_user, p.oid, 'EXECUTE')
      ) AS "noExecutableSecurityDefinerFunctions"
    FROM pg_roles r WHERE r.rolname = current_user`;
  const row = requireSingleRow(result, "Connected PostgreSQL role could not be verified as read-only.");
  const keys: Array<keyof ReadOnlyPrivilegeReport> = ["safeRoleAttributes", "noRoleMemberships", "noDatabaseCreate", "noDatabaseTemporary", "noSchemaCreate", "noUserRowSecurity", "noObjectWrites", "noColumnWrites", "noSequenceWrites", "noLargeObjectWrites", "noOwnedObjects", "noExecutableSecurityDefinerFunctions"];
  if (keys.some((key) => typeof row[key] !== "boolean")) fail("Connected PostgreSQL role could not be verified as read-only.");
  assertReadOnlyPrivileges(row as unknown as ReadOnlyPrivilegeReport);
}

function canonicalTarget(value: string, options: { allowCredentials?: boolean; allowQuery?: boolean } = {}): string {
  try {
    const url = new URL(value.includes("://") ? value : `postgresql://${value}`);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || (!options.allowCredentials && (url.username || url.password)) || (!options.allowQuery && url.search) || url.hash) fail("Expected target must contain only host, port, and database name.");
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database || database.includes("/")) fail("Expected database target is incomplete.");
    return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
  } catch {
    return fail("Expected database target is invalid.");
  }
}

function assertCredentialTarget(connectionString: string): void {
  const url = (() => {
    try { return new URL(connectionString.includes("://") ? connectionString : `postgresql://${connectionString}`); }
    catch { return fail("Configured database target is invalid."); }
  })();
  const targetOverrideKeys = new Set([
    "host", "hostaddr", "port", "database", "dbname", "user", "service", "servicefile",
    "passfile", "schema", "options", "target_session_attrs", "replication",
  ]);
  for (const key of url.searchParams.keys()) {
    if (targetOverrideKeys.has(key.toLowerCase())) fail("Configured database URL contains a target or session override; no connection was made.");
  }
  if (canonicalTarget(connectionString, { allowCredentials: true, allowQuery: true }) !== REQUIRED_LOCAL_TEST_TARGET) {
    fail("Configured database target does not match the isolated local test database; no connection was made.");
  }
}

function parseArguments(args: string[]): { mode: ProvisioningMode; userId: string; expectedTarget: string; approvalReference?: string } {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (typeof key !== "string" || typeof value !== "string" || !key.startsWith("--") || !value || options.has(key)) fail("Invalid command options; no change was made.");
    options.set(key, value);
  }
  const mode = options.get("--mode");
  const userId = options.get("--user-id");
  const expectedTarget = options.get("--expected-target");
  const approvalReference = options.get("--approval-reference");
  if ((mode !== "dry-run" && mode !== "promote") || typeof userId !== "string" || !userId || typeof expectedTarget !== "string" || !expectedTarget) fail("Usage requires --mode dry-run|promote, --user-id, and --expected-target.");
  if ([...options.keys()].some((key) => !["--mode", "--user-id", "--expected-target", "--approval-reference"].includes(key))) fail("Unsupported command option; no change was made.");
  if (mode === "promote" && !approvalReference) fail("Promotion requires --approval-reference.");
  if (mode === "dry-run" && approvalReference) fail("Dry-run does not accept an approval reference.");
  const canonicalExpected = canonicalTarget(expectedTarget);
  if (canonicalExpected !== REQUIRED_LOCAL_TEST_TARGET) fail("Only the explicitly approved isolated local test database is permitted.");
  return { mode, userId: requireId(userId), expectedTarget: canonicalExpected, ...(approvalReference ? { approvalReference } : {}) };
}

async function confirmPromotion(userId: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) fail("Interactive terminal confirmation is required; no change was made.");
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(`Type PROMOTE ${userId} to confirm this exact account: `);
    return answer;
  } finally {
    terminal.close();
  }
}

export interface ProvisioningCliDependencies {
  environment: Record<string, string | undefined>;
  createClient: (connectionString: string) => Promise<PrismaClientLike>;
  confirmExactId: (userId: string) => Promise<string>;
  write: (message: string) => void;
}

/** Dependency-injected CLI boundary for offline tests; all execution guards remain inside this flow. */
export async function runProvisioningCli(args: string[], dependencies: ProvisioningCliDependencies): Promise<void> {
  const options = parseArguments(args);
  const credentialName = options.mode === "dry-run" ? "CLIPFORGE_ADMIN_PROVISION_READONLY_DATABASE_URL" : "CLIPFORGE_ADMIN_PROVISION_DATABASE_URL";
  const connectionString = dependencies.environment[credentialName];
  if (typeof connectionString !== "string" || !connectionString) fail(`Required protected credential source ${credentialName} is unavailable.`);
  assertCredentialTarget(connectionString);
  if (canonicalTarget(connectionString, { allowCredentials: true, allowQuery: true }) !== options.expectedTarget) fail("Configured database target does not match --expected-target; no change was made.");

  const client = await dependencies.createClient(connectionString);
  try {
    await verifyConnectedDatabaseIdentity(client, options.expectedTarget);
    if (options.mode === "dry-run") await verifyConnectedRoleIsReadOnly(client);
    const inspection = await inspectAdminProvisioningTarget(client, options.userId);
    dependencies.write(`Target user ID: ${inspection.userId}\n`);
    dependencies.write(`Account: ${inspection.maskedEmail ?? "not found"}\n`);
    dependencies.write(`Current role: ${inspection.currentRole ?? "not found"}\n`);
    dependencies.write(`Verified email: ${inspection.emailVerified ? "yes" : "no"}\n`);
    dependencies.write(`Password sign-in eligible: ${inspection.passwordLoginEligible ? "yes" : "no"}\n`);
    dependencies.write(`Existing admins: ${inspection.existingAdminCount}\n`);
    dependencies.write(`Preflight: ${inspection.eligible ? "eligible" : "blocked"}${inspection.blockers.length ? ` (${inspection.blockers.join(", ")})` : ""}\n`);
    if (options.mode === "dry-run") {
      dependencies.write("Dry-run only. No records were changed.\n");
      return;
    }
    if (!inspection.eligible) fail("Preflight blocked promotion; no change was made.");
    if ((await dependencies.confirmExactId(options.userId)) !== `PROMOTE ${options.userId}`) fail("Confirmation did not match; no change was made.");
    // This is an operator-supplied audit reference, not evidence of external approval.
    const result = await provisionAdminAccount(client, {
      userId: options.userId,
      confirmation: `PROMOTE ${options.userId}`,
      approvalReference: options.approvalReference!,
    });
    dependencies.write(`Provisioning complete for user ID ${result.userId}. Revoked sessions: ${result.revokedSessions}. Audit entry recorded.\n`);
  } finally {
    const disconnectable = client as PrismaClientLike & { $disconnect?: () => Promise<void> };
    await disconnectable.$disconnect?.();
  }
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  await runProvisioningCli(args, {
    environment: process.env,
    createClient: createPrismaClient,
    confirmExactId: async (userId) => await confirmPromotion(userId),
    write: (message) => stdout.write(message),
  });
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  void main().catch(() => {
    // Do not print Prisma exceptions: they can include connection or query details.
    process.stderr.write("Provisioning stopped safely. Check the target, account preconditions, and protected access setup.\n");
    process.exitCode = 1;
  });
}
