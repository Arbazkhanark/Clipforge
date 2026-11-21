// The ONE place that decides which adapters the app uses. Everything else asks for a RequestContext.
//
// MODES (honest by design):
//   "unconfigured" (default): there is no real authentication or database yet, so nobody is signed in,
//                  data pages show a "sign in" message and API calls answer 401/503. Nothing is faked.
//   "demo" (CLIPFORGE_DEMO_MODE=true): an in-memory repository with clearly labelled SAMPLE data and one
//                  built-in sample user. Data resets when the server restarts. For local development only.
//   "local" (CLIPFORGE_LOCAL_AUTH=true, not production): real auth in memory. Separate from the database.
//   "database" (DATABASE_URL set, and local mode is not selected): users, sessions, media metadata,
//                  collections, and publishing cycles are stored in PostgreSQL. In normal development and production,
//                  media bytes are stored only in the explicitly selected private S3 environment.
//                  A database error stays an error. Nothing is copied into memory.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MediaServices, MediaStorageDestination, RequestContext } from "./context.ts";
import { AppError } from "./errors.ts";
import type { Environment } from "./environment.ts";
import { MemoryRepository } from "./memory-repository.ts";
import type { Repository } from "./repository.ts";
import { DEMO_USER_ID, seedDemoData } from "./demo-data.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "./auth/auth-service.ts";
import { MemoryAuthRepository } from "./auth/memory-auth-repository.ts";
import { MemoryEmailOutbox, createEmailSetup } from "./auth/email.ts";
import { createRenderScheduler, type RenderScheduler } from "./render/export-service.ts";
import type { AuthRepository } from "./auth/auth-repository.ts";
import type { UserRole } from "./auth/auth-repository.ts";
import { InMemoryRateLimiter } from "./auth/rate-limiter.ts";
import { readSessionToken } from "./auth/tokens.ts";
import { readPageCookieHeader } from "./auth/page-cookies.ts";
import type { ScryptParams } from "./auth/password.ts";
import { LocalDiskMediaStorage, UnavailableDiskStorage } from "./storage/local-disk-storage.ts";
import { detectProbe, detectThumbnailMaker } from "./storage/media-inspection.ts";
import { MemoryMediaStorage } from "./storage/memory-storage.ts";
import { S3Client } from "@aws-sdk/client-s3";
import { S3MediaStorage } from "./storage/s3-storage.ts";
import { readMediaStorageConfiguration } from "./storage/storage-config.ts";
import { createPrismaClient } from "./prisma/create-client.ts";
import { PrismaAuthRepository } from "./prisma/prisma-auth-repository.ts";
import { PrismaRepository } from "./prisma/prisma-repository.ts";
import type { PrismaClientLike } from "./prisma/prisma-client-like.ts";
import { AuthTokenInstagramOAuthStateStore, type InstagramOAuthStateStore } from "./instagram/oauth-state-store.ts";
import { createConfiguredTemporaryMediaAccessAdapter } from "./storage/temporary-media-access.ts";
import { AdminDataService } from "./admin/data-service.ts";
import { PrismaAdminDataRepository } from "./admin/data-repository.ts";

export type RuntimeMode = "demo" | "unconfigured" | "local" | "database";
export type EmailDelivery = "ses" | "nodemailer" | "outbox" | "unavailable";
type DatabaseConnector = (connectionString: string) => Promise<PrismaClientLike>;
type DatabaseServices = { auth: PrismaAuthRepository; content: PrismaRepository; adminData: AdminDataService };

