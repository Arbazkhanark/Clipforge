import { randomUUID } from "node:crypto";
import { createPublishingWorker } from "../src/server/publishing/publishing-worker.ts";
import { createInstagramPublishingAdapters } from "../src/server/publishing/instagram-publishing-adapter.ts";
import { accessInstagramToken } from "../src/server/instagram/instagram-token-access.ts";
import { readInstagramTokenKey } from "../src/server/instagram/token-cipher.ts";
import { getRuntime } from "../src/server/runtime.ts";
import { HmacTemporaryMediaAccessAdapter } from "../src/server/storage/temporary-media-access.ts";
import { assertWorkerDatabaseIdentity } from "../src/server/workers/database-identity-guard.ts";
import { runContinuousWorker } from "../src/server/workers/continuous-worker.ts";

if (process.env["CLIPFORGE_PUBLISHING_ENABLED"] !== "true" || process.env["CLIPFORGE_PUBLISHING_LIVE_APPROVED"] !== "true") {
  process.stdout.write("Publishing worker disabled; both explicit opt-in flags are required.\n");
  process.exit(0);
}
assertWorkerDatabaseIdentity();
if (!process.env["DATABASE_URL"]) throw new Error("Publishing worker requires database mode.");
if (!process.env["INSTAGRAM_GRAPH_API_VERSION"]) throw new Error("Pin INSTAGRAM_GRAPH_API_VERSION before enabling publishing.");
const tokenKey = readInstagramTokenKey();
if (!tokenKey) throw new Error("Instagram token encryption configuration is unavailable.");
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Publishing worker refuses non-database runtime modes.");
if (!(runtime.publishingMediaAccess instanceof HmacTemporaryMediaAccessAdapter)) throw new Error("A configured HTTPS public-media origin and signing key are required.");
const media = await runtime.media?.();
if (!media || media.unavailable) throw new Error("Private render storage is unavailable.");
const adapters = createInstagramPublishingAdapters({
  graphApiVersion: process.env["INSTAGRAM_GRAPH_API_VERSION"],
  access: async (ownerId, accountId) => {
    const token = await accessInstagramToken({ repo: runtime.repo, ownerId, accountId, encryptionKey: tokenKey, now: runtime.now() });
    return token.status === "ready" ? { status: "ready", accessToken: token.accessToken } : { status: "unavailable" };
  },
});
const worker = createPublishingWorker({
  repo: runtime.repo,
  adapters,
  now: runtime.now,
  newId: runtime.newId,
  workerId: randomUUID(),
  enabled: true,
  requirePublicMedia: true,
  storage: media.storage,
  mediaAccess: runtime.publishingMediaAccess,
  context: { repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "supported" }, media, publishingMediaAccess: runtime.publishingMediaAccess },
});

process.stdout.write("Publishing worker enabled with official Instagram API adapter.\n");
await runContinuousWorker({
  runOnce: async () => {
    const result = await worker.runOnce();
    if (result.status !== "idle") process.stdout.write(`Publishing worker result: ${result.status}\n`);
    return result;
  },
  idleDelayMs: (result) => result.status === "idle" ? 15_000 : 2_000,
  dispose: () => runtime.dispose?.() ?? Promise.resolve(),
  onShutdownTimeout: () => process.stderr.write("Publishing worker shutdown timed out; its lease will expire for safe recovery.\n"),
});
process.stdout.write("Publishing worker stopped.\n");
