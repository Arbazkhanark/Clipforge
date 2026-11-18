import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextMediaCleanupJob } from "../src/server/media-deletion/cleanup-worker.ts";

const runtime = getRuntime();
if (runtime.mode !== "database" || !runtime.media) throw new Error("The media cleanup worker requires the configured PostgreSQL runtime and private storage.");
const media = await runtime.media();
if (!media || media.unavailable || media.storage.kind === "memory") throw new Error("The media cleanup worker requires available private storage.");
const workerId = `media-cleanup-${randomUUID()}`;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const result = await runNextMediaCleanupJob({ repo: runtime.repo, storage: media.storage, workerId });
  if (result !== "idle") console.info(JSON.stringify({ event: "media_cleanup_job_result", result }));
  if (result === "idle" || result === "retrying") await new Promise((resolve) => setTimeout(resolve, 5_000));
}
