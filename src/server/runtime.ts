// The ONE place that decides which adapters the app uses. Everything else asks for a RequestContext.
//
// MODES (honest by design):
//   "unconfigured" (default): there is no real authentication or database yet, so nobody is signed in,
//                  data pages show a "sign in" message and API calls answer 401/503. Nothing is faked.
//   "demo" (CLIPFORGE_DEMO_MODE=true): an in-memory repository with clearly labelled SAMPLE data and one
//                  built-in sample user. Data resets when the server restarts. For local development only.
//   "local" (CLIPFORGE_LOCAL_AUTH=true, not production): real auth in memory. Separate from the database.
//   "database" (DATABASE_URL set, and local mode is not selected): users, sessions, media metadata,
//                  collections, and publishing cycles are stored in PostgreSQL. File bytes are not.
//                  A database error stays an error. Nothing is copied into memory.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { MediaServices, RequestContext } from "./context.ts";
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
import { createPrismaClient } from "./prisma/create-client.ts";
import { PrismaAuthRepository } from "./prisma/prisma-auth-repository.ts";
import { PrismaRepository } from "./prisma/prisma-repository.ts";
import type { PrismaClientLike } from "./prisma/prisma-client-like.ts";
import { AuthTokenInstagramOAuthStateStore, type InstagramOAuthStateStore } from "./instagram/oauth-state-store.ts";
import { createConfiguredTemporaryMediaAccessAdapter } from "./storage/temporary-media-access.ts";
import { AdminDataService } from "./admin/data-service.ts";
import { PrismaAdminDataRepository } from "./admin/data-repository.ts";

export type RuntimeMode = "demo" | "unconfigured" | "local" | "database";
export type EmailDelivery = "outbox" | "unavailable";
type DatabaseConnector = (connectionString: string) => Promise<PrismaClientLike>;

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
  /** Local mode only: the "emails" that would have been sent (there is no email provider). */
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

type GlobalWithDemo = typeof globalThis & { __clipforgeDemoRepo?: MemoryRepository; __clipforgeDemoMedia?: Promise<MediaServices>; __clipforgeDemoRenders?: RenderScheduler; __clipforgeLocalRuntime?: Runtime; __clipforgeDatabaseRuntime?: Runtime };
let databaseConnectorForTests: DatabaseConnector | null = null;
/** Tests use this to simulate a database that refuses the connection. It never selects the memory auth repository. */
export function setDatabaseConnectorForTests(connector: DatabaseConnector | null): void {
  databaseConnectorForTests = connector;
  delete (globalThis as GlobalWithDemo).__clipforgeDatabaseRuntime;
}

const databaseUnavailable = (): AppError => new AppError(503, "database_unavailable", "The database could not complete that request. Nothing was saved in memory.");

function guardCall<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => { if (error instanceof AppError) throw error; throw databaseUnavailable(); });
}

function guardRepository(inner: Repository): Repository {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          return result instanceof Promise ? result.catch((error: unknown) => { if (error instanceof AppError) throw error; throw databaseUnavailable(); }) : result;
        } catch (error) { if (error instanceof AppError) throw error; throw databaseUnavailable(); }
      };
    },
  }) as Repository;
}

function delegateRepository(load: () => Promise<Repository>): Repository {
  return new Proxy({} as Repository, {
    get(_target, prop) {
      return (...args: unknown[]) => load().then((repo) => {
        const fn = (repo as unknown as Record<PropertyKey, unknown>)[prop];
        if (typeof fn !== "function") throw databaseUnavailable();
        return (fn as (...a: unknown[]) => unknown).apply(repo, args);
      });
    },
  });
}

