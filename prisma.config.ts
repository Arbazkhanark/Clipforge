// Prisma 7 CLI configuration (connection URL lives here, not in schema.prisma).
// Not yet run: the Prisma CLI could not be installed in the dev sandbox (no network).
// Prisma 7 does not load .env by itself; run commands with the variable set (e.g. `node --env-file=.env ...`)
// or add `import "dotenv/config"` once dotenv is installed.
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
