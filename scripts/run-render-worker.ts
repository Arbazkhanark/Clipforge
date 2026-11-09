import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextPersistedRenderJob } from "../src/server/render/export-service.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Render worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable) throw new Error("Private render storage is unavailable.");
const workerId = `render-worker-${randomUUID()}`;
const context = { userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" as const }, media };
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.stdout.write("Durable render worker started.\n");
while (!stopping) {
  const status = await runNextPersistedRenderJob({ ...context, now: new Date() }, workerId);
  if (status === "idle") await sleep(2_000);
}
process.stdout.write("Durable render worker stopped.\n");
