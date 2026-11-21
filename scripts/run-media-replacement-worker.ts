import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextEditedMediaReplacement } from "../src/server/media-replacement-worker.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("The edited-media replacement worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable || media.storage.kind === "memory") throw new Error("Persistent private media storage is required.");
if (!media.probe) process.stderr.write("Edited-media replacement requires ffprobe; originals will remain until verification is available.\n");
const workerId = `media-replacement-${randomUUID()}`;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.stdout.write("Edited-media replacement worker started.\n");
while (!stopping) {
  const result = await runNextEditedMediaReplacement({ userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" }, media }, workerId);
  if (result === "idle" || result === "queued_verification") await sleep(2_000);
}
process.stdout.write("Edited-media replacement worker stopped.\n");
