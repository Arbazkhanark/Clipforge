import assert from "node:assert/strict";
import test from "node:test";
import { readMediaStorageConfiguration } from "../src/server/storage/storage-config.ts";

const s3 = (overrides: Record<string, string | undefined> = {}) => readMediaStorageConfiguration({
  NODE_ENV: "development", VERCEL_ENV: "development", CLIPFORGE_STORAGE_PROVIDER: "s3",
  CLIPFORGE_S3_DEVELOPMENT_BUCKET: "dev-media-bucket", CLIPFORGE_S3_REGION: "ap-south-1",
  CLIPFORGE_S3_ACCESS_KEY_ID: "dev-access-key", CLIPFORGE_S3_SECRET_ACCESS_KEY: "dev-secret-key",
  ...overrides,
});

test("S3 config accepts development settings without a storage mode variable or bucket-name marker", () => {
  const result = s3();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.provider, "s3");
  assert.equal(result.environment, "development");
  assert.equal(result.bucket, "dev-media-bucket");
  assert.equal(s3({ CLIPFORGE_STORAGE_ENV: "production" }).ok, true, "legacy storage mode is ignored");
});

test("S3 supports the AWS SDK credential chain and rejects partial ClipForge static credentials", () => {
  const role = s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined });
  assert.equal(role.ok, true);
  assert.equal(role.ok && role.provider === "s3" ? role.credentials : null, undefined);
  assert.equal(s3({ CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined, CLIPFORGE_S3_SESSION_TOKEN: "session-only" }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_DEVELOPMENT_BUCKET: "ClipForge bucket" }).ok, false);
  assert.equal(s3({ CLIPFORGE_S3_REGION: "not-a-region" }).ok, false);
  assert.equal(s3({ CLIPFORGE_STORAGE_PROVIDER: undefined }).ok, false);
});

test("explicit ClipForge deployment environment selects storage and rejects unsafe contradictions", () => {
  const preview = s3({
    NODE_ENV: "production", VERCEL_ENV: "preview", CLIPFORGE_DEPLOYMENT_ENV: "preview",
    CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined,
  });
  assert.equal(preview.ok && preview.provider === "s3" ? preview.environment : null, "preview");
  assert.equal(s3({ NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "development" }).ok, false);
  assert.equal(s3({ NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "preview" }).ok, false);
  assert.equal(s3({ NODE_ENV: "test", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "development" }).ok, false);
  assert.equal(s3({ NODE_ENV: "production", VERCEL_ENV: "production", CLIPFORGE_DEPLOYMENT_ENV: "preview" }).ok, false);
  assert.equal(s3({ NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "typo" }).ok, false);
  const explicitProd = s3({
    NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "production",
    CLIPFORGE_S3_DEVELOPMENT_BUCKET: undefined, CLIPFORGE_S3_PRODUCTION_BUCKET: "prod-media-bucket",
  });
  assert.equal(explicitProd.ok && explicitProd.provider === "s3" ? explicitProd.environment : null, "production");
  assert.equal(explicitProd.ok && explicitProd.provider === "s3" ? explicitProd.bucket : null, "prod-media-bucket");
});

