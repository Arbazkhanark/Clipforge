// Creates the REAL Prisma client. UNVERIFIED: written from the Prisma 7 migration guide (a driver adapter is required;
// the generated client lives where `output` in schema.prisma says). It has never run: no packages, no database, no network here.
// Imports are dynamic so nothing breaks (or needs the packages) until DATABASE_URL mode is actually used.
import type { PrismaClientLike } from "./prisma-client-like.ts";

export async function createPrismaClient(connectionString: string): Promise<PrismaClientLike> {
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../../generated/prisma/client.ts");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) }) as unknown as PrismaClientLike;
}
