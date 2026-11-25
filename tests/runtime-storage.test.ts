import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseRuntime } from "../src/server/runtime.ts";
import { getUploadInfo } from "../src/server/queries.ts";
import { S3MediaStorage } from "../src/server/storage/s3-storage.ts";
import type { S3Client } from "@aws-sdk/client-s3";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const env = {
  NODE_ENV: "development", VERCEL_ENV: "development", CLIPFORGE_STORAGE_PROVIDER: "s3",
  CLIPFORGE_S3_DEVELOPMENT_BUCKET: "dev-media-bucket", CLIPFORGE_S3_REGION: "ap-south-1",
  CLIPFORGE_S3_ACCESS_KEY_ID: "synthetic-access-key", CLIPFORGE_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
};

test("database runtime selects S3 without connecting until storage is used", async () => {
  let connected = false;
  const runtime = createDatabaseRuntime("postgresql://not-used", async () => { connected = true; throw new Error("not used"); }, { storageEnvironment: env });
  const services = await runtime.media!();
  assert.ok(services);
  assert.equal(services.storage.kind, "s3");
  assert.equal(services.unavailable, undefined);
  const info = getUploadInfo({ userId: "owner", now: new Date(), repo: {} as never, newId: () => "id", config: { coverSupport: "supported" }, media: services });
  assert.deepEqual(info.destination, { provider: "s3", providerLabel: "AWS S3", environment: "development", bucket: env.CLIPFORGE_S3_DEVELOPMENT_BUCKET, region: env.CLIPFORGE_S3_REGION, privacy: "Private" });
  assert.equal(info.storageStatus, "available");
  assert.equal(JSON.stringify(info).includes("synthetic-secret-key"), false);
  assert.equal(connected, false);
});

test("database runtime accepts task-role S3 configuration without creating credentials or contacting AWS", async () => {
  const runtime = createDatabaseRuntime("postgresql://not-used", async () => { throw new Error("not used"); }, { storageEnvironment: { ...env, CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined } });
  const services = await runtime.media!();
  assert.ok(services);
  assert.equal(services.unavailable, undefined);
  assert.equal(services.storage.kind, "s3");
  const info = getUploadInfo({ userId: "owner", now: new Date(), repo: {} as never, newId: () => "id", config: { coverSupport: "supported" }, media: services });
  assert.equal(info.storageStatus, "available");
  assert.equal(info.destination?.provider, "s3");
});

test("database runtime readiness checks PostgreSQL and storage configuration, then disposes Prisma", async () => {
  const client = new FakePrismaClient() as FakePrismaClient & { $disconnect?: () => Promise<void> };
  let queries = 0;
  let disconnected = false;
  client.$queryRaw = async () => { queries += 1; return []; };
  client.$disconnect = async () => { disconnected = true; };
  const runtime = createDatabaseRuntime("postgresql://not-used", async () => client, {
    storageEnvironment: { ...env, CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined },
  });
  await runtime.checkReadiness!();
  assert.equal(queries, 2, "startup and readiness each ping the database");
  await runtime.dispose!();
  assert.equal(disconnected, true);
});

test("S3 storage close releases its AWS SDK client without making a request", () => {
  let destroyed = false;
  const storage = new S3MediaStorage({ destroy: () => { destroyed = true; } } as unknown as S3Client, "dev-media-bucket");
  storage.close();
  assert.equal(destroyed, true);
});
