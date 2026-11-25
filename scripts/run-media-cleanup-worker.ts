import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextMediaCleanupJob } from "../src/server/media-deletion/cleanup-worker.ts";
import { assertWorkerDatabaseIdentity } from "../src/server/workers/database-identity-guard.ts";
import { runContinuousWorker } from "../src/server/workers/continuous-worker.ts";

assertWorkerDatabaseIdentity();
const runtime = getRuntime();
if (runtime.mode !== "database" || !runtime.media) throw new Error("The media cleanup worker requires the configured PostgreSQL runtime and private storage.");
const media = await runtime.media();
if (!media || media.unavailable || media.storage.kind === "memory") throw new Error("The media cleanup worker requires available private storage.");
const workerId = `media-cleanup-${randomUUID()}`;
await runContinuousWorker({
  runOnce: async () => {
    const result = await runNextMediaCleanupJob({ repo: runtime.repo, storage: media.storage, workerId });
    if (result !== "idle") console.info(JSON.stringify({ event: "media_cleanup_job_result", result }));
    return result;
  },
  idleDelayMs: (result) => result === "idle" || result === "retrying" ? 5_000 : 0,
  dispose: () => runtime.dispose?.() ?? Promise.resolve(),
  onShutdownTimeout: () => process.stderr.write("Media cleanup worker shutdown timed out; its lease will expire for safe recovery.\n"),
});