test("storage environment must match Vercel deployment environment", () => {
  assert.equal(s3({ VERCEL_ENV: "production", NODE_ENV: "production", CLIPFORGE_S3_PRODUCTION_BUCKET: undefined }).ok, false);
  assert.equal(s3({ VERCEL_ENV: "preview", NODE_ENV: "production", CLIPFORGE_S3_DEVELOPMENT_BUCKET: "dev-preview-bucket" }).ok, true);
  assert.equal(s3({ VERCEL_ENV: "preview", NODE_ENV: "production", CLIPFORGE_S3_DEVELOPMENT_BUCKET: undefined, CLIPFORGE_S3_PRODUCTION_BUCKET: "prod-media-bucket" }).ok, false);
  const production = s3({ VERCEL_ENV: "production", NODE_ENV: "production", CLIPFORGE_S3_DEVELOPMENT_BUCKET: undefined, CLIPFORGE_S3_PRODUCTION_BUCKET: "prod-media-bucket" });
  assert.equal(production.ok && production.provider === "s3" ? production.environment : null, "production");
  assert.equal(production.ok && production.provider === "s3" ? production.bucket : null, "prod-media-bucket");
  assert.equal(s3({ VERCEL_ENV: undefined, NODE_ENV: "development", CLIPFORGE_S3_DEVELOPMENT_BUCKET: undefined, CLIPFORGE_S3_PRODUCTION_BUCKET: "prod-media-bucket" }).ok, false);
  assert.equal(s3({ VERCEL_ENV: undefined, NODE_ENV: "production", CLIPFORGE_S3_DEVELOPMENT_BUCKET: "dev-media-bucket", CLIPFORGE_S3_PRODUCTION_BUCKET: undefined }).ok, false);
  assert.equal(s3({ VERCEL_ENV: "development", NODE_ENV: "development" }).ok, true);
  assert.equal(s3({ VERCEL_ENV: "invalid", NODE_ENV: "development" }).ok, false);
});

test("staging requires and selects only its dedicated private bucket", () => {
  const staging = s3({
    NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "staging",
    CLIPFORGE_S3_DEVELOPMENT_BUCKET: "dev-media-bucket",
    CLIPFORGE_S3_STAGING_BUCKET: "stage-media-bucket",
    CLIPFORGE_S3_PRODUCTION_BUCKET: "prod-media-bucket",
    CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined,
  });
  assert.equal(staging.ok && staging.provider === "s3" ? staging.environment : null, "staging");
  assert.equal(staging.ok && staging.provider === "s3" ? staging.bucket : null, "stage-media-bucket");
  assert.equal(s3({
    NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "staging",
    CLIPFORGE_S3_STAGING_BUCKET: undefined,
    CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined,
  }).ok, false, "staging must not fall back to development or production buckets");
  assert.equal(s3({
    NODE_ENV: "production", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "staging",
    CLIPFORGE_S3_DEVELOPMENT_BUCKET: undefined,
    CLIPFORGE_S3_STAGING_BUCKET: undefined,
    CLIPFORGE_S3_PRODUCTION_BUCKET: undefined,
    CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined,
  }).ok, false);
  assert.equal(s3({ NODE_ENV: "development", VERCEL_ENV: undefined, CLIPFORGE_DEPLOYMENT_ENV: "staging" }).ok, false);
});

test("local disk is accepted only when explicitly selected with a private directory and never in production", () => {
  const testConfig = readMediaStorageConfiguration({ NODE_ENV: "test", CLIPFORGE_STORAGE_PROVIDER: "local-disk", CLIPFORGE_LOCAL_MEDIA_DIR: "/private/tmp/clipforge-test-media" });
  assert.equal(testConfig.ok && testConfig.provider, "local-disk");
  assert.equal(readMediaStorageConfiguration({ NODE_ENV: "production", VERCEL_ENV: "production", CLIPFORGE_STORAGE_PROVIDER: "local-disk", CLIPFORGE_LOCAL_MEDIA_DIR: "/tmp/media" }).ok, false);
  assert.equal(readMediaStorageConfiguration({ NODE_ENV: "development", CLIPFORGE_STORAGE_PROVIDER: "local-disk" }).ok, false);
});

test("standard AWS credential-chain variables remain available to the AWS SDK", () => {
  const result = s3({ CLIPFORGE_S3_ACCESS_KEY_ID: undefined, CLIPFORGE_S3_SECRET_ACCESS_KEY: undefined, AWS_ACCESS_KEY_ID: "ses-only-id", AWS_SECRET_ACCESS_KEY: "ses-only-secret" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.provider === "s3" ? result.credentials : null, undefined);
});