export interface Runtime {
  mode: RuntimeMode;
  repo: Repository;
  /** Returns the signed-in user's id, or null. Demo mode has one fixed sample user. */
  currentUserId: (request?: Request) => Promise<string | null>;
  /** Fresh session validation plus persisted role lookup. Missing in custom runtimes fails admin checks closed. */
  currentPrincipal?: (request?: Request) => Promise<{ userId: string; role: UserRole } | null>;
  newId: () => string;
  now: () => Date;
  /** Upload services, or missing when uploads are unavailable (unconfigured mode). */
  media?: () => Promise<MediaServices | null>;
  /** Present when registration and login are available (local memory, or the database). */
  auth?: AuthService;
  /** Local mode only: the "emails" that would have been sent (no provider is invoked). */
  outbox?: MemoryEmailOutbox;
  /** "unavailable" means no email is sent and none is pretended. */
  emailDelivery?: EmailDelivery;
  /** In-process execution queue. Render job records are persisted by the repository in database mode. */
  renders?: RenderScheduler;
  /** One-use OAuth state backed by AuthToken (database mode) or memory (local mode). */
  instagramOAuthStates?: InstagramOAuthStateStore;
  publishingMediaAccess?: import("./storage/temporary-media-access.ts").TemporaryMediaAccessAdapter;
  /** Database-backed, read-only cross-user Admin data. Absent in memory/demo modes by design. */
  adminData?: () => Promise<AdminDataService>;
  /** Server-side mail provider used only by API routes; values are never passed to client components. */
  emailSender?: import("./auth/email.ts").EmailSender;
  emailConfigurationError?: import("./auth/email.ts").EmailConfigurationError;
}
/** Default technical cap for one upload while files are buffered in memory (development only). */
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** A repository that refuses every call with a clear 503, so "unconfigured" can never silently work on fake data. */
function unavailableRepository(): Repository {
  return new Proxy({}, {
    get: () => () => { throw new AppError(503, "not_configured", "The database is not connected yet."); },
  }) as Repository;
}

let testOverride: Runtime | null = null;
export const setRuntimeForTests = (runtime: Runtime | null): void => { testOverride = runtime; };

type GlobalWithDemo = typeof globalThis & { __clipforgeDemoRepo?: MemoryRepository; __clipforgeDemoMedia?: Promise<MediaServices>; __clipforgeDemoRenders?: RenderScheduler; __clipforgeLocalRuntime?: Runtime; __clipforgeDatabaseRuntime?: Runtime; __clipforgeMissingDatabaseLogged?: boolean };
let databaseConnectorForTests: DatabaseConnector | null = null;
/** Tests use this to simulate a database that refuses the connection. It never selects the memory auth repository. */
export function setDatabaseConnectorForTests(connector: DatabaseConnector | null): void {
  databaseConnectorForTests = connector;
  delete (globalThis as GlobalWithDemo).__clipforgeDatabaseRuntime;
}

const databaseUnavailable = (): AppError => new AppError(503, "database_unavailable", "The database could not confirm that operation. It may not have been saved; check again before retrying.");
const complimentaryAccessSetupRequired = (): AppError => new AppError(503, "complimentary_access_setup_required", "The application's database does not expose the complimentary access schema. Confirm DATABASE_URL targets the database whose migration status you checked; if it does, review that database's schema and permissions.");
const adminSuspensionSetupRequired = (): AppError => new AppError(503, "admin_user_suspension_setup_required", "User suspension is unavailable until its reviewed database migration is applied.");
const DATABASE_RETRY_DELAY_MS = 5_000;

function isComplimentaryAccessSchemaUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { table?: unknown; column?: unknown; modelName?: unknown } };
  if (candidate.code !== "P2021" && candidate.code !== "P2022") return false;
  const target = `${String(candidate.meta?.table ?? "")} ${String(candidate.meta?.column ?? "")} ${String(candidate.meta?.modelName ?? "")}`.toLowerCase();
  return target.includes("complimentaryaccessgrant") || target.includes("complimentaryaccessevent");
}

function isAdminSuspensionSchemaUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { table?: unknown; column?: unknown; modelName?: unknown } };
  if (candidate.code !== "P2021" && candidate.code !== "P2022") return false;
  const target = `${String(candidate.meta?.table ?? "")} ${String(candidate.meta?.column ?? "")} ${String(candidate.meta?.modelName ?? "")}`.toLowerCase();
  return target.includes("usersuspension");
}

