import assert from "node:assert/strict";
import test from "node:test";
import { readMediaStorageConfiguration } from "../src/server/storage/storage-config.ts";

const s3 = (overrides: Record<string, string | undefined> = {}) => readMediaStorageConfiguration({
  NODE_ENV: "development", VERCEL_ENV: "development", CLIPFORGE_STORAGE_ENV: "development", CLIPFORGE_STORAGE_PROVIDER: "s3",
  CLIPFORGE_S3_BUCKET: "clipforge-development-media", CLIPFORGE_S3_REGION: "ap-south-1",
  CLIPFORGE_S3_ACCESS_KEY_ID: "dev-access-key", CLIPFORGE_S3_SECRET_ACCESS_KEY: "dev-secret-key",
  ...overrides,
});

test("S3 config accepts a complete development environment and returns only that environment's settings", () => {
  const result = s3();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.provider, "s3");
  assert.equal(result.environment, "development");
  assert.equal(result.bucket, "clipforge-development-media");
});

test("S3 config rejects incomplete credentials and invalid bucket or region", () => {
  assert.equal(s3({ CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_BUCKET: "ClipForge bucket" }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_REGION: "not-a-region" }).ok, false);
  assert.equal(s3({ CLIPFORGE_STORAGE_PROVIDER: undefined }).ok, false);
});

test("storage environment must match Vercel deployment environment", () => {
  assert.equal(s3({ VERCEL_ENV: "production", NODE_ENV: "production", CLIPFORGE_STORAGE_ENV: "development" }).ok, false);
  assert.equal(s3({ VERCEL_ENV: "preview", NODE_ENV: "production", CLIPFORGE_STORAGE_ENV: "production" }).ok, false);
  const production = s3({ VERCEL_ENV: "production", NODE_ENV: "production", CLIPFORGE_STORAGE_ENV: "production", CLIPFORGE_S3_BUCKET: "clipforge-production-media" });
  assert.equal(production.ok && production.provider === "s3" ? production.environment : null, "production");
  assert.equal(s3({ VERCEL_ENV: undefined, NODE_ENV: "development", CLIPFORGE_STORAGE_ENV: "production", CLIPFORGE_S3_BUCKET: "clipforge-production-media" }).ok, false);
  assert.equal(s3({ VERCEL_ENV: undefined, NODE_ENV: "production", CLIPFORGE_STORAGE_ENV: "development" }).ok, false);
});

test("local disk is accepted only when explicitly selected with a private directory and never in production", () => {
  const testConfig = readMediaStorageConfiguration({ NODE_ENV: "test", CLIPFORGE_STORAGE_ENV: "test", CLIPFORGE_STORAGE_PROVIDER: "local-disk", CLIPFORGE_LOCAL_MEDIA_DIR: "/private/tmp/clipforge-test-media" });
  assert.equal(testConfig.ok && testConfig.provider, "local-disk");
  assert.equal(readMediaStorageConfiguration({ NODE_ENV: "production", VERCEL_ENV: "production", CLIPFORGE_STORAGE_ENV: "production", CLIPFORGE_STORAGE_PROVIDER: "local-disk", CLIPFORGE_LOCAL_MEDIA_DIR: "/tmp/media" }).ok, false);
  assert.equal(readMediaStorageConfiguration({ NODE_ENV: "development", CLIPFORGE_STORAGE_ENV: "development", CLIPFORGE_STORAGE_PROVIDER: "local-disk" }).ok, false);
});

test("SES credentials are not used as S3 credentials", () => {
  const result = s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined, AWS_ACCESS_KEY_ID: "ses-only-id", AWS_SECRET_ACCESS_KEY: "ses-only-secret" });
  assert.equal(result.ok, false);
});
