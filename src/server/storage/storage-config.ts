import type { Environment } from "../environment.ts";

export type StorageEnvironment = "development" | "preview" | "test" | "staging" | "production";

export type MediaStorageConfiguration =
  | { ok: true; provider: "s3"; environment: "development" | "preview" | "staging" | "production"; bucket: string; region: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }
  | { ok: true; provider: "local-disk"; directory: string }
  | { ok: false; reason: string };

const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!-)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!.*-$)[a-z0-9.-]{3,63}$/;

function legacyExpectedEnvironment(env: Environment): StorageEnvironment | null {
  const vercel = env["VERCEL_ENV"]?.trim();
  const node = env["NODE_ENV"];
  if (vercel) {
    if (!["production", "preview", "development"].includes(vercel)) return null;
    if (vercel === "production") return node === "production" ? "production" : null;
    if (vercel === "preview") return ["production", "development"].includes(node ?? "") ? "development" : null;
    return node === "development" ? "development" : null;
  }
  if (node === "production") return "production";
  if (node === "development") return "development";
  if (node === "test") return "test";
  return null;
}

/** Explicit deployment identity wins; Vercel variables remain a compatibility fallback only. */
export function deploymentStorageEnvironment(env: Environment): StorageEnvironment | null {
  const configured = env["CLIPFORGE_DEPLOYMENT_ENV"];
  if (configured !== undefined) {
    const value = configured.trim().toLowerCase();
    if (!["development", "preview", "production", "test", "staging"].includes(value)) return null;
    const node = env["NODE_ENV"];
    // Do not permit a production process to opt into a development bucket (or vice versa).
    if ((node === "production" && value === "development") || (node !== "production" && value === "production") || (value === "staging" && node !== "production")) return null;
    if (node === "test" && value !== "test") return null;
    // Preview may share development storage only for Vercel's explicitly identified Preview deployment.
    if (value === "preview" && node === "production" && env["VERCEL_ENV"] !== "preview") return null;
    if (value === "test" && node !== "test") return null;
    // On Vercel, reject a contradictory explicit setting without using VERCEL_ENV to select a bucket.
    const vercelEnvironment = env["VERCEL_ENV"];
    if (vercelEnvironment === "production" && value !== "production") return null;
    if (vercelEnvironment === "preview" && value !== "preview") return null;
    if (vercelEnvironment === "development" && value !== "development") return null;
    return value as StorageEnvironment;
  }
  return legacyExpectedEnvironment(env);
}

/** Validates server-only storage settings and refuses environment/bucket fallback behavior. */
export function readMediaStorageConfiguration(env: Environment): MediaStorageConfiguration {
  const provider = env["CLIPFORGE_STORAGE_PROVIDER"]?.trim().toLowerCase();
  if (provider === "local-disk") {
    const environment = deploymentStorageEnvironment(env);
    const directory = env["CLIPFORGE_LOCAL_MEDIA_DIR"]?.trim() ?? "";
    if (env["NODE_ENV"] === "production" || environment === "production") return { ok: false, reason: "Local disk storage is disabled in production." };
    if (!environment || !directory) return { ok: false, reason: "Explicit local/test storage configuration is incomplete." };
    return { ok: true, provider: "local-disk", directory };
  }
  if (provider !== "s3") return { ok: false, reason: "S3 storage must be explicitly selected." };

  const environment = deploymentStorageEnvironment(env);
  const bucketVariable = environment === "production"
    ? "CLIPFORGE_S3_PRODUCTION_BUCKET"
    : environment === "staging"
      ? "CLIPFORGE_S3_STAGING_BUCKET"
      : "CLIPFORGE_S3_DEVELOPMENT_BUCKET";
  const bucket = env[bucketVariable]?.trim() ?? "";
  const region = env["CLIPFORGE_S3_REGION"]?.trim() ?? "";
  const accessKeyId = env["CLIPFORGE_S3_ACCESS_KEY_ID"]?.trim() ?? "";
  const secretAccessKey = env["CLIPFORGE_S3_SECRET_ACCESS_KEY"] ?? "";
  const sessionToken = env["CLIPFORGE_S3_SESSION_TOKEN"]?.trim() ?? "";
  if (!environment || environment === "test") return { ok: false, reason: "Storage environment does not match the process environment." };
  const hasStaticAccessKey = Boolean(accessKeyId);
  const hasStaticSecret = Boolean(secretAccessKey.trim());
  if (!BUCKET.test(bucket) || !REGION.test(region) || hasStaticAccessKey !== hasStaticSecret || (sessionToken && !hasStaticAccessKey)) {
    return { ok: false, reason: "S3 storage configuration is incomplete or invalid." };
  }
  return {
    ok: true, provider: "s3", environment, bucket, region,
    ...(hasStaticAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } } : {}),
  };
}