function protectedAdminDataError(error: unknown): AppError | null {
  if (isComplimentaryAccessSchemaUnavailable(error)) return complimentaryAccessSetupRequired();
  if (isAdminSuspensionSchemaUnavailable(error)) return adminSuspensionSetupRequired();
  return null;
}

function sanitizedDatabaseCategory(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const name = typeof value?.name === "string" ? value.name : "";
  if (/^P100\d{1,2}$/.test(code) || /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|57P01)$/.test(code)) return "connection";
  if (code === "P2021" || code === "P2022") return "schema";
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || name === "ModuleNotFoundError") return "prisma_client_load";
  return "database_operation";
}

function logDatabaseEvent(event: string, operation: string, error?: unknown, category?: string, environment?: string): void {
  const value = error as { code?: unknown; name?: unknown } | null;
  const errorName = typeof value?.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.name) ? value.name : undefined;
  const errorCode = typeof value?.code === "string" && /^[A-Z0-9_]{1,32}$/.test(value.code) ? value.code : undefined;
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    environment: environment ?? (process.env["NODE_ENV"] === "production" ? "production" : "development"),
    runtimeMode: event === "database_runtime_unconfigured" ? "unconfigured" : "postgres",
    operation,
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(category || error !== undefined ? { errorCategory: category ?? sanitizedDatabaseCategory(error) } : {}),
  };
  const write = event === "database_connection_success" ? console.info : console.error;
  write(JSON.stringify(entry));
}

function guardRepository(inner: Repository): Repository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.catch((error: unknown) => { if (error instanceof AppError) throw error; logDatabaseEvent("database_query_failed", `repository.${String(prop)}`, error); throw protectedAdminDataError(error) ?? databaseUnavailable(); }) : result;
        } catch (error) { if (error instanceof AppError) throw error; logDatabaseEvent("database_query_failed", `repository.${String(prop)}`, error); throw protectedAdminDataError(error) ?? databaseUnavailable(); }
      };
    },
  }) as Repository;
}

function guardAdminData(inner: AdminDataService): AdminDataService {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.catch((error: unknown) => { if (error instanceof AppError) throw error; logDatabaseEvent("database_query_failed", `admin.${String(prop)}`, error); throw protectedAdminDataError(error) ?? databaseUnavailable(); }) : result;
        } catch (error) { if (error instanceof AppError) throw error; logDatabaseEvent("database_query_failed", `admin.${String(prop)}`, error); throw protectedAdminDataError(error) ?? databaseUnavailable(); }
      };
    },
  });
}

function delegateRepository(load: () => Promise<Repository>): Repository {
  return new Proxy({} as Repository, {
    get(_target, prop) {
      return (...args: unknown[]) => load().catch(() => { throw databaseUnavailable(); }).then((repo) => {
        const fn = (repo as unknown as Record<PropertyKey, unknown>)[prop];
        if (typeof fn !== "function") throw databaseUnavailable();
        return (fn as (...a: unknown[]) => unknown).apply(repo, args);
      });
    },
  });
}

