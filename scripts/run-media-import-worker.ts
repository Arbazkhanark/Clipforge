import { randomUUID } from "node:crypto";
import { getRuntime } from "../src/server/runtime.ts";
import { runNextMediaImportJob } from "../src/server/media-import/import-worker.ts";

const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("The media import worker requires database mode.");
const services = await runtime.media?.();
if (!services || services.unavailable || services.storage.kind === "memory") throw new Error("Persistent private media storage is required.");
const result = await runNextMediaImportJob({ repo: runtime.repo, storage: services.storage, workerId: randomUUID(), now: runtime.now });
process.stdout.write(`${result}\n`);