function guardAuthRepository(inner: AuthRepository): AuthRepository {
  const run = <T>(work: () => Promise<T>): Promise<T> => guardCall(work);
  return {
    createUser: (user) => run(() => inner.createUser(user)),
    getUserByEmail: (email) => run(() => inner.getUserByEmail(email)),
    getUserById: (userId) => run(() => inner.getUserById(userId)),
    markEmailVerified: (userId, at) => run(() => inner.markEmailVerified(userId, at)),
    setPasswordHash: (userId, passwordHash) => run(() => inner.setPasswordHash(userId, passwordHash)),
    createSession: (session) => run(() => inner.createSession(session)),
    getSessionByTokenHash: (tokenHash) => run(() => inner.getSessionByTokenHash(tokenHash)),
    touchSession: (sessionId, lastUsedAt) => run(() => inner.touchSession(sessionId, lastUsedAt)),
    revokeSession: (sessionId, at) => run(() => inner.revokeSession(sessionId, at)),
    revokeAllSessionsForUser: (userId, at) => run(() => inner.revokeAllSessionsForUser(userId, at)),
    createAuthToken: (token) => run(() => inner.createAuthToken(token)),
    consumeAuthToken: (kind, tokenHash, now) => run(() => inner.consumeAuthToken(kind, tokenHash, now)),
    completePasswordReset: (input) => run(() => inner.completePasswordReset(input)),
    invalidateAuthTokens: (userId, kind, now) => run(() => inner.invalidateAuthTokens(userId, kind, now)),
    getGoogleIdentityBySub: (googleSub) => run(() => inner.getGoogleIdentityBySub(googleSub)),
    getGoogleIdentityByUserId: (userId) => run(() => inner.getGoogleIdentityByUserId(userId)),
    linkGoogleIdentity: (identity) => run(() => inner.linkGoogleIdentity(identity)),
    createGoogleUser: (user, identity) => run(() => inner.createGoogleUser(user, identity)),
  };
}

/**
 * DATABASE MODE: accounts, sessions, media metadata, collections, and publishing cycles use PostgreSQL.
 * Email uses CLIPFORGE_EMAIL_PROVIDER. Unset means no message is sent and unverified accounts can still sign in.
 * "outbox" keeps messages in memory for local development. SMTP placeholders do not connect to a provider.
 * Video and image bytes go only to CLIPFORGE_LOCAL_MEDIA_DIR. They are never written to PostgreSQL or to memory.
 * A database error stays an error. If the private folder cannot be used, uploads fail instead of using memory.
 */
