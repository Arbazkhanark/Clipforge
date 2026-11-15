import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3MediaStorage } from "../src/server/storage/s3-storage.ts";

type CommandLike = { input: Record<string, unknown>; constructor: { name: string } };
class FakeS3 {
  objects = new Map<string, Uint8Array>();
  commands: CommandLike[] = [];
  failNext: { status: number; name: string } | null = null;
  async send(command: unknown): Promise<Record<string, unknown>> {
    const current = command as CommandLike; this.commands.push(current);
    if (this.failNext) { const failure = this.failNext; this.failNext = null; throw Object.assign(new Error("synthetic"), { name: failure.name, $metadata: { httpStatusCode: failure.status } }); }
    const { Bucket, Key, CopySource, IfNoneMatch, Range } = current.input;
    const objectKey = `${String(Bucket)}/${String(Key)}`;
    if (current.constructor.name === "PutObjectCommand") {
      if (IfNoneMatch === "*" && this.objects.has(objectKey)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      const body = current.input["Body"];
      if (body instanceof Uint8Array) this.objects.set(objectKey, body.slice());
      else if (body && typeof body === "object" && Symbol.asyncIterator in body) {
        const chunks: Uint8Array[] = []; for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        this.objects.set(objectKey, Buffer.concat(chunks));
      }
      return {};
    }
    if (current.constructor.name === "CopyObjectCommand") {
      if (IfNoneMatch === "*" && this.objects.has(objectKey)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      const source = this.objects.get(String(CopySource));
      if (!source) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      this.objects.set(objectKey, source.slice()); return {};
    }
    if (current.constructor.name === "DeleteObjectCommand") { this.objects.delete(objectKey); return {}; }
    if (current.constructor.name === "HeadObjectCommand") {
      const bytes = this.objects.get(objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return { ContentLength: bytes.length };
    }
    if (current.constructor.name === "GetObjectCommand") {
      const bytes = this.objects.get(objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      const match = typeof Range === "string" ? /^bytes=(\d+)-(\d+)$/.exec(Range) : null;
      const selected = match ? bytes.slice(Number(match[1]), Number(match[2]) + 1) : bytes;
      const body = Readable.from([selected]);
      Object.assign(body, { transformToWebStream: () => Readable.toWeb(body) });
      return { Body: body };
    }
    throw new Error("Unexpected S3 command in fake.");
  }
}

const makeStorage = () => { const client = new FakeS3(); return { client, storage: new S3MediaStorage(client as unknown as S3Client, "clipforge-test-media") }; };

test("S3 adapter stages, commits conditionally, reports metadata and supports ranged reads", async () => {
  const { client, storage } = makeStorage();
  await storage.stage("staging/upload1", new Uint8Array([1, 2, 3, 4]));
  assert.equal(await storage.exists("media/owner1/media1"), false);
  await storage.commit("staging/upload1", "media/owner1/media1");
  assert.equal(await storage.exists("media/owner1/media1"), true);
  assert.deepEqual(await storage.getPrivateMetadata("media/owner1/media1"), { sizeBytes: 4, storageKind: "s3" });
  const ranged = await storage.openRead("media/owner1/media1", { start: 1, end: 2 });
  assert.deepEqual([...new Uint8Array(await new Response(ranged).arrayBuffer())], [2, 3]);
  assert.equal(client.commands.some((command) => command.constructor.name === "GetObjectCommand" && command.input["Range"] === "bytes=1-2"), true);
  assert.equal(client.objects.has("clipforge-test-media/staging/upload1"), false);
});

test("S3 adapter rejects overwrite and invalid storage keys", async () => {
  const { storage } = makeStorage();
  await storage.stage("staging/upload1", new Uint8Array([1]));
  await assert.rejects(storage.stage("staging/upload1", new Uint8Array([2])), /already exists/);
  await assert.rejects(storage.stage("../upload", new Uint8Array([2])));
});

test("temporary files are private and removed when the processing callback completes or fails", async () => {
  const { storage } = makeStorage();
  await storage.stage("staging/upload1", new Uint8Array([7, 8, 9]));
  let path = "";
  const value = await storage.runWithStagedFile("staging/upload1", async (file) => { path = file; assert.deepEqual([...readFileSync(file)], [7, 8, 9]); return 12; });
  assert.equal(value, 12); assert.equal(existsSync(path), false);
  await storage.commit("staging/upload1", "media/owner1/media1");
  await assert.rejects(storage.runWithCommittedFile("media/owner1/media1", async (file) => { path = file; throw new Error("callback failed"); }), /could not prepare/);
  assert.equal(existsSync(path), false);
});

test("copy uses a lease fence and removes the attempt object when its lease is lost", async () => {
  const { client, storage } = makeStorage();
  await storage.stage("staging/seed", new Uint8Array([1, 2]));
  await storage.commit("staging/seed", "media/owner1/source1");
  let calls = 0;
  await assert.rejects(storage.copyCommittedToStaging("media/owner1/source1", "staging/import1", () => { if (++calls === 2) throw new Error("Media import lease was lost."); }), /lease was lost/);
  assert.equal(client.objects.has("clipforge-test-media/staging/import1"), false);
});

test("missing objects are distinguished from storage errors and upload cleanup is idempotent", async () => {
  const { client, storage } = makeStorage();
  assert.equal(await storage.statSize("media/owner1/missing"), null);
  await storage.deleteUnreferencedUpload("media/owner1/missing");
  client.failNext = { status: 500, name: "InternalError" };
  await assert.rejects(storage.exists("media/owner1/missing"), /could not check/);
});
