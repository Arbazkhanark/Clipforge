import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextEditedMediaReplacement } from "../src/server/media-replacement-worker.ts";
import { assertWorkerDatabaseIdentity } from "../src/server/workers/database-identity-guard.ts";
import { runContinuousWorker } from "../src/server/workers/continuous-worker.ts";

assertWorkerDatabaseIdentity();
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("The edited-media replacement worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable || media.storage.kind === "memory") throw new Error("Persistent private media storage is required.");
if (!media.probe) process.stderr.write("Edited-media replacement requires ffprobe; originals will remain until verification is available.\n");
const workerId = `media-replacement-${randomUUID()}`;
process.stdout.write("Edited-media replacement worker started.\n");
await runContinuousWorker({
  runOnce: () => runNextEditedMediaReplacement({ userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" }, media }, workerId),
  idleDelayMs: (result) => result === "idle" || result === "queued_verification" ? 2_000 : 0,
  dispose: () => runtime.dispose?.() ?? Promise.resolve(),
  onShutdownTimeout: () => process.stderr.write("Edited-media replacement worker shutdown timed out; its lease will expire for safe recovery.\n"),
});
process.stdout.write("Edited-media replacement worker stopped.\n");
