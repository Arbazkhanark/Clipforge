import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertMigrationTargetIdentity, isPrismaMigrationCommand, MigrationTargetIdentityError } from "../src/server/migration-target-guard.ts";

const prismaConfig = await readFile(new URL("../prisma.config.ts", import.meta.url), "utf8");

function resolvePrismaConfigInChild(
  cliArgs: string[],
  env: NodeJS.ProcessEnv,
  expectedMarker: "DATASOURCE_MATCH" | "GUARD_REJECTED",
): void {
  const childSource = `
    process.argv = [process.execPath, "prisma", ...${JSON.stringify(cliArgs)}];
    try {
      const guard = await import(${JSON.stringify(new URL("../src/server/migration-target-guard.ts", import.meta.url).href)});
      try {
        const loaded = await import(${JSON.stringify(new URL("../prisma.config.ts", import.meta.url).href)});
        const resolvedUrl = loaded.default?.datasource?.url;
        process.stdout.write(resolvedUrl === process.env["DIRECT_URL"] ? "DATASOURCE_MATCH" : "DATASOURCE_MISMATCH");
      } catch (error) {
        if (error instanceof guard.MigrationTargetIdentityError) process.stdout.write("GUARD_REJECTED");
        else process.exitCode = 71;
      }
    } catch { process.exitCode = 72; }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16_384,
  });

  assert.ok(result.error === undefined, "Prisma config child failed to start or timed out");
  assert.equal(result.signal, null, "Prisma config child was unexpectedly signalled");
  assert.equal(result.status, 0, "Prisma config child exited unexpectedly");
  assert.ok(result.stderr.length === 0, "Prisma config child emitted unexpected diagnostics");
  assert.ok(result.stdout === expectedMarker, "Prisma config child did not return the expected fixed marker");
}

const deployed = {
  NODE_ENV: "production",
  CLIPFORGE_DEPLOYMENT_ENV: "staging",
  DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.stage.example:5432/clipforge_stage?sslmode=require",
  DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?sslmode=require",
  CLIPFORGE_EXPECTED_DATABASE_HOST: "pool.stage.example",
  CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "direct.stage.example",
  CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_stage",
  CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
};

test("migration preflight validates pooled and direct database identities independently", () => {
  assert.doesNotThrow(() => assertMigrationTargetIdentity(deployed));
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_EXPECTED_DATABASE_HOST: undefined }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: undefined }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_EXPECTED_DATABASE_NAME: undefined }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_EXPECTED_DATABASE_PORT: undefined }), MigrationTargetIdentityError);
});

test("migration preflight rejects mismatched and malformed pooled/direct URLs without exposing credentials", () => {
  for (const env of [
    { ...deployed, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@wrong.stage.example:5432/clipforge_stage" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@wrong.stage.example:5432/clipforge_stage" },
    { ...deployed, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.stage.example:5432/other" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage%2Fother" },
    { ...deployed, DIRECT_URL: "not-a-database-url" },
    { ...deployed, CLIPFORGE_EXPECTED_DATABASE_PORT: "6432" },
    { ...deployed, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.stage.example:5432/clipforge_stage?port=6432" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?host=redirect.example" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?hostaddr=192.0.2.1" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?service=other" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?sslmode=require&sslmode=disable" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?%68ost=redirect.example" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?sslmode=%ZZ" },
    { ...deployed, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.stage.example:5432/clipforge_stage?unexpected=value" },
    { ...deployed, CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "https://direct.stage.example/path" },
  ]) {
    assert.throws(() => assertMigrationTargetIdentity(env), (error: unknown) => {
      assert.ok(error instanceof MigrationTargetIdentityError);
      assert.doesNotMatch(error.message, /synthetic-user|synthetic-password|stage\.example|postgresql/);
      return true;
    });
  }
});

test("migration preflight fails closed on production mode without explicit staging/production identity", () => {
  assert.throws(() => assertMigrationTargetIdentity({ NODE_ENV: "production" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_DEPLOYMENT_ENV: "preview" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, NODE_ENV: "development" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...deployed, CLIPFORGE_DEPLOYMENT_ENV: "unknown" }), MigrationTargetIdentityError);
});

const development = {
  NODE_ENV: "development",
  CLIPFORGE_DEPLOYMENT_ENV: "development",
  DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.dev.example:5432/clipforge_dev?sslmode=require",
  DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.dev.example:5432/clipforge_dev?sslmode=require",
  CLIPFORGE_EXPECTED_DATABASE_HOST: "pool.dev.example",
  CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "direct.dev.example",
  CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_dev",
  CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
};

test("local development migrations require explicit independent target pins", () => {
  assert.equal(assertMigrationTargetIdentity(development), development.DIRECT_URL);
  for (const env of [
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: undefined },
    { ...development, NODE_ENV: undefined },
    { ...development, NODE_ENV: "Development" },
    { ...development, NODE_ENV: "DEVELOPMENT" },
    { ...development, NODE_ENV: " development " },
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: "Development" },
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: "DEVELOPMENT" },
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: " development " },
    { ...development, NODE_ENV: "production" },
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: "staging" },
    { ...development, CLIPFORGE_DEPLOYMENT_ENV: "unknown" },
    { ...development, DATABASE_URL: undefined },
    { ...development, DIRECT_URL: undefined },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_HOST: undefined },
    { ...development, CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: undefined },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_NAME: undefined },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_PORT: undefined },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_HOST: "wrong.dev.example" },
    { ...development, CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "wrong.dev.example" },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_other" },
    { ...development, CLIPFORGE_EXPECTED_DATABASE_PORT: "6432" },
    { ...development, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.dev.example:5432/other" },
    { ...development, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.dev.example:5432/other" },
    { ...development, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@wrong.dev.example:5432/clipforge_dev" },
    { ...development, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@wrong.dev.example:5432/clipforge_dev" },
  ]) {
    assert.throws(() => assertMigrationTargetIdentity(env), (error: unknown) => {
      assert.ok(error instanceof MigrationTargetIdentityError);
      assert.doesNotMatch(error.message, /synthetic-user|synthetic-password|dev\.example|postgresql/);
      return true;
    });
  }
  assert.throws(() => assertMigrationTargetIdentity({ ...development, CLIPFORGE_EXPECTED_DATABASE_HOST: "https://pool.dev.example/path" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...development, CLIPFORGE_EXPECTED_DATABASE_PORT: "70000" }), MigrationTargetIdentityError);
});

test("migration command detection remains narrow", () => {
  assert.throws(() => assertMigrationTargetIdentity({ NODE_ENV: "test", CLIPFORGE_DEPLOYMENT_ENV: "test", DIRECT_URL: "postgresql://127.0.0.1:5432/clipforge_local_test", DATABASE_URL: "postgresql://127.0.0.1:5432/clipforge_local_test" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ NODE_ENV: "test", CLIPFORGE_DEPLOYMENT_ENV: "development", DIRECT_URL: "postgresql://127.0.0.1:54836/clipforge_local_test", DATABASE_URL: "postgresql://127.0.0.1:54836/clipforge_local_test" }), MigrationTargetIdentityError);
  assert.equal(isPrismaMigrationCommand(["migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--config", "prisma.config.ts", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--schema", "prisma/schema.prisma", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--telemetry-information", "synthetic-metadata", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--unknown-option", "synthetic-value", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--config"]), false);
  assert.equal(isPrismaMigrationCommand(["--config", "--schema", "prisma/schema.prisma", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["--preview-feature", "migrate", "deploy"]), true);
  assert.equal(isPrismaMigrationCommand(["generate"]), false);
  assert.equal(isPrismaMigrationCommand(["generate", "--schema", "migrate"]), false);
  assert.equal(isPrismaMigrationCommand(["validate"]), false);
});

test("explicit CI migrate deploy uses the fixed migrator identity and returns the validated original DIRECT_URL", () => {
  const ciMigration = {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  };

  assert.equal(
    assertMigrationTargetIdentity(ciMigration, ["migrate", "deploy"]),
    ciMigration.DIRECT_URL,
  );
});

test("CI migration authorization fails closed on missing flags, non-exact argv, or any identity mismatch", () => {
  const ciMigration = {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  };
  const rejected = [
    { env: { ...ciMigration, CI: undefined }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, CI: "1" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, CLIPFORGE_CI_MIGRATION: undefined }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, CLIPFORGE_CI_MIGRATION: "false" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, NODE_ENV: "development" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, CLIPFORGE_DEPLOYMENT_ENV: "development" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DATABASE_URL: "postgresql://wrong-role:synthetic-password@127.0.0.1:54836/clipforge_local_test" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DIRECT_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-password@localhost:54836/clipforge_local_test" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-password@127.0.0.1:5432/clipforge_local_test" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-password@127.0.0.1:54836/other" }, args: ["migrate", "deploy"] },
    { env: { ...ciMigration, DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-password@127.0.0.1:54836/clipforge_local_test?host=elsewhere" }, args: ["migrate", "deploy"] },
    { env: ciMigration, args: ["migrate", "deploy", "--schema", "other.prisma"] },
    { env: ciMigration, args: ["migrate", "dev"] },
    { env: ciMigration, args: ["--config", "other.config.ts", "migrate", "deploy"] },
    { env: ciMigration, args: ["--schema", "prisma/schema.prisma", "migrate", "deploy"] },
    { env: ciMigration, args: ["--telemetry-information", "synthetic-metadata", "migrate", "deploy"] },
    { env: ciMigration, args: ["--unknown-option", "synthetic-value", "migrate", "deploy"] },
    { env: ciMigration, args: ["--config", "migrate", "deploy"] },
    { env: ciMigration, args: ["--config", "--schema", "schema.prisma", "migrate", "deploy"] },
  ];

  for (const { env, args } of rejected) {
    assert.throws(() => assertMigrationTargetIdentity(env, args), (error: unknown) => {
      assert.ok(error instanceof MigrationTargetIdentityError);
      assert.doesNotMatch(error.message, /synthetic|127\.0\.0\.1|clipforge_local_test|postgresql|elsewhere/);
      return true;
    });
  }
});

test("test migrations are pinned to the isolated PostgreSQL 15 database and return the exact validated DIRECT_URL", () => {
  const local = {
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  };
  assert.equal(assertMigrationTargetIdentity(local), local.DIRECT_URL);
  for (const env of [
    { ...local, DATABASE_URL: "postgresql://other-user:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DIRECT_URL: "postgresql://other-user:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DATABASE_URL: "postgresql://127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DIRECT_URL: "postgresql://127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DATABASE_URL: "postgresql://clipforge_test%ZZadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DIRECT_URL: "postgresql://clipforge_test%ZZadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...local, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@127.0.0.1:5432/clipforge_local_test" },
    { ...local, DATABASE_URL: "postgresql://synthetic-user:synthetic-password@127.0.0.1:54836/other" },
    { ...local, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@localhost:54836/clipforge_local_test" },
    { ...local, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@127.0.0.1:54836/clipforge_local_test?%68ost=remote.example" },
  ]) assert.throws(() => assertMigrationTargetIdentity(env), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({
    ...local,
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?host=elsewhere",
  }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({
    ...local,
    DIRECT_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?sslmode=require&sslmode=disable",
  }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...local, DIRECT_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?%68ost=elsewhere" }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...local, DIRECT_URL: "postgresql://clipforge_test_admin:synthetic-password@127.0.0.1:54836/clipforge_local_test?sslmode=%ZZ" }), MigrationTargetIdentityError);
});

test("test mode safely decodes usernames and errors never disclose usernames, hosts or passwords", () => {
  const encoded = {
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test%5Fadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_test%5Fadmin:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  };
  assert.equal(assertMigrationTargetIdentity(encoded), encoded.DIRECT_URL);
  for (const env of [
    { ...encoded, DATABASE_URL: "postgresql://wrong-user:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
    { ...encoded, DIRECT_URL: "postgresql://wrong-user:synthetic-password@127.0.0.1:54836/clipforge_local_test?schema=public" },
  ]) {
    assert.throws(() => assertMigrationTargetIdentity(env), (error: unknown) => {
      assert.ok(error instanceof MigrationTargetIdentityError);
      assert.doesNotMatch(error.message, /wrong-user|synthetic-password|127\.0\.0\.1|clipforge_local_test|postgresql/);
      return true;
    });
  }
});

test("staging and production continue requiring their separate direct-host pins", () => {
  const production = {
    ...deployed,
    CLIPFORGE_DEPLOYMENT_ENV: "production",
    DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.prod.example:5432/clipforge_prod?sslmode=require",
    DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.prod.example:5432/clipforge_prod?sslmode=require",
    CLIPFORGE_EXPECTED_DATABASE_HOST: "pool.prod.example",
    CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "direct.prod.example",
    CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_prod",
  };
  assert.doesNotThrow(() => assertMigrationTargetIdentity(production));
  assert.throws(() => assertMigrationTargetIdentity({ ...production, CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: undefined }), MigrationTargetIdentityError);
  assert.throws(() => assertMigrationTargetIdentity({ ...production, DIRECT_URL: "postgresql://synthetic-user:synthetic-password@wrong.prod.example:5432/clipforge_prod" }), MigrationTargetIdentityError);
});

test("Prisma CLI uses the guard-returned DIRECT_URL for migration commands before config export", () => {
  const guardPosition = prismaConfig.indexOf("assertMigrationTargetIdentity(process.env)");
  const configPosition = prismaConfig.indexOf("export default defineConfig");
  assert.ok(guardPosition >= 0 && guardPosition < configPosition);
  assert.match(prismaConfig, /const migrationDirectUrl = isPrismaMigrationCommand[\s\S]*?assertMigrationTargetIdentity\(process\.env\)/);
  assert.match(prismaConfig, /datasource:\s*\{\s*url:\s*migrationDirectUrl \?\? env\("DIRECT_URL"\)\s*\}/);
});

test("real Prisma config resolves migration datasource to the original validated DIRECT_URL", () => {
  resolvePrismaConfigInChild(["migrate", "deploy"], {
    NODE_ENV: "development",
    CLIPFORGE_DEPLOYMENT_ENV: "development",
    DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.dev.example:5432/clipforge_dev?sslmode=require",
    DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.dev.example:5432/clipforge_dev?sslmode=require",
    CLIPFORGE_EXPECTED_DATABASE_HOST: "pool.dev.example",
    CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "direct.dev.example",
    CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_dev",
    CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
  }, "DATASOURCE_MATCH");
});

test("real Prisma config passes the original CI migrator DIRECT_URL only for the authorized deploy command", () => {
  resolvePrismaConfigInChild(["migrate", "deploy"], {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  }, "DATASOURCE_MATCH");
});

test("real Prisma config rejects CI migration flags and ambiguous option ordering", () => {
  resolvePrismaConfigInChild(["--telemetry-information", "synthetic-metadata", "migrate", "deploy"], {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  }, "GUARD_REJECTED");
  resolvePrismaConfigInChild(["--config", "migrate", "deploy"], {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  }, "GUARD_REJECTED");
});

test("real Prisma config keeps the non-migration datasource behavior without running the migration guard", () => {
  resolvePrismaConfigInChild(["generate"], {
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://wrong-user:synthetic-password@invalid.example:5432/not_the_test_database",
    DIRECT_URL: "postgresql://wrong-user:synthetic-password@invalid.example:5432/not_the_test_database",
  }, "DATASOURCE_MATCH");
});

test("real Prisma generate remains outside CI migration authorization", () => {
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    CLIPFORGE_CI_MIGRATION: "true",
    NODE_ENV: "test",
    CLIPFORGE_DEPLOYMENT_ENV: "test",
    DATABASE_URL: "postgresql://clipforge_test_admin:synthetic-runtime-password@127.0.0.1:54836/clipforge_local_test?schema=public",
    DIRECT_URL: "postgresql://clipforge_ci_migrator:synthetic-migrator-password@127.0.0.1:54836/clipforge_local_test?schema=public",
  };
  resolvePrismaConfigInChild(["generate"], env, "DATASOURCE_MATCH");
});

test("real Prisma config fails migration resolution when the target guard rejects", () => {
  resolvePrismaConfigInChild(["migrate", "deploy"], {
    NODE_ENV: "development",
    CLIPFORGE_DEPLOYMENT_ENV: "development",
    DATABASE_URL: "postgresql://synthetic-user:synthetic-password@pool.dev.example:5432/clipforge_dev",
    DIRECT_URL: "postgresql://synthetic-user:synthetic-password@direct.dev.example:5432/clipforge_dev",
    CLIPFORGE_EXPECTED_DATABASE_HOST: "wrong-pool.dev.example",
    CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST: "direct.dev.example",
    CLIPFORGE_EXPECTED_DATABASE_NAME: "clipforge_dev",
    CLIPFORGE_EXPECTED_DATABASE_PORT: "5432",
  }, "GUARD_REJECTED");
});
