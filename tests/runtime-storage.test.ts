import assert from "node:assert/strict";
import test from "node:test";
import { createDatabaseRuntime } from "../src/server/runtime.ts";
import { getUploadInfo } from "../src/server/queries.ts";

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

test("database runtime fails closed when S3 is missing and does not fall back to memory or disk", async () => {
  const runtime = createDatabaseRuntime("postgresql://not-used", async () => { throw new Error("not used"); }, { storageEnvironment: { ...env, CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined } });
  const services = await runtime.media!();
  assert.ok(services);
  assert.ok(services.unavailable);
  assert.notEqual(services.storage.kind, "memory");
  assert.equal(services.unavailable?.includes("configuration is incomplete"), true);
  const info = getUploadInfo({ userId: "owner", now: new Date(), repo: {} as never, newId: () => "id", config: { coverSupport: "supported" }, media: services });
  assert.equal(info.storageStatus, "unavailable");
  assert.equal(info.destination, null);
});
