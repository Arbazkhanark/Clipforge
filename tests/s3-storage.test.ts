import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3MediaStorage } from "../src/server/storage/s3-storage.ts";
import { withMediaUploadDiagnosticContext } from "../src/server/storage/media-upload-diagnostics.ts";

type CommandLike = { input: Record<string, unknown>; constructor: { name: string } };
class FakeS3 {
  objects = new Map<string, Uint8Array>();
  contentTypes = new Map<string, string>();
  commands: CommandLike[] = [];
  failNext: { status: number; name: string; code?: string; command?: string } | null = null;
  async send(command: unknown): Promise<Record<string, unknown>> {
    const current = command as CommandLike; this.commands.push(current);
    if (this.failNext && (!this.failNext.command || this.failNext.command === current.constructor.name)) { const failure = this.failNext; this.failNext = null; throw Object.assign(new Error("synthetic response with safe-to-test cause"), { name: failure.name, ...(failure.code ? { code: failure.code } : {}), $metadata: { httpStatusCode: failure.status, requestId: "s3-request-id" } }); }
    const { Bucket, Key, CopySource, IfNoneMatch, Range, ContentType } = current.input;
    const objectKey = `${String(Bucket)}/${String(Key)}`;
    if (current.constructor.name === "PutObjectCommand") {
      if (IfNoneMatch === "*" && this.objects.has(objectKey)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      const body = current.input["Body"];
      if (body instanceof Uint8Array) this.objects.set(objectKey, body.slice());
      else if (body && typeof body === "object" && Symbol.asyncIterator in body) {
        const chunks: Uint8Array[] = []; for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        this.objects.set(objectKey, Buffer.concat(chunks));
      }
      if (typeof ContentType === "string") this.contentTypes.set(objectKey, ContentType);
      return {};
    }
    if (current.constructor.name === "CopyObjectCommand") {
      if (IfNoneMatch === "*" && this.objects.has(objectKey)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      const copySourceKey = decodeURIComponent(String(CopySource).slice(String(Bucket).length + 1));
      const sourceObjectKey = `${String(Bucket)}/${copySourceKey}`;
      const source = this.objects.get(sourceObjectKey);
      if (!source) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      this.objects.set(objectKey, source.slice());
      const sourceType = this.contentTypes.get(sourceObjectKey);
      if (sourceType) this.contentTypes.set(objectKey, sourceType);
      return {};
    }
    if (current.constructor.name === "DeleteObjectCommand") { this.objects.delete(objectKey); this.contentTypes.delete(objectKey); return {}; }
    if (current.constructor.name === "HeadObjectCommand") {
      const bytes = this.objects.get(objectKey);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return { ContentLength: bytes.length, ContentType: this.contentTypes.get(objectKey) };
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
  assert.deepEqual(await storage.getPrivateMetadata("media/owner1/media1"), { sizeBytes: 4, storageKind: "s3", contentType: null });
  const ranged = await storage.openRead("media/owner1/media1", { start: 1, end: 2 });
  assert.deepEqual([...new Uint8Array(await new Response(ranged).arrayBuffer())], [2, 3]);
  assert.equal(client.commands.some((command) => command.constructor.name === "GetObjectCommand" && command.input["Range"] === "bytes=1-2"), true);
  assert.equal(client.objects.has("clipforge-test-media/staging/upload1"), false);
});

test("S3 preserves the validated content type from staged upload through committed metadata", async () => {
  const { client, storage } = makeStorage();
  await storage.stage("staging/typed", new Uint8Array([1, 2, 3]), { contentType: "video/mp4" });
  assert.equal(client.commands.find((command) => command.constructor.name === "PutObjectCommand")?.input["ContentType"], "video/mp4");
  await storage.commit("staging/typed", "media/owner1/typed");
  assert.equal((await storage.getPrivateMetadata("media/owner1/typed"))?.contentType, "video/mp4");
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

test("committed media deletion is a separate, key-validated private storage operation", async () => {
  const { client, storage } = makeStorage();
  await storage.stage("staging/delete-test", new Uint8Array([1, 2]));
  await storage.commit("staging/delete-test", "media/owner1/delete-test");
  await storage.deleteCommittedMediaObject("media/owner1/delete-test");
  assert.equal(client.objects.has("clipforge-test-media/media/owner1/delete-test"), false);
  assert.equal(client.commands.filter((command) => command.constructor.name === "DeleteObjectCommand").length, 2);
  await assert.rejects(storage.deleteCommittedMediaObject("../outside"));
});

test("S3 PutObject, CopyObject, GetObject, and DeleteObject wrappers preserve their AWS error as cause", async () => {
  const { client, storage } = makeStorage();
  const failure = () => ({ status: 400, name: "InvalidToken", code: "InvalidToken" });
  client.failNext = { ...failure(), command: "PutObjectCommand" };
  await assert.rejects(storage.stage("staging/put", new Uint8Array([1])), (error: unknown) => error instanceof Error && (error.cause as Error)?.name === "InvalidToken");

  await storage.stage("staging/copy", new Uint8Array([1]));
  client.failNext = { ...failure(), command: "CopyObjectCommand" };
  await assert.rejects(storage.commit("staging/copy", "media/owner/copy"), (error: unknown) => error instanceof Error && (error.cause as Error)?.name === "InvalidToken");

  await storage.stage("staging/get", new Uint8Array([1]));
  client.failNext = { ...failure(), command: "GetObjectCommand" };
  await assert.rejects(storage.runWithStagedFile("staging/get", async () => undefined), (error: unknown) => error instanceof Error && (error.cause as Error)?.name === "InvalidToken");

  client.failNext = { ...failure(), command: "DeleteObjectCommand" };
  await assert.rejects(storage.discardStaged("staging/delete"), (error: unknown) => error instanceof Error && (error.cause as Error)?.name === "InvalidToken");
});

test("S3 commit keeps a successful CopyObject successful when staging cleanup fails and logs the cleanup failure", async () => {
  const { client, storage } = makeStorage();
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    await storage.stage("staging/commit-cleanup", new Uint8Array([1, 2]));
    client.failNext = { status: 503, name: "SlowDown", code: "SlowDown", command: "DeleteObjectCommand" };
    await withMediaUploadDiagnosticContext({ requestId: "upload-request", environment: "production", provider: "s3" }, () => storage.commit("staging/commit-cleanup", "media/owner/cleanup"));
  } finally { console.error = originalError; }
  assert.equal(client.objects.has("clipforge-test-media/media/owner/cleanup"), true);
  assert.equal(client.objects.has("clipforge-test-media/staging/commit-cleanup"), true);
  const cleanup = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry["event"] === "media_cleanup_failed");
  assert.deepEqual([cleanup?.["requestId"], cleanup?.["operation"], cleanup?.["errorCategory"], cleanup?.["retryable"]], ["upload-request", "s3.DeleteObject", "aws_throttling", true]);
  assert.doesNotMatch(lines.join("\n"), /media\/owner|staging\/commit-cleanup|clipforge-test-media/);
});
