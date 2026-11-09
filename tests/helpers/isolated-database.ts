// Database-mode tests may use only the isolated PostgreSQL 15 cluster.
// Unconfigured and demo tests call withoutDatabaseEnv so an inherited URL cannot change their mode.

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PORT = "5434";
const LOCAL_PORT_ENV = "CLIPFORGE_TEST_DATABASE_PORT";
const LOCAL_DATABASE = "/clipforge_local_test";

function configuredLocalPort(): string {
  const configured = process.env[LOCAL_PORT_ENV];
  if (configured === undefined) return DEFAULT_LOCAL_PORT;
  if (!/^\d{1,5}$/.test(configured)) {
    throw new Error(`${LOCAL_PORT_ENV} must be a valid TCP port. Refusing to connect.`);
  }
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== configured || configured === DEFAULT_LOCAL_PORT) {
    throw new Error(`${LOCAL_PORT_ENV} is not an allowed isolated test port. Refusing to connect.`);
  }
  return configured;
}

function clearDatabaseRuntime(): void {
  delete (globalThis as { __clipforgeDatabaseRuntime?: unknown }).__clipforgeDatabaseRuntime;
}

function isolatedTarget(value: string | undefined, name: string, localPort: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  let protocol = "";
  let hostname = "";
  let port = "";
  let pathname = "";
  try {
    const parsed = new URL(value);
    protocol = parsed.protocol;
    hostname = parsed.hostname;
    port = parsed.port;
    pathname = parsed.pathname;
  } catch {
    throw new Error(`${name} is not the isolated local test database. Refusing to connect.`);
  }
  const local = protocol === "postgresql:" && hostname === LOCAL_HOST && port === localPort && pathname === LOCAL_DATABASE;
  if (!local) throw new Error(`${name} is not the isolated local test database. Refusing to connect.`);
  return value;
}

/** The local test URL, or undefined when no database is configured. A different URL is refused before any connection. */
export function isolatedDatabaseUrl(): string | undefined {
  const localPort = configuredLocalPort();
  const database = isolatedTarget(process.env["DATABASE_URL"], "DATABASE_URL", localPort);
  const direct = isolatedTarget(process.env["DIRECT_URL"], "DIRECT_URL", localPort);
  if (direct && !database) throw new Error("DIRECT_URL is set without DATABASE_URL. Refusing to connect.");
  if (direct && database && direct !== database) throw new Error("DIRECT_URL and DATABASE_URL do not match. Refusing to connect.");
  return database;
}

/** Runs work with no database URL, then restores the previous values and drops any cached database runtime. */
export async function withoutDatabaseEnv<T>(work: () => Promise<T> | T): Promise<T> {
  const previousDatabase = process.env["DATABASE_URL"];
  const previousDirect = process.env["DIRECT_URL"];
  delete process.env["DATABASE_URL"];
  delete process.env["DIRECT_URL"];
  clearDatabaseRuntime();
  try {
    return await work();
  } finally {
    if (previousDatabase === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousDatabase;
    if (previousDirect === undefined) delete process.env["DIRECT_URL"];
    else process.env["DIRECT_URL"] = previousDirect;
    clearDatabaseRuntime();
  }
}