export function createDatabaseRuntime(connectionString: string, connect: DatabaseConnector = createPrismaClient, opts: { baseUrl?: string; scrypt?: ScryptParams; now?: () => Date; mediaDir?: string | null; email?: ReturnType<typeof createEmailSetup> } = {}): Runtime {
  const now = opts.now ?? (() => new Date());
  const ready = connect(connectionString).then((db) => ({ auth: new PrismaAuthRepository(db), content: new PrismaRepository(db, now), adminData: new AdminDataService(new PrismaAdminDataRepository(db), now) }));
  void ready.catch(() => undefined);
  const authRepo: AuthRepository = guardAuthRepository({
    createUser: async (user) => (await ready).auth.createUser(user),
    getUserByEmail: async (email) => (await ready).auth.getUserByEmail(email),
    getUserById: async (userId) => (await ready).auth.getUserById(userId),
    markEmailVerified: async (userId, at) => (await ready).auth.markEmailVerified(userId, at),
    setPasswordHash: async (userId, passwordHash) => (await ready).auth.setPasswordHash(userId, passwordHash),
    createSession: async (session) => (await ready).auth.createSession(session),
    getSessionByTokenHash: async (tokenHash) => (await ready).auth.getSessionByTokenHash(tokenHash),
    touchSession: async (sessionId, lastUsedAt) => (await ready).auth.touchSession(sessionId, lastUsedAt),
    revokeSession: async (sessionId, at) => (await ready).auth.revokeSession(sessionId, at),
    revokeAllSessionsForUser: async (userId, at) => (await ready).auth.revokeAllSessionsForUser(userId, at),
    createAuthToken: async (token) => (await ready).auth.createAuthToken(token),
    consumeAuthToken: async (kind, tokenHash, now) => (await ready).auth.consumeAuthToken(kind, tokenHash, now),
    completePasswordReset: async (input) => (await ready).auth.completePasswordReset(input),
    invalidateAuthTokens: async (userId, kind, now) => (await ready).auth.invalidateAuthTokens(userId, kind, now),
    getGoogleIdentityBySub: async (googleSub) => (await ready).auth.getGoogleIdentityBySub(googleSub),
    getGoogleIdentityByUserId: async (userId) => (await ready).auth.getGoogleIdentityByUserId(userId),
    linkGoogleIdentity: async (identity) => (await ready).auth.linkGoogleIdentity(identity),
    createGoogleUser: async (user, identity) => (await ready).auth.createGoogleUser(user, identity),
  });
  const email = opts.email ?? createEmailSetup();
  const config = { ...DEFAULT_AUTH_CONFIG(opts.baseUrl ?? process.env["CLIPFORGE_BASE_URL"] ?? "http://localhost:3000"), requireVerifiedEmail: email.requireVerifiedEmail, ...(opts.scrypt ? { scrypt: opts.scrypt } : {}) };
  const auth = new AuthService({ repo: authRepo, email: email.sender, limiter: new InMemoryRateLimiter(), now, newId: () => randomUUID(), config });
  const instagramOAuthStates = new AuthTokenInstagramOAuthStateStore(authRepo, () => randomUUID());
  const content = guardRepository(delegateRepository(async () => (await ready).content));
  const publishingMediaAccess = createConfiguredTemporaryMediaAccessAdapter();
  return {
    mode: "database", repo: content, auth, outbox: email.outbox, emailDelivery: email.delivery, renders: createRenderScheduler(), instagramOAuthStates, ...(publishingMediaAccess ? { publishingMediaAccess } : {}), adminData: async () => (await ready).adminData, now, newId: () => randomUUID(),
    media: databaseMediaServices(opts.mediaDir === undefined ? process.env["CLIPFORGE_LOCAL_MEDIA_DIR"] : opts.mediaDir),
    currentUserId: async (request) => auth.getSessionUserId(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
    currentPrincipal: async (request) => auth.getSessionPrincipal(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
  };
}

const MEDIA_FOLDER_UNAVAILABLE = "The private media folder could not be opened. Nothing was saved in memory.";
const MEDIA_FOLDER_UNSET = "The private media folder is not configured. Nothing was saved in memory.";
const MEDIA_FOLDER_PUBLIC = "The private media folder must be outside the web site folders. Nothing was saved in memory.";

/** Database mode only. A missing or unusable folder is an error, never memory storage. */
export function databaseMediaServices(dir: string | null | undefined): () => Promise<MediaServices> {
  let ready: Promise<MediaServices> | null = null;
  return () => (ready ??= openDatabaseMedia(dir));
}

async function openDatabaseMedia(dir: string | null | undefined): Promise<MediaServices> {
  const configuredMb = Number(process.env["CLIPFORGE_MAX_UPLOAD_MB"]);
  const maxUploadBytes = Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES;
  const probe = await detectProbe();
  const thumbnail = await detectThumbnailMaker();
  const trimmed = dir?.trim() ?? "";
  if (!trimmed) return { storage: new UnavailableDiskStorage(), probe, thumbnail, maxUploadBytes, unavailable: MEDIA_FOLDER_UNSET };
  try {
    return { storage: await LocalDiskMediaStorage.create(path.resolve(/*turbopackIgnore: true*/ trimmed)), probe, thumbnail, maxUploadBytes };
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "The media folder must not be inside a web-served folder." ? MEDIA_FOLDER_PUBLIC : MEDIA_FOLDER_UNAVAILABLE;
    return { storage: new UnavailableDiskStorage(), probe, thumbnail, maxUploadBytes, unavailable };
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
    return { storage, probe: await detectProbe(), thumbnail: await detectThumbnailMaker(), maxUploadBytes: Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES };
  })();
  return holder.__clipforgeDemoMedia;
}

/**
 * LOCAL MODE (CLIPFORGE_LOCAL_AUTH=true): real registration, email confirmation, login and sessions - but everything lives in
 * server MEMORY and disappears on restart, and "emails" go to an in-memory outbox (no email provider exists). Data starts empty.
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
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl) {
    const holder = globalThis as GlobalWithDemo;
    holder.__clipforgeDatabaseRuntime ??= createDatabaseRuntime(databaseUrl, databaseConnectorForTests ?? createPrismaClient);
    return holder.__clipforgeDatabaseRuntime;
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
