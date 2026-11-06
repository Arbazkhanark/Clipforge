// Prisma 7 CLI configuration. The connection URL stays out of schema.prisma.
// Prisma 7 does not load .env files. The db:* scripts pass --env-file=.env.local.
// This file's URL is the direct Neon connection (DIRECT_URL). Migrations need it.
// The running app must use DATABASE_URL, the pooled Neon connection.
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DIRECT_URL") },
});