function guardAuthRepository(load: () => Promise<DatabaseServices>): AuthRepository {
  const run = async <T>(operation: string, work: (auth: AuthRepository) => Promise<T>): Promise<T> => {
    let auth: AuthRepository;
    try { auth = (await load()).auth; }
    catch { throw databaseUnavailable(); }
    try { return await work(auth); }
    catch (error) {
      if (error instanceof AppError) throw error;
      logDatabaseEvent("database_query_failed", operation, error);
      throw databaseUnavailable();
    }
  };
  return {
    createUser: (user) => run("auth.createUser", (auth) => auth.createUser(user)),
    getUserByEmail: (email) => run("auth.getUserByEmail", (auth) => auth.getUserByEmail(email)),
    getUserById: (userId) => run("auth.getUserById", (auth) => auth.getUserById(userId)),
    isUserSuspended: (userId) => run("auth.isUserSuspended", (auth) => auth.isUserSuspended(userId)),
    markEmailVerified: (userId, at) => run("auth.markEmailVerified", (auth) => auth.markEmailVerified(userId, at)),
    setPasswordHash: (userId, passwordHash) => run("auth.setPasswordHash", (auth) => auth.setPasswordHash(userId, passwordHash)),
    createSession: (session) => run("auth.createSession", (auth) => auth.createSession(session)),
    getSessionByTokenHash: (tokenHash) => run("auth.getSessionByTokenHash", (auth) => auth.getSessionByTokenHash(tokenHash)),
    touchSession: (sessionId, lastUsedAt) => run("auth.touchSession", (auth) => auth.touchSession(sessionId, lastUsedAt)),
    revokeSession: (sessionId, at) => run("auth.revokeSession", (auth) => auth.revokeSession(sessionId, at)),
    revokeAllSessionsForUser: (userId, at) => run("auth.revokeAllSessionsForUser", (auth) => auth.revokeAllSessionsForUser(userId, at)),
    createAuthToken: (token) => run("auth.createAuthToken", (auth) => auth.createAuthToken(token)),
    getAuthToken: (kind, tokenHash) => run("auth.getAuthToken", (auth) => auth.getAuthToken(kind, tokenHash)),
    consumeAuthToken: (kind, tokenHash, now) => run("auth.consumeAuthToken", (auth) => auth.consumeAuthToken(kind, tokenHash, now)),
    completePasswordReset: (input) => run("auth.completePasswordReset", (auth) => auth.completePasswordReset(input)),
    invalidateAuthTokens: (userId, kind, now) => run("auth.invalidateAuthTokens", (auth) => auth.invalidateAuthTokens(userId, kind, now)),
    getGoogleIdentityBySub: (googleSub) => run("auth.getGoogleIdentityBySub", (auth) => auth.getGoogleIdentityBySub(googleSub)),
    getGoogleIdentityByUserId: (userId) => run("auth.getGoogleIdentityByUserId", (auth) => auth.getGoogleIdentityByUserId(userId)),
    linkGoogleIdentity: (identity) => run("auth.linkGoogleIdentity", (auth) => auth.linkGoogleIdentity(identity)),
    createGoogleUser: (user, identity) => run("auth.createGoogleUser", (auth) => auth.createGoogleUser(user, identity)),
  };
}

/**
 * DATABASE MODE: accounts, sessions, media metadata, collections, and publishing cycles use PostgreSQL.
 * Email uses EMAIL_PROVIDER. Unset means no message is sent and normal unverified accounts follow the existing local policy.
 * "outbox" keeps messages in memory for local development. SES and Nodemailer are initialized only when selected.
 * Normal database mode uses the explicitly configured S3 provider. An explicit local-disk provider is limited to
 * non-production development/test use. A database error stays an error; missing S3 config never falls back to disk or memory.
 */
