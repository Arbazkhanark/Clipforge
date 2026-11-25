import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextPersistedRenderJob } from "../src/server/render/export-service.ts";
import { assertWorkerDatabaseIdentity } from "../src/server/workers/database-identity-guard.ts";
import { runContinuousWorker } from "../src/server/workers/continuous-worker.ts";

assertWorkerDatabaseIdentity();
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Render worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable) throw new Error("Private render storage is unavailable.");
const workerId = `render-worker-${randomUUID()}`;
const context = { userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" as const }, media };
process.stdout.write("Durable render worker started.\n");
await runContinuousWorker({
  runOnce: () => runNextPersistedRenderJob({ ...context, now: new Date() }, workerId),
  idleDelayMs: (status) => status === "idle" ? 2_000 : 0,
  dispose: () => runtime.dispose?.() ?? Promise.resolve(),
  onShutdownTimeout: () => process.stderr.write("Render worker shutdown timed out; its lease will expire for safe recovery.\n"),
});
process.stdout.write("Durable render worker stopped.\n");
