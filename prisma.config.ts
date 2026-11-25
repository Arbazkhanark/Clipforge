// Prisma 7 CLI configuration. The connection URL stays out of schema.prisma.
// Prisma 7 does not load .env files. The db:* scripts pass --env-file=.env.local.
// This file's URL is the direct Neon connection (DIRECT_URL). Migrations need it.
// The running app must use DATABASE_URL, the pooled Neon connection.
import { defineConfig, env } from "prisma/config";
import { assertMigrationTargetIdentity, isPrismaMigrationCommand } from "./src/server/migration-target-guard.ts";

// Validate both runtime/pooler and direct migration endpoints before Prisma's
// migration CLI can act. Local workflows remain unchanged when not in a deployed mode.
const migrationDirectUrl = isPrismaMigrationCommand(process.argv.slice(2))
  ? assertMigrationTargetIdentity(process.env)
  : undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: migrationDirectUrl ?? env("DIRECT_URL") },
});
