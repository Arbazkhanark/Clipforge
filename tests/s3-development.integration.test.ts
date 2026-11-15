import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { readMediaStorageConfiguration } from "../src/server/storage/storage-config.ts";
import { S3MediaStorage } from "../src/server/storage/s3-storage.ts";

test("S3 development bucket integration (explicit opt-in only)", { skip: process.env["CLIPFORGE_S3_INTEGRATION"] !== "true" }, async () => {
  const config = readMediaStorageConfiguration(process.env);
  assert.ok(config.ok && config.provider === "s3" && config.environment === "development", "integration test refuses non-development storage");
  if (!config.ok || config.provider !== "s3" || config.environment !== "development") return;
  const client = new S3Client({ region: config.region, credentials: config.credentials });
  const storage = new S3MediaStorage(client, config.bucket);
  const suffix = randomUUID().replaceAll("-", "");
  const owner = `itest${suffix.slice(0, 12)}`;
  const id = `itest${suffix.slice(12, 24)}`;
  const staged = `staging/${id}`;
  const copied = `staging/${id}copy`;
  const final = `media/${owner}/${id}`;
  try {
    await storage.stage(staged, new Uint8Array([0, 1, 2, 3, 254, 255]));
    const stagedBytes = await storage.runWithStagedFile(staged, async (file) => new Uint8Array(await (await import("node:fs/promises")).readFile(file)));
    assert.deepEqual([...stagedBytes], [0, 1, 2, 3, 254, 255]);
    await storage.commit(staged, final);
    assert.equal(await storage.statSize(final), 6);
    const range = await storage.openRead(final, { start: 2, end: 4 });
    assert.deepEqual([...new Uint8Array(await new Response(range).arrayBuffer())], [2, 3, 254]);
    assert.equal(await storage.copyCommittedToStaging(final, copied), 6);
  } finally {
    await Promise.allSettled([storage.discardStaged(staged), storage.discardStaged(copied), storage.deleteUnreferencedUpload(final)]);
    client.destroy();
  }
});
