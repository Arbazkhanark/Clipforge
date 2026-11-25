import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextMediaVerificationJob } from "../src/server/media-verification.ts";
import { assertWorkerDatabaseIdentity } from "../src/server/workers/database-identity-guard.ts";
import { runContinuousWorker } from "../src/server/workers/continuous-worker.ts";

assertWorkerDatabaseIdentity();
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Media verification worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable) throw new Error("Private media storage is unavailable.");
if (!media.probe) process.stderr.write("Media verification worker has no ffprobe; uploads will remain incomplete until it is installed.\n");
const workerId = `media-verification-${randomUUID()}`;
const context = { userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" as const }, media };
process.stdout.write("Media verification worker started.\n");
await runContinuousWorker({
  runOnce: () => runNextMediaVerificationJob({ ...context, now: new Date() }, workerId),
  idleDelayMs: (status) => status === "idle" ? 2_000 : 0,
  dispose: () => runtime.dispose?.() ?? Promise.resolve(),
  onShutdownTimeout: () => process.stderr.write("Media verification worker shutdown timed out; its lease will expire for safe recovery.\n"),
});
process.stdout.write("Media verification worker stopped.\n");
