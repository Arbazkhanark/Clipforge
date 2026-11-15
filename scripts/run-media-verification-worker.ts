import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextMediaVerificationJob } from "../src/server/media-verification.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Media verification worker requires database mode.");
const media = await runtime.media?.();
if (!media || media.unavailable) throw new Error("Private media storage is unavailable.");
if (!media.probe) process.stderr.write("Media verification worker has no ffprobe; uploads will remain incomplete until it is installed.\n");
const workerId = `media-verification-${randomUUID()}`;
const context = { userId: null, now: new Date(), repo: runtime.repo, newId: runtime.newId, config: { coverSupport: "unknown" as const }, media };
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
process.stdout.write("Media verification worker started.\n");
while (!stopping) {
  const status = await runNextMediaVerificationJob({ ...context, now: new Date() }, workerId);
  if (status === "idle") await sleep(2_000);
}
process.stdout.write("Media verification worker stopped.\n");
