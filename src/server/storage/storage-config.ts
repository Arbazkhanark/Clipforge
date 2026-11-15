import type { Environment } from "../environment.ts";

export type StorageEnvironment = "development" | "production" | "test";

export type MediaStorageConfiguration =
  | { ok: true; provider: "s3"; environment: Exclude<StorageEnvironment, "test">; bucket: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }
  | { ok: true; provider: "local-disk"; directory: string }
  | { ok: false; reason: string };

const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!-)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!.*-$)[a-z0-9.-]{3,63}$/;

function expectedEnvironment(env: Environment): StorageEnvironment | null {
  const configured = env["CLIPFORGE_STORAGE_ENV"]?.trim();
  if (configured !== "development" && configured !== "production" && configured !== "test") return null;
  const vercel = env["VERCEL_ENV"]?.trim();
  const node = env["NODE_ENV"];
  if (vercel) {
    if (!["production", "preview", "development"].includes(vercel)) return null;
    if (vercel === "production" && (configured !== "production" || node !== "production")) return null;
    if (vercel === "preview" && (configured !== "development" || !["production", "development"].includes(node ?? ""))) return null;
    if (vercel === "development" && (configured !== "development" || node !== "development")) return null;
    if (configured === "test") return null;
  } else {
    if (node === "production" && configured !== "production") return null;
    if (node === "development" && configured !== "development") return null;
    if (node === "test" && configured !== "test") return null;
    if (node !== "production" && node !== "development" && node !== "test") return null;
    if (node !== "test" && configured === "test") return null;
  }
  return configured;
}

/** Validates server-only storage settings and refuses environment/bucket fallback behavior. */
export function readMediaStorageConfiguration(env: Environment): MediaStorageConfiguration {
  const provider = env["CLIPFORGE_STORAGE_PROVIDER"]?.trim().toLowerCase();
  if (provider === "local-disk") {
    const environment = expectedEnvironment(env);
    const directory = env["CLIPFORGE_LOCAL_MEDIA_DIR"]?.trim() ?? "";
    if (env["NODE_ENV"] === "production" || environment === "production") return { ok: false, reason: "Local disk storage is disabled in production." };
    if (!environment || !directory) return { ok: false, reason: "Explicit test-only local storage configuration is incomplete." };
    return { ok: true, provider: "local-disk", directory };
  }
  if (provider !== "s3") return { ok: false, reason: "S3 storage must be explicitly selected." };

  const environment = expectedEnvironment(env);
  const bucket = env["CLIPFORGE_S3_BUCKET"]?.trim() ?? "";
  const region = env["CLIPFORGE_S3_REGION"]?.trim() ?? "";
  const accessKeyId = env["CLIPFORGE_S3_ACCESS_KEY_ID"]?.trim() ?? "";
  const secretAccessKey = env["CLIPFORGE_S3_SECRET_ACCESS_KEY"] ?? "";
  const sessionToken = env["CLIPFORGE_S3_SESSION_TOKEN"]?.trim() ?? "";
  const bucketEnvironmentMatches = environment === "development"
    ? /(?:^|[-.])(?:dev|development)(?:[-.]|$)/.test(bucket)
    : /(?:^|[-.])(?:prod|production)(?:[-.]|$)/.test(bucket);
  if (!environment || environment === "test") return { ok: false, reason: "Storage environment does not match the process environment." };
  if (!BUCKET.test(bucket) || !bucketEnvironmentMatches || !REGION.test(region) || !accessKeyId || !secretAccessKey.trim()) {
    return { ok: false, reason: "S3 storage configuration is incomplete or invalid." };
  }
  return {
    ok: true, provider: "s3", environment, bucket, region,
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  };
}
