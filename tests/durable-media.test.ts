// Durable local-disk media. Database mode must use the private folder and must not keep file bytes in memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { MediaServices, RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { uploadMedia } from "../src/server/handlers/media-upload.ts";
import { serveMedia } from "../src/server/handlers/media-serve.ts";
import { getUploadInfo } from "../src/server/queries.ts";
import { createDatabaseRuntime } from "../src/server/runtime.ts";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { InvalidStorageKeyError, mediaKeyFor } from "../src/server/storage/media-storage.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";
import { makeMedia } from "./helpers.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const roots: string[] = [];
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "clipforge-durable-")); roots.push(dir); return dir; };
const read = async (body: ReadableStream<Uint8Array> | null) => new Uint8Array(await new Response(body).arrayBuffer());
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry: Dirent) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(full) : [full];
});
const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (error) { assert.ok(error instanceof AppError, String(error)); return error; } assert.fail("expected an error"); };

function context(repo: MemoryRepository, storage: MediaServices["storage"], userId: string, extra: Partial<MediaServices> = {}): RequestContext {
  let n = 0;
  const media: MediaServices = { storage, probe: null, maxUploadBytes: 1024 * 1024, ...extra };
  return { userId, now: new Date("2026-11-06T12:00:00Z"), repo, newId: () => `file${++n}`, config: { coverSupport: "unknown" }, media };
}

test("database mode refuses uploads when the private folder is missing, a file, or inside the web site", async () => {
  const missing = createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => { throw new Error("not opened"); }, { mediaDir: null });
  const missingMedia = await missing.media!();
  assert.ok(missingMedia);
  assert.match(missingMedia.unavailable ?? "", /not configured/);
  assert.notEqual(missingMedia.storage.constructor.name, "MemoryMediaStorage");
  const blocked = await errorOf(missingMedia.storage.stage("staging/a", PNG));
  assert.equal(blocked.code, "storage_unavailable");
  assert.ok(!blocked.message.includes("/"));

  const file = join(tempDir(), "not-a-folder");
  writeFileSync(file, "x");
  const unusable = await createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => { throw new Error("not opened"); }, { mediaDir: file }).media!();
  assert.ok(unusable);
  assert.match(unusable.unavailable ?? "", /could not be opened/);
  assert.ok(!(unusable.unavailable ?? "").includes(file));
  const uploadError = await errorOf(uploadMedia(context(new MemoryRepository(), unusable.storage, "ann", { unavailable: unusable.unavailable }), { filename: "a.png", declaredMimeType: "image/png", data: PNG }));
  assert.equal(uploadError.code, "storage_unavailable");
  assert.equal(getUploadInfo(context(new MemoryRepository(), unusable.storage, "ann", { unavailable: unusable.unavailable })).available, false);

  const blockedDir = join(process.cwd(), "public", "clipforge-phase3-not-created");
  const inside = await createDatabaseRuntime("postgresql://127.0.0.1:9/clipforge", async () => { throw new Error("not opened"); }, { mediaDir: blockedDir }).media!();
  assert.ok(inside);
  assert.match(inside.unavailable ?? "", /outside the web site folders/);
  assert.equal(existsSync(blockedDir), false);
  assert.ok(!(inside.unavailable ?? "").includes(blockedDir));
});

test("an upload survives a new storage connection, and another user cannot read it", async () => {
  const dir = tempDir();
  const first = await LocalDiskMediaStorage.create(dir);
  const repo = new MemoryRepository();
  const saved = await uploadMedia(context(repo, first, "ann"), { filename: "../../secret.png", declaredMimeType: "image/png", data: PNG });
  assert.equal(saved.storage, "local-disk");
  assert.equal(saved.title.includes("/"), false);
  assert.equal(repo.storageKeys.get(saved.mediaId), mediaKeyFor("ann", saved.mediaId));
  assert.deepEqual(readdirSync(join(dir, "media", "ann")), [saved.mediaId]);

  const restarted = await LocalDiskMediaStorage.create(dir);
  const owner = await serveMedia(context(repo, restarted, "ann"), { mediaId: saved.mediaId, variant: "download", rangeHeader: null });
  assert.equal(owner.status, 200);
  assert.deepEqual(await read(owner.body), PNG);
  const stranger = await errorOf(serveMedia(context(repo, restarted, "bob"), { mediaId: saved.mediaId, variant: "download", rangeHeader: null }));
  assert.equal(stranger.status, 404);
  assert.ok(!stranger.message.includes(dir));
  assert.ok(!JSON.stringify(owner.headers).includes(dir));
});

test("invalid types, oversized files, path traversal, and a missing file are refused without leftovers", async () => {
  const dir = tempDir();
  const storage = await LocalDiskMediaStorage.create(dir);
  const repo = new MemoryRepository();
  const ctx = context(repo, storage, "ann");
  const text = await errorOf(uploadMedia(ctx, { filename: "notes.mp4", declaredMimeType: "video/mp4", data: new TextEncoder().encode("hello this is not media at all") }));
  assert.equal(text.code, "unsupported_media_type");
  const huge = await errorOf(uploadMedia({ ...ctx, media: { ...ctx.media!, maxUploadBytes: 8 } }, { filename: "a.png", declaredMimeType: "image/png", data: PNG }));
  assert.equal(huge.code, "file_too_large");
  await assert.rejects(() => storage.stage("../outside", PNG), InvalidStorageKeyError);
  assert.throws(() => mediaKeyFor("ann", "../outside.png"), InvalidStorageKeyError);
  assert.deepEqual(readdirSync(dir), []);

  const saved = await uploadMedia(ctx, { filename: "kept.png", declaredMimeType: "image/png", data: PNG });
  rmSync(join(dir, "media", "ann", saved.mediaId));
  const missing = await errorOf(serveMedia(ctx, { mediaId: saved.mediaId, variant: "preview", rangeHeader: null }));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "File was not found.");
});

test("a failed database write removes the file that was just saved", async () => {
  const dir = tempDir();
  const storage = await LocalDiskMediaStorage.create(dir);
  const repo = new MemoryRepository();
  repo.addMediaWithVerificationJobIfStorageWithin = async () => { throw new AppError(503, "database_unavailable", "The database could not complete that request. Nothing was saved in memory."); };
  const error = await errorOf(uploadMedia(context(repo, storage, "ann"), { filename: "a.png", declaredMimeType: "image/png", data: PNG }));
  assert.equal(error.code, "database_unavailable");
  assert.equal(repo.media.size, 0);
  assert.deepEqual(filesUnder(dir), []);
});

test("the plan storage quota still refuses a file and leaves the private folder empty", async () => {
  const dir = tempDir();
  const storage = await LocalDiskMediaStorage.create(dir);
  const repo = new MemoryRepository();
  repo.plans.set("ann", "free");
  await repo.addMediaIfStorageWithin(makeMedia({ id: "already", ownerId: "ann", sizeBytes: getPlan("free").limits.storageBytes }), { storageKey: "media/ann/already", thumbnailKey: null }, getPlan("free").limits.storageBytes);
  const error = await errorOf(uploadMedia(context(repo, storage, "ann"), { filename: "extra.png", declaredMimeType: "image/png", data: PNG }));
  assert.equal(error.code, "plan_limit");
  assert.equal(await storage.exists("media/ann/already"), false);
  assert.deepEqual(readdirSync(dir), []);
});

test.after(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
