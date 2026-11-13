/**
 * Explicit, one-time CLI provisioning for a brand-new first Admin account.
 * This script never loads dotenv files itself; choose the config file on the Node command line.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { stdin, stdout } from "node:process";
import type { PrismaClientLike } from "../src/server/prisma/prisma-client-like.ts";
import { checkPasswordPolicy, DEFAULT_SCRYPT_PARAMS, hashPassword } from "../src/server/auth/password.ts";
import { createPrismaClient } from "../src/server/prisma/create-client.ts";

const PROVISIONING_LOCK_KEY = 0x434c6970466f7267n;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}$/;

export interface AdminSeedTarget {
  hostname: string;
  port: number;
  database: string;
  schema: string;
  canonical: string;
  remote: boolean;
}

type SeedDependencies = {
  environment: Record<string, string | undefined>;
  createClient: (connectionString: string) => Promise<PrismaClientLike>;
  promptCredentials: () => Promise<{ email: string; password: string }>;
  confirm: (phrase: string) => Promise<string>;
  hashPassword: typeof hashPassword;
  now: () => Date;
  newId: () => string;
  write: (message: string) => void;
};

const defaults: SeedDependencies = {
  environment: process.env,
  createClient: createPrismaClient,
  promptCredentials: promptCredentialsInteractively,
  confirm: confirmPhrase,
  hashPassword,
  now: () => new Date(),
  newId: () => randomUUID(),
  write: (message) => stdout.write(message),
};

function fail(message: string): never { throw new Error(message); }

export function parseAdminSeedTarget(connectionString: string): AdminSeedTarget {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { return fail("DIRECT_URL is not a valid PostgreSQL URL."); }
  if (!(["postgres:", "postgresql:"].includes(url.protocol)) || !url.hostname) fail("DIRECT_URL must identify a PostgreSQL host.");

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) fail("DIRECT_URL must identify exactly one database.");
  const targetOverrideKeys = new Set(["host", "hostaddr", "port", "database", "dbname", "user", "service", "servicefile", "passfile", "options", "target_session_attrs", "replication"]);
  for (const key of url.searchParams.keys()) {
    if (targetOverrideKeys.has(key.toLowerCase())) fail("DIRECT_URL contains an unsupported target override.");
  }
  const schema = url.searchParams.get("schema") ?? "public";
  if (schema !== "public") fail("Admin seed is restricted to the application's public schema.");
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("DIRECT_URL contains an invalid port.");
  const hostname = url.hostname.toLowerCase();
  const remote = !["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  return { hostname, port, database, schema, canonical: `${hostname}:${port}/${database}`, remote };
}

function validateCredentials(rawEmail: string, password: string): { email: string; password: string } {
  const email = rawEmail.trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) fail("The entered Admin email is invalid.");
  const problems = checkPasswordPolicy(password, email);
  if (problems.length) fail("The entered password does not meet ClipForge's password policy.");
  return { email, password };
}

function assertTargetApproval(env: Record<string, string | undefined>, target: AdminSeedTarget): void {
  const expected = env["ADMIN_SEED_EXPECTED_TARGET"];
  if (!expected || expected !== target.canonical) fail("ADMIN_SEED_EXPECTED_TARGET must exactly match the displayed host:port/database target.");
  if (target.remote && env["ADMIN_SEED_ALLOW_REMOTE"] !== "true") fail("Remote database use requires ADMIN_SEED_ALLOW_REMOTE=true.");
}

async function verifyConnectedIdentity(client: PrismaClientLike, target: AdminSeedTarget): Promise<void> {
  const result = await client.$queryRaw`SELECT current_database() AS "databaseName", current_schema() AS "schemaName"`;
  if (!Array.isArray(result) || result.length !== 1) fail("Connected database identity could not be verified.");
  const row = result[0] as Record<string, unknown>;
  if (row["databaseName"] !== target.database || row["schemaName"] !== target.schema) fail("Connected database identity does not match the approved target.");
}

async function createFirstAdmin(client: PrismaClientLike, input: { id: string; email: string; passwordHash: string; now: Date }): Promise<void> {
  await client.$transaction(async (tx) => {
    // Fail fast instead of waiting inside Prisma's short interactive-transaction timeout.
    // The same lock key is used by the legacy operator provisioning utility.
    const lockResult = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${PROVISIONING_LOCK_KEY}) AS "locked"`;
    if (!Array.isArray(lockResult) || lockResult.length !== 1 || (lockResult[0] as Record<string, unknown>)?.["locked"] !== true) {
      fail("Another Admin provisioning operation is in progress; retry after it finishes.");
    }
    if (await tx.user.count({ where: { role: "admin" } }) !== 0) fail("An Admin already exists; refusing to create or promote an account.");
    if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) fail("An account with this email already exists; existing users are never promoted by this script.");

    const user = await tx.user.create({
      data: {
        id: input.id,
        email: input.email,
        emailVerified: input.now,
        passwordHash: input.passwordHash,
        name: null,
        role: "admin",
        createdAt: input.now,
      },
    });
    const userId = typeof user["id"] === "string" ? user["id"] : input.id;
    const revoked = await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: input.now } });
    await tx.auditLog.create({
      data: {
        actorId: null,
        action: "admin.first_account_seeded",
        entityType: "User",
        entityId: userId,
        metadata: { source: "one-time-admin-seed-cli", verificationMethod: "explicit-operator-provisioning", revokedSessions: revoked.count },
        createdAt: input.now,
      },
    });
  });
}

export async function runFirstAdminSeed(args: string[], overrides: Partial<SeedDependencies> = {}): Promise<void> {
  const deps = { ...defaults, ...overrides };
  if (args.length === 1 && args[0] === "--inspect-target") {
    const connectionString = deps.environment["DIRECT_URL"];
    if (!connectionString) fail("DIRECT_URL is unavailable.");
    const target = parseAdminSeedTarget(connectionString);
    deps.write(`Candidate host: ${target.hostname}\nCandidate port: ${target.port}\nCandidate database: ${target.database}\nNo database connection was made.\n`);
    return;
  }
  if (args.length !== 0) fail("Use no arguments to provision, or --inspect-target for a no-connection target preview.");

  const connectionString = deps.environment["DIRECT_URL"];
  if (!connectionString) fail("DIRECT_URL is unavailable.");
  const target = parseAdminSeedTarget(connectionString);
  assertTargetApproval(deps.environment, target);

  deps.write(`Approved candidate host: ${target.hostname}\nDatabase: ${target.database}\nPort: ${target.port}\nSchema: ${target.schema}\nRemote target: ${target.remote ? "yes" : "no"}\n`);
  const client = await deps.createClient(connectionString);
  try {
    await verifyConnectedIdentity(client, target);
    deps.write(`Connected identity verified: database ${target.database}, schema ${target.schema}.\n`);
    const entered = await deps.promptCredentials();
    const { email, password } = validateCredentials(entered.email, entered.password);
    const phrase = `CREATE FIRST ADMIN ${email} ON ${target.canonical}`;
    if (!stdin.isTTY && deps.confirm === defaults.confirm) fail("Interactive confirmation is required; no account was created.");
    if (await deps.confirm(phrase) !== phrase) fail("Confirmation phrase did not match; no account was created.");
    const passwordHash = await deps.hashPassword(password, DEFAULT_SCRYPT_PARAMS);
    await createFirstAdmin(client, { id: deps.newId(), email, passwordHash, now: deps.now() });
    deps.write("First Admin account created and audit entry recorded. No session was created.\n");
  } finally {
    await client.$disconnect?.();
  }
}

async function confirmPhrase(phrase: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) fail("Interactive terminal confirmation is required; no account was created.");
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return await terminal.question(`Type exactly: ${phrase}\n> `); }
  finally { terminal.close(); }
}

async function promptCredentialsInteractively(): Promise<{ email: string; password: string }> {
  if (!stdin.isTTY || !stdout.isTTY) fail("An interactive terminal is required to enter Admin credentials.");
  const terminal = createInterface({ input: stdin, output: stdout });
  let email: string;
  try { email = await terminal.question("Admin email address: "); }
  finally { terminal.close(); }
  const password = await promptHiddenPassword();
  return { email, password };
}

function promptHiddenPassword(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.reject(new Error("A TTY is required for hidden password entry."));
  }
  return new Promise((resolve, reject) => {
    const wasRaw = stdin.isRaw;
    const decoder = new StringDecoder("utf8");
    let password = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdout.write("\n");
      if (error) reject(error); else resolve(password);
    };
    const onData = (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003" || character === "\u0004") { finish(new Error("Password entry cancelled.")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0008" || character === "\u007f") {
          const chars = Array.from(password);
          if (chars.length) { chars.pop(); password = chars.join(""); stdout.write("\b \b"); }
          continue;
        }
        if (!/[\u0000-\u001f\u007f]/.test(character) && password.length < 512) {
          password += character;
          stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("Admin password (input hidden): ");
  });
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  void runFirstAdminSeed(process.argv.slice(2)).catch(() => {
    // Never print Prisma errors, URLs, emails, or any credential-bearing details.
    process.stderr.write("Admin seed stopped safely. Review the displayed target, configured environment, and account preconditions.\n");
    process.exitCode = 1;
  });
}
