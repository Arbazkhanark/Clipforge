import type { Environment } from "../environment.ts";

export class WorkerDatabaseIdentityError extends Error {
  constructor() {
    super("Deployment database identity is missing or does not match the configured expectation.");
    this.name = "WorkerDatabaseIdentityError";
  }
}

export type DatabaseTarget = { host: string; database: string; port: number; username: string };

const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*$/;
const SAFE_QUERY_PARAMETERS = new Set([
  "application_name", "connect_timeout", "schema", "ssl", "sslcert", "sslkey", "sslmode",
  "sslnegotiation", "sslpassword", "sslrootcert",
]);

/** Parse the same effective URL fields consumed by pg-connection-string, without connecting. */
export function parseSafeDatabaseTarget(databaseUrl: string | undefined): DatabaseTarget {
  const url = databaseUrl?.trim();
  if (!url || /%(?![0-9a-fA-F]{2})/.test(url)) throw new WorkerDatabaseIdentityError();

  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || parsed.hash || url.includes("#")) {
      throw new WorkerDatabaseIdentityError();
    }
    if (url.includes("?") && parsed.searchParams.size === 0) throw new WorkerDatabaseIdentityError();

    // node-postgres copies decoded query parameters into its config object; host and port
    // therefore override the URL authority. Reject all unreviewed options and duplicates.
    const seen = new Set<string>();
    for (const [key, value] of parsed.searchParams) {
      const normalizedKey = key.toLowerCase();
      if (!/^[a-z][a-z0-9_]*$/.test(normalizedKey) || seen.has(normalizedKey) || !SAFE_QUERY_PARAMETERS.has(normalizedKey)) {
        throw new WorkerDatabaseIdentityError();
      }
      seen.add(normalizedKey);
      if (normalizedKey === "application_name" && (Buffer.byteLength(value, "utf8") > 63 || /[\u0000-\u001f\u007f]/.test(value))) {
        throw new WorkerDatabaseIdentityError();
      }
      if (normalizedKey === "connect_timeout" && !/^[1-9][0-9]*$/.test(value)) throw new WorkerDatabaseIdentityError();
      if (normalizedKey === "schema" && value !== "public") throw new WorkerDatabaseIdentityError();
      if (normalizedKey === "ssl" && !["true", "false", "1", "0"].includes(value.toLowerCase())) throw new WorkerDatabaseIdentityError();
      if (normalizedKey === "sslmode" && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full", "no-verify"].includes(value.toLowerCase())) throw new WorkerDatabaseIdentityError();
      if (normalizedKey === "sslnegotiation" && !["postgres", "direct"].includes(value.toLowerCase())) throw new WorkerDatabaseIdentityError();
    }

    const host = parsed.hostname.toLowerCase();
    const username = decodeURIComponent(parsed.username);
    const rawDatabase = parsed.pathname.replace(/^\//, "");
    const database = decodeURIComponent(rawDatabase);
    const port = parsed.port ? Number(parsed.port) : 5432;
    if (!SAFE_HOST.test(host) || !database || rawDatabase.includes("/") || database.includes("/") ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new WorkerDatabaseIdentityError();
    }
    return { host, database, port, username };
  } catch (error) {
    if (error instanceof WorkerDatabaseIdentityError) throw error;
    throw new WorkerDatabaseIdentityError();
  }
}

/** Reject routing/ambiguous options before a URL is handed to the PostgreSQL adapter. */
export function assertSafeDatabaseConnectionUrl(databaseUrl: string): void {
  parseSafeDatabaseTarget(databaseUrl);
}

/** Checks a database URL against non-secret host/name/port pins without opening a connection. */
function assertIdentity(env: Environment, databaseUrl: string | undefined): void {
  const expectedHost = env["CLIPFORGE_EXPECTED_DATABASE_HOST"]?.trim().toLowerCase();
  const expectedDatabase = env["CLIPFORGE_EXPECTED_DATABASE_NAME"]?.trim();
  const expectedPortRaw = env["CLIPFORGE_EXPECTED_DATABASE_PORT"]?.trim();
  if (!expectedHost || !SAFE_HOST.test(expectedHost) || !expectedDatabase || /[\/?#\u0000-\u001f]/.test(expectedDatabase) ||
      !expectedPortRaw || !/^[1-9][0-9]{0,4}$/.test(expectedPortRaw)) {
    throw new WorkerDatabaseIdentityError();
  }
  const expectedPort = Number(expectedPortRaw);
  if (expectedPort < 1 || expectedPort > 65535) throw new WorkerDatabaseIdentityError();
  const target = parseSafeDatabaseTarget(databaseUrl);
  if (target.host !== expectedHost || target.database !== expectedDatabase || target.port !== expectedPort) throw new WorkerDatabaseIdentityError();
}

/** Fail closed for production workers; local and test workers retain their current workflows. */
export function assertWorkerDatabaseIdentity(env: Environment = process.env): void {
  if (env["NODE_ENV"] !== "production" && env["CLIPFORGE_DEPLOYMENT_ENV"] !== "production" && env["CLIPFORGE_DEPLOYMENT_ENV"] !== "staging") return;
  assertIdentity(env, env["DATABASE_URL"]);
}

/**
 * The web app uses this before resolving any runtime adapter. Vercel Preview remains
 * compatible with its existing preview database setup; standalone production and
 * explicitly named staging/production deployments require identity pins.
 */
export function assertWebDatabaseIdentity(env: Environment = process.env, databaseUrl: string | undefined = env["DATABASE_URL"]): void {
  // With no runtime DATABASE_URL the app cannot connect to a database; preserve its
  // existing unconfigured behavior instead of treating it as an identity mismatch.
  if (!databaseUrl?.trim()) return;
  const deployment = env["CLIPFORGE_DEPLOYMENT_ENV"]?.trim().toLowerCase();
  const explicitProtectedMode = deployment === "production" || deployment === "staging";
  const vercelPreview = env["VERCEL_ENV"] === "preview" && !explicitProtectedMode;
  if (!explicitProtectedMode && (vercelPreview || env["NODE_ENV"] !== "production")) return;
  assertIdentity(env, databaseUrl);
}
