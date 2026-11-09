// Creates the Prisma 7 client generated at the schema's custom output path, with the PostgreSQL driver adapter.
// Imports stay dynamic so the CLI and generated client are loaded only when DATABASE_URL mode is actually used.
import type { PrismaClientLike } from "./prisma-client-like.ts";

export async function createPrismaClient(connectionString: string): Promise<PrismaClientLike> {
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../../generated/prisma/client.ts");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) }) as unknown as PrismaClientLike;
}