export function createDatabaseRuntime(connectionString: string, connect: DatabaseConnector = createPrismaClient, opts: { baseUrl?: string; scrypt?: ScryptParams; now?: () => Date; mediaDir?: string | null; storageEnvironment?: Environment; email?: ReturnType<typeof createEmailSetup> } = {}): Runtime {
  const now = opts.now ?? (() => new Date());
  let ready: Promise<DatabaseServices> | null = null;
  let retryAfter = 0;
  const load = (): Promise<DatabaseServices> => {
    if (!ready) {
      if (Date.now() < retryAfter) return Promise.reject(databaseUnavailable());
      let current: Promise<DatabaseServices>;
      logDatabaseEvent("database_connection_check_started", "runtime.initialize");
      current = (async () => {
        let db: PrismaClientLike | null = null;
        try {
          db = await connect(connectionString);
          await db.$queryRaw`SELECT 1`;
          logDatabaseEvent("database_connection_success", "runtime.initialize");
          return { auth: new PrismaAuthRepository(db), content: new PrismaRepository(db, now), adminData: new AdminDataService(new PrismaAdminDataRepository(db), now) };
        } catch (error) {
          logDatabaseEvent("database_connection_failed", "runtime.initialize", error);
          if (db?.$disconnect) await db.$disconnect().catch(() => undefined);
          throw error;
        }
      })().catch((error: unknown) => {
        if (ready === current) {
          ready = null; // A failed first connection must not poison this serverless instance forever.
          retryAfter = Date.now() + DATABASE_RETRY_DELAY_MS; // Bound retries and diagnostic volume while a database is unavailable.
        }
        throw error;
      });
      ready = current;
    }
    return ready;
  };
  const authRepo: AuthRepository = guardAuthRepository(load);
  const email = opts.email ?? createEmailSetup();
  const config = { ...DEFAULT_AUTH_CONFIG(opts.baseUrl ?? process.env["CLIPFORGE_BASE_URL"] ?? "http://localhost:3000"), requireVerifiedEmail: email.requireVerifiedEmail, ...(opts.scrypt ? { scrypt: opts.scrypt } : {}) };
  const auth = new AuthService({ repo: authRepo, email: email.sender, limiter: new InMemoryRateLimiter(), now, newId: () => randomUUID(), config });
  const instagramOAuthStates = new AuthTokenInstagramOAuthStateStore(authRepo, () => randomUUID());
  const content = guardRepository(delegateRepository(async () => (await load()).content));
  const publishingMediaAccess = createConfiguredTemporaryMediaAccessAdapter();
  return {
    mode: "database", repo: content, auth, outbox: email.outbox, emailDelivery: email.delivery, emailSender: email.sender, ...(email.configurationError ? { emailConfigurationError: email.configurationError } : {}), renders: createRenderScheduler(), instagramOAuthStates, ...(publishingMediaAccess ? { publishingMediaAccess } : {}), adminData: async () => guardAdminData((await load()).adminData),
    now, newId: () => randomUUID(),
    // A supplied mediaDir is an explicit legacy test/development fallback. Normal app runtime
    // always uses the validated provider selected in the environment; it never falls back silently.
    media: opts.mediaDir !== undefined
      ? (opts.storageEnvironment ?? process.env)["NODE_ENV"] === "production"
        ? configuredDatabaseMediaServices({ ...(opts.storageEnvironment ?? process.env), CLIPFORGE_STORAGE_PROVIDER: "invalid" })
        : databaseMediaServices(opts.mediaDir)
      : configuredDatabaseMediaServices(opts.storageEnvironment ?? process.env),
    currentUserId: async (request) => auth.getSessionUserId(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
    currentPrincipal: async (request) => auth.getSessionPrincipal(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
  };
}

const MEDIA_FOLDER_UNAVAILABLE = "The private media folder could not be opened. Nothing was saved in memory.";
const MEDIA_FOLDER_UNSET = "The private media folder is not configured. Nothing was saved in memory.";
const MEDIA_FOLDER_PUBLIC = "The private media folder must be outside the web site folders. Nothing was saved in memory.";

/** Explicit local test/development fallback. A missing or unusable folder is an error, never memory storage. */
export function databaseMediaServices(dir: string | null | undefined): () => Promise<MediaServices> {
  let ready: Promise<MediaServices> | null = null;
  return () => (ready ??= openDatabaseMedia(dir));
}

/** Main database-mode provider selection. Invalid/missing config produces unavailable storage, never another provider. */
function configuredDatabaseMediaServices(env: Environment): () => Promise<MediaServices> {
  let ready: Promise<MediaServices> | null = null;
  return () => (ready ??= openConfiguredDatabaseMedia(env));
}

async function openConfiguredDatabaseMedia(env: Environment): Promise<MediaServices> {
  const configuredMb = Number(env["CLIPFORGE_MAX_UPLOAD_MB"]);
  const maxUploadBytes = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES;
  const probe = await detectProbe();
  const thumbnail = await detectThumbnailMaker();
  const config = readMediaStorageConfiguration(env);
  if (!config.ok) return { storage: new UnavailableDiskStorage(), probe, thumbnail, maxUploadBytes, unavailable: config.reason };
  if (config.provider === "local-disk") {
    try { return { storage: await LocalDiskMediaStorage.create(path.resolve(/*turbopackIgnore: true*/ config.directory)), destination: localDiskDestination(), probe, thumbnail, maxUploadBytes }; }
    catch { return { storage: new UnavailableDiskStorage(), destination: localDiskDestination(), probe, thumbnail, maxUploadBytes, unavailable: "The explicitly selected private test media folder is unavailable." }; }
  }
  const client = new S3Client({ region: config.region, credentials: config.credentials });
  return { storage: new S3MediaStorage(client, config.bucket), destination: { provider: "s3", providerLabel: "AWS S3", environment: config.environment, bucket: config.bucket, region: config.region, privacy: "Private" }, probe, thumbnail, maxUploadBytes };
}

const localDiskDestination = (): MediaStorageDestination => ({ provider: "local-disk", providerLabel: "Local disk", environment: "development", locationLabel: "Private application storage", privacy: "Private" });

async function openDatabaseMedia(dir: string | null | undefined): Promise<MediaServices> {
  const configuredMb = Number(process.env["CLIPFORGE_MAX_UPLOAD_MB"]);
  const maxUploadBytes = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES;
  const probe = await detectProbe();
  const thumbnail = await detectThumbnailMaker();
  const trimmed = dir?.trim() ?? "";
  if (!trimmed) return { storage: new UnavailableDiskStorage(), probe, thumbnail, maxUploadBytes, unavailable: MEDIA_FOLDER_UNSET };
  try {
    return { storage: await LocalDiskMediaStorage.create(path.resolve(/*turbopackIgnore: true*/ trimmed)), destination: localDiskDestination(), probe, thumbnail, maxUploadBytes };
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "The media folder must not be inside a web-served folder." ? MEDIA_FOLDER_PUBLIC : MEDIA_FOLDER_UNAVAILABLE;
    return { storage: new UnavailableDiskStorage(), destination: localDiskDestination(), probe, thumbnail, maxUploadBytes, unavailable };
  }
}

/**
 * Demo and local mode only. File bytes go to server MEMORY unless CLIPFORGE_LOCAL_MEDIA_DIR is set.
 * Database mode does not use this function.
 */
function demoMediaServices(): Promise<MediaServices> {
  const holder = globalThis as GlobalWithDemo;
  holder.__clipforgeDemoMedia ??= (async () => {
    const dir = process.env["CLIPFORGE_LOCAL_MEDIA_DIR"];
    const storage = dir ? await LocalDiskMediaStorage.create(path.resolve(dir)) : new MemoryMediaStorage();
    const configuredMb = Number(process.env["CLIPFORGE_MAX_UPLOAD_MB"]);
    return { storage, destination: dir ? localDiskDestination() : { provider: "memory", providerLabel: "In-memory demo storage", environment: "development", locationLabel: "This server process", privacy: "Private" }, probe: await detectProbe(), thumbnail: await detectThumbnailMaker(), maxUploadBytes: Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES };
  })();
  return holder.__clipforgeDemoMedia;
}

/**
 * LOCAL MODE (CLIPFORGE_LOCAL_AUTH=true): real registration, email confirmation, login and sessions - but everything lives in
 * server MEMORY and disappears on restart, and "emails" go to an in-memory outbox. Data starts empty.
 * It exists so the real auth flow can be developed and tested without a database. It is not a production mode.
 */
export function createLocalRuntime(opts: { baseUrl?: string; scrypt?: ScryptParams; now?: () => Date; media?: () => Promise<MediaServices | null> } = {}): Runtime {
  const repo = new MemoryRepository(); const outbox = new MemoryEmailOutbox(); const now = opts.now ?? (() => new Date());
  const authRepository = new MemoryAuthRepository();
  const config = { ...DEFAULT_AUTH_CONFIG(opts.baseUrl ?? "http://localhost:3000"), ...(opts.scrypt ? { scrypt: opts.scrypt } : {}) };
  const auth = new AuthService({ repo: authRepository, email: outbox, limiter: new InMemoryRateLimiter(), now, newId: () => randomUUID(), config });
  return {
    mode: "local", repo, auth, outbox, emailDelivery: "outbox", renders: createRenderScheduler(), instagramOAuthStates: new AuthTokenInstagramOAuthStateStore(authRepository, () => randomUUID()), now, newId: () => randomUUID(), media: opts.media ?? demoMediaServices,
    // The cookie comes from the request when we have one (API routes); pages read it from Next.js's request headers.
    currentUserId: async (request) => auth.getSessionUserId(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
    currentPrincipal: async (request) => auth.getSessionPrincipal(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
  };
}

export function getRuntime(env: Environment = process.env): Runtime {
  if (testOverride) return testOverride;
  if (env["CLIPFORGE_LOCAL_AUTH"] === "true" && env["NODE_ENV"] !== "production") {
    const holder = globalThis as GlobalWithDemo;
    holder.__clipforgeLocalRuntime ??= createLocalRuntime({ baseUrl: env["CLIPFORGE_BASE_URL"] ?? "http://localhost:3000" });
    return holder.__clipforgeLocalRuntime;
  }
  const databaseUrl = env["DATABASE_URL"]?.trim();
  if (databaseUrl) {
    const holder = globalThis as GlobalWithDemo;
    holder.__clipforgeDatabaseRuntime ??= createDatabaseRuntime(databaseUrl, databaseConnectorForTests ?? createPrismaClient, { storageEnvironment: env });
    return holder.__clipforgeDatabaseRuntime;
  }
  if (env["NODE_ENV"] === "production") {
    const holder = globalThis as GlobalWithDemo;
    if (!holder.__clipforgeMissingDatabaseLogged) {
      holder.__clipforgeMissingDatabaseLogged = true;
      logDatabaseEvent("database_runtime_unconfigured", "runtime.configuration", undefined, "missing_configuration", "production");
    }
  }
  if (env["CLIPFORGE_DEMO_MODE"] === "true" && env["NODE_ENV"] !== "production") {
    // Kept on globalThis so dev-server reloads do not recreate the sample data on every edit.
    const holder = globalThis as GlobalWithDemo;
    if (!holder.__clipforgeDemoRepo) { holder.__clipforgeDemoRepo = new MemoryRepository(); seedDemoData(holder.__clipforgeDemoRepo, new Date()); }
    let counter = 0;
    return { mode: "demo", repo: holder.__clipforgeDemoRepo, currentUserId: async () => DEMO_USER_ID, currentPrincipal: async () => ({ userId: DEMO_USER_ID, role: "user" }), media: demoMediaServices, renders: holder.__clipforgeDemoRenders ??= createRenderScheduler(), newId: () => `demo-${Date.now().toString(36)}-${++counter}`, now: () => new Date() };
  }
  return { mode: "unconfigured", repo: unavailableRepository(), currentUserId: async () => null, currentPrincipal: async () => null, newId: () => { throw new AppError(503, "not_configured", "Not configured."); }, now: () => new Date() };
}

export async function buildContext(runtime: Runtime = getRuntime(), request?: Request): Promise<RequestContext> {
  const media = runtime.media ? await runtime.media() : null;
  return {
    userId: await runtime.currentUserId(request), now: runtime.now(), repo: runtime.repo, newId: runtime.newId, ...(runtime.renders ? { renders: runtime.renders } : {}), ...(runtime.publishingMediaAccess ? { publishingMediaAccess: runtime.publishingMediaAccess } : {}),
    // Meta's maintained Reels publishing sample documents cover_url; real account delivery is not live-verified.
    config: { coverSupport: "supported" },
    ...(media ? { media } : {}),
    ...(runtime.mode === "database" && media && !media.unavailable && media.storage.kind !== "memory" ? { durableMediaImports: true } : {}),
  };
}
