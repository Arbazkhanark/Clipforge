import type { Environment } from "./environment.ts";
import { parseSafeDatabaseTarget } from "./workers/database-identity-guard.ts";

export class MigrationTargetIdentityError extends Error {
  constructor() {
    super("Migration target identity is missing or does not match the configured expectation.");
    this.name = "MigrationTargetIdentityError";
  }
}

function matchesTarget(databaseUrl: string | undefined, expectedHost: string | undefined, expectedName: string | undefined, expectedPort: string | undefined): boolean {
  const hostPin = expectedHost?.trim().toLowerCase() ?? "";
  const namePin = expectedName?.trim() ?? "";
  const portPin = expectedPort?.trim() ?? "";
  if (!databaseUrl?.trim() || !hostPin || !namePin || /[\/?#\u0000-\u001f]/.test(namePin) || !/^[1-9][0-9]{0,4}$/.test(portPin)) return false;
  try {
    const target = parseSafeDatabaseTarget(databaseUrl);
    const port = Number(portPin);
    return port >= 1 && port <= 65535 && target.host === hostPin && target.database === namePin && target.port === port;
  } catch {
    return false;
  }
}

const LOCAL_TEST_TARGET = { host: "127.0.0.1", port: 54836, database: "clipforge_local_test" } as const;
const LOCAL_TEST_ROLE = "clipforge_test_admin";
const CI_MIGRATOR_ROLE = "clipforge_ci_migrator";
// String-valued options present in the installed Prisma CLI metadata. Boolean
// options are intentionally excluded so they cannot consume a command token.
const PRISMA_VALUE_OPTIONS = new Set([
  "--api-key", "--applied", "--browser", "--composite-type-depth", "--config", "--database",
  "--datasource-provider", "--file", "--from-migrations", "--from-schema", "--from-schema-datamodel",
  "--from-schema-datasource", "--from-url", "--generator", "--generator-provider", "--name", "--output",
  "--port", "--prompt", "--region", "--rolled-back", "--schema", "--schemas", "--telemetry-information",
  "--template", "--to-migrations", "--to-schema", "--to-schema-datamodel", "--to-schema-datasource",
  "--to-url", "--url", "--vibe", "-b", "-n", "-o", "-p",
]);
const PRISMA_COMMANDS = new Set([
  "bootstrap", "complete", "db", "debug", "dev", "format", "generate", "init", "mcp", "migrate",
  "platform", "postgres", "studio", "telemetry", "validate", "version",
]);
const PRISMA_MIGRATION_SUBCOMMANDS = new Set(["deploy", "dev", "diff", "reset", "resolve", "status"]);

function assertLocalCiMigrationTargets(databaseUrl: string | undefined, directUrl: string | undefined): string {
  try {
    const runtimeTarget = parseSafeDatabaseTarget(databaseUrl);
    const migrationTarget = parseSafeDatabaseTarget(directUrl);
    const matchesFixedTarget = (target: ReturnType<typeof parseSafeDatabaseTarget>, role: string) =>
      target.host === LOCAL_TEST_TARGET.host && target.port === LOCAL_TEST_TARGET.port &&
      target.database === LOCAL_TEST_TARGET.database && target.username === role;

    if (!databaseUrl || !directUrl || !matchesFixedTarget(runtimeTarget, LOCAL_TEST_ROLE) ||
        !matchesFixedTarget(migrationTarget, CI_MIGRATOR_ROLE)) {
      throw new MigrationTargetIdentityError();
    }
  } catch {
    throw new MigrationTargetIdentityError();
  }
  return directUrl;
}

/** Test-mode migrations are only allowed against the isolated PostgreSQL 15 target. */
function assertLocalTestTarget(databaseUrl: string | undefined): string {
  try {
    const target = parseSafeDatabaseTarget(databaseUrl);
    if (target.host !== LOCAL_TEST_TARGET.host || target.port !== LOCAL_TEST_TARGET.port || target.database !== LOCAL_TEST_TARGET.database ||
        target.username !== LOCAL_TEST_ROLE || !databaseUrl) {
      throw new MigrationTargetIdentityError();
    }
  } catch {
    throw new MigrationTargetIdentityError();
  }
  return databaseUrl;
}

/**
 * Prisma migration preflight. This is a pure URL identity check: it never opens a
 * database connection and its errors intentionally contain no URL-derived data.
 */
export function assertMigrationTargetIdentity(
  env: Environment = process.env,
  cliArgs: readonly string[] = process.argv.slice(2),
): string {
  const migrationCommand = isPrismaMigrationCommand(cliArgs);
  const ciFlag = env["CI"];
  const ciMigrationFlag = env["CLIPFORGE_CI_MIGRATION"];
  const ciMigrationRequested = ciFlag !== undefined || ciMigrationFlag !== undefined;

  // A CI environment must opt in explicitly for migration commands. Once either
  // CI marker is present, malformed or partial opt-in cannot fall through to the
  // ordinary test-role migration path.
  if (migrationCommand && ciMigrationRequested) {
    if (ciFlag !== "true" || ciMigrationFlag !== "true" ||
        env["NODE_ENV"] !== "test" || env["CLIPFORGE_DEPLOYMENT_ENV"] !== "test" ||
        cliArgs.length !== 2 || cliArgs[0] !== "migrate" || cliArgs[1] !== "deploy") {
      throw new MigrationTargetIdentityError();
    }
    return assertLocalCiMigrationTargets(env["DATABASE_URL"], env["DIRECT_URL"]);
  }

  const rawDeployment = env["CLIPFORGE_DEPLOYMENT_ENV"];
  const deployment = rawDeployment?.trim().toLowerCase();
  const protectedDeployment = deployment === "staging" || deployment === "production";
  const productionRuntime = env["NODE_ENV"] === "production";

  if (rawDeployment !== undefined && !["development", "preview", "test", "staging", "production"].includes(deployment ?? "")) {
    throw new MigrationTargetIdentityError();
  }
  const testMode = deployment === "test" || env["NODE_ENV"] === "test";
  if (testMode) {
    if (deployment !== "test" || env["NODE_ENV"] !== "test") throw new MigrationTargetIdentityError();
    assertLocalTestTarget(env["DATABASE_URL"]);
    return assertLocalTestTarget(env["DIRECT_URL"]);
  }
  if (rawDeployment === "development" && env["NODE_ENV"] === "development") {
    const expectedName = env["CLIPFORGE_EXPECTED_DATABASE_NAME"];
    const pooledMatches = matchesTarget(
      env["DATABASE_URL"],
      env["CLIPFORGE_EXPECTED_DATABASE_HOST"],
      expectedName,
      env["CLIPFORGE_EXPECTED_DATABASE_PORT"],
    );
    const directMatches = matchesTarget(
      env["DIRECT_URL"],
      env["CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST"],
      expectedName,
      env["CLIPFORGE_EXPECTED_DATABASE_PORT"],
    );
    if (!pooledMatches || !directMatches) throw new MigrationTargetIdentityError();
    return env["DIRECT_URL"]!;
  }
  if (!protectedDeployment || !productionRuntime) throw new MigrationTargetIdentityError();

  const expectedName = env["CLIPFORGE_EXPECTED_DATABASE_NAME"];
  const pooledMatches = matchesTarget(
    env["DATABASE_URL"],
    env["CLIPFORGE_EXPECTED_DATABASE_HOST"],
    expectedName,
    env["CLIPFORGE_EXPECTED_DATABASE_PORT"],
  );
  const directMatches = matchesTarget(
    env["DIRECT_URL"],
    env["CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST"],
    expectedName,
    env["CLIPFORGE_EXPECTED_DATABASE_PORT"],
  );
  if (!pooledMatches || !directMatches) throw new MigrationTargetIdentityError();
  return env["DIRECT_URL"]!;
}

/** Detect Prisma CLI migration commands without matching the config file path. */
export function isPrismaMigrationCommand(args: readonly string[]): boolean {
  // Mirror Prisma's option stripping while locating the command. In particular,
  // a command-like value following a missing --config/--schema value is treated
  // conservatively as migration intent when followed by a migration subcommand.
  let index = 0;
  while (index < args.length) {
    const argument = args[index]!;
    if (PRISMA_VALUE_OPTIONS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        index += 1;
        continue;
      }
      if (value === "migrate" && PRISMA_MIGRATION_SUBCOMMANDS.has(args[index + 2] ?? "")) return true;
      index += 2;
      continue;
    }
    if (argument.startsWith("--") && argument.includes("=")) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      index += 1;
      continue;
    }
    if (PRISMA_COMMANDS.has(argument)) return argument === "migrate";
    // Plain tokens can be values of unsupported options. Continue until a
    // known command appears; CI's exact-argv allowlist rejects the extra tokens.
    index += 1;
  }
  return false;
}
