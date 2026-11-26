// Creates the Prisma 7 client generated at the schema's custom output path, with the PostgreSQL driver adapter.
// Imports stay dynamic so the CLI and generated client are loaded only when DATABASE_URL mode is actually used.
import type { PrismaClientLike } from "./prisma-client-like.ts";
import { assertSafeDatabaseConnectionUrl, assertWebDatabaseIdentity } from "../workers/database-identity-guard.ts";

export async function createPrismaClient(connectionString: string): Promise<PrismaClientLike> {
  assertSafeDatabaseConnectionUrl(connectionString);
  assertWebDatabaseIdentity(process.env, connectionString);
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../../generated/prisma/client.ts");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }) }) as unknown as PrismaClientLike;
}
