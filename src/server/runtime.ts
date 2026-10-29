// The ONE place that decides which adapters the app uses. Everything else asks for a RequestContext.
//
// MODES (honest by design):
//   "unconfigured" (default): there is no real authentication or database yet, so nobody is signed in,
//                  data pages show a "sign in" message and API calls answer 401/503. Nothing is faked.
//   "demo" (CLIPFORGE_DEMO_MODE=true): an in-memory repository with clearly labelled SAMPLE data and one
//                  built-in sample user. Data resets when the server restarts. For local development only.
// A real mode (Prisma + PostgreSQL + real sessions) will be added when those can be installed and verified.
import path from "node:path";
import type { MediaServices, RequestContext } from "./context.ts";
import { AppError } from "./errors.ts";
import { MemoryRepository } from "./memory-repository.ts";
import type { Repository } from "./repository.ts";
import { DEMO_USER_ID, seedDemoData } from "./demo-data.ts";
import { LocalDiskMediaStorage } from "./storage/local-disk-storage.ts";
import { detectProbe } from "./storage/media-inspection.ts";
import { MemoryMediaStorage } from "./storage/memory-storage.ts";

export type RuntimeMode = "demo" | "unconfigured";

export interface Runtime {
  mode: RuntimeMode;
  repo: Repository;
  /** Returns the signed-in user's id, or null. Demo mode has one fixed sample user. */
  currentUserId: () => Promise<string | null>;
  newId: () => string;
  now: () => Date;
  /** Upload services, or missing when uploads are unavailable (unconfigured mode). */
  media?: () => Promise<MediaServices | null>;
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

type GlobalWithDemo = typeof globalThis & { __clipforgeDemoRepo?: MemoryRepository; __clipforgeDemoMedia?: Promise<MediaServices> };

/**
 * Demo uploads go to server MEMORY by default. If CLIPFORGE_LOCAL_MEDIA_DIR is set they go to a private folder on disk
 * instead (files persist; records still do not, until the database exists). No cloud storage is ever used here.
 */
function demoMediaServices(): Promise<MediaServices> {
  const holder = globalThis as GlobalWithDemo;
  holder.__clipforgeDemoMedia ??= (async () => {
    const dir = process.env["CLIPFORGE_LOCAL_MEDIA_DIR"];
    const storage = dir ? await LocalDiskMediaStorage.create(path.resolve(dir)) : new MemoryMediaStorage();
    const configuredMb = Number(process.env["CLIPFORGE_MAX_UPLOAD_MB"]);
    return { storage, probe: await detectProbe(), maxUploadBytes: Number.isFinite(configuredMb) && configuredMb > 0 ? configuredMb * 1024 * 1024 : DEFAULT_MAX_UPLOAD_BYTES };
  })();
  return holder.__clipforgeDemoMedia;
}

export function getRuntime(): Runtime {
  if (testOverride) return testOverride;
  if (process.env["CLIPFORGE_DEMO_MODE"] === "true") {
    // Kept on globalThis so dev-server reloads do not recreate the sample data on every edit.
    const holder = globalThis as GlobalWithDemo;
    if (!holder.__clipforgeDemoRepo) { holder.__clipforgeDemoRepo = new MemoryRepository(); seedDemoData(holder.__clipforgeDemoRepo, new Date()); }
    let counter = 0;
    return { mode: "demo", repo: holder.__clipforgeDemoRepo, currentUserId: async () => DEMO_USER_ID, media: demoMediaServices, newId: () => `demo-${Date.now().toString(36)}-${++counter}`, now: () => new Date() };
  }
  return { mode: "unconfigured", repo: unavailableRepository(), currentUserId: async () => null, newId: () => { throw new AppError(503, "not_configured", "Not configured."); }, now: () => new Date() };
}

export async function buildContext(runtime: Runtime = getRuntime()): Promise<RequestContext> {
  return {
    userId: await runtime.currentUserId(), now: runtime.now(), repo: runtime.repo, newId: runtime.newId,
    // Whether Instagram accepts the cover is unverified in detail, so we say "unknown" until the publisher confirms.
    config: { coverSupport: "unknown" },
    ...(runtime.media ? await (async () => { const media = await runtime.media!(); return media ? { media } : {}; })() : {}),
  };
}
