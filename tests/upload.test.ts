import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { MediaServices, RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { uploadMedia, type UploadResult } from "../src/server/handlers/media-upload.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { detectProbe, isFfprobeAvailable, type MediaProbe } from "../src/server/storage/media-inspection.ts";
import type { MediaStorage } from "../src/server/storage/media-storage.ts";
import { getPlan } from "../src/lib/billing/catalog.ts";
import { fakeMp4, ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media-fixtures.ts";
import { NOW, makeMedia } from "./helpers.ts";

const ffprobeInstalled = spawnSync("ffprobe", ["-version"]).status === 0; // decided synchronously so skip conditions are accurate
let fixtures: Fixtures;
let realProbe: MediaProbe | null = null;
const tmpRoots: string[] = [];
before(async () => { if (ffmpegAvailable) fixtures = makeFixtures(); realProbe = await detectProbe(); });
after(() => { fixtures?.cleanup(); for (const r of tmpRoots) rmSync(r, { recursive: true, force: true }); });

let counter = 0;
function setup(opts: { plan?: "free" | "creator"; probe?: MediaProbe | null; maxUploadBytes?: number; storage?: MediaStorage; withMedia?: boolean } = {}) {
  const repo = new MemoryRepository();
  repo.plans.set("bob", opts.plan ?? "free"); repo.plans.set("eve", "free");
  const storage = opts.storage ?? new MemoryMediaStorage();
  const media: MediaServices = { storage, probe: opts.probe === undefined ? realProbe : opts.probe, maxUploadBytes: opts.maxUploadBytes ?? 10 * 1024 * 1024 };
  const ctxFor = (userId: string | null): RequestContext => ({ userId, now: NOW, repo, newId: () => `up${++counter}`, config: { coverSupport: "unknown" }, ...(opts.withMedia === false ? {} : { media }) });
  return { repo, storage, ctxFor };
}
const memoryCounts = (s: MemoryMediaStorage) => ({ staged: s.staged.size, objects: s.objects.size });
const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (e) { assert.ok(e instanceof AppError, `not an AppError: ${e}`); return e as AppError; } assert.fail("expected an error"); };
const upload = (ctx: RequestContext, data: Uint8Array, filename = "clip.mp4", declaredMimeType = "video/mp4") => uploadMedia(ctx, { filename, declaredMimeType, data });
const needFfmpeg = { skip: !(ffmpegAvailable) && "ffmpeg not installed" };

test("UNAUTHORIZED: no session = 401, nothing is read, stored or recorded", { ...needFfmpeg }, async () => {
  const { repo, storage, ctxFor } = setup();
  const error = await errorOf(upload(ctxFor(null), fixtures.mp4));
  assert.deepEqual([error.status, error.code], [401, "not_authenticated"]);
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 0 });
  assert.equal(repo.media.size, 0); assert.equal(repo.audit.length, 0);
});

test("no storage configured = 503 with a clear message (never a fake success)", { ...needFfmpeg }, async () => {
  const { ctxFor, repo } = setup({ withMedia: false });
  const error = await errorOf(upload(ctxFor("bob"), fixtures.mp4));
  assert.deepEqual([error.status, error.code], [503, "storage_not_configured"]); assert.equal(repo.media.size, 0);
});

test("SUCCESS (real ffprobe): a real MP4 is stored, verified, recorded, audited - and nothing private is returned", { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffmpeg/ffprobe not installed" : false }, async () => {
  const { repo, storage, ctxFor } = setup();
  const result = await upload(ctxFor("bob"), fixtures.mp4, "My Clip.mp4", "video/mp4");
  assert.deepEqual([result.title, result.kind, result.validation, result.warning, result.storage], ["My Clip.mp4", "video", "verified", null, "memory"]);
  assert.ok(result.durationMs! > 800 && result.durationMs! < 1300, `duration ${result.durationMs}`);
  assert.equal(result.sizeBytes, fixtures.mp4.length);
  const record = repo.media.get(result.mediaId)!;
  assert.deepEqual([record.ownerId, record.status, record.kind, record.width, record.height, record.validation], ["bob", "active", "video", 160, 120, "verified"]);
  const mem = storage as MemoryMediaStorage;
  assert.deepEqual(memoryCounts(mem), { staged: 0, objects: 1 });
  assert.ok(mem.objects.has(`media/bob/${result.mediaId}`));
  assert.equal(repo.storageKeys.get(result.mediaId), `media/bob/${result.mediaId}`);
  assert.equal(repo.audit.at(-1)!.action, "media.uploaded");
  const exposed = JSON.stringify(result);
  assert.ok(!/media\/bob|staging|\/tmp|storageKey|clipforge-/.test(exposed), exposed);
});

test("SUCCESS: PNG and JPEG images are accepted (kind image, no duration), also with a generic browser MIME type", needFfmpeg, async () => {
  const { repo, ctxFor } = setup();
  const png = await upload(ctxFor("bob"), fixtures.png, "cover.png", "image/png");
  const jpg = await upload(ctxFor("bob"), fixtures.jpeg, "cover.jpg", "application/octet-stream");
  for (const r of [png, jpg]) { assert.equal(r.kind, "image"); assert.equal(r.durationMs, null); }
  assert.equal(repo.media.size, 2);
  if (realProbe) assert.deepEqual([repo.media.get(png.mediaId)!.width, repo.media.get(png.mediaId)!.validation], [64, "verified"]);
});

test("SUCCESS on local disk: the file really lands in the private folder, under an id-based name", needFfmpeg, async () => {
  const root = mkdtempSync(join(tmpdir(), "clipforge-upload-disk-")); tmpRoots.push(root);
  const { repo, ctxFor } = setup({ storage: await LocalDiskMediaStorage.create(root) });
  const result = await upload(ctxFor("bob"), fixtures.png, "../../escape.png", "image/png");
  assert.equal(result.storage, "local-disk"); assert.equal(result.title, "escape.png");
  assert.deepEqual(readdirSync(join(root, "media", "bob")), [result.mediaId]);       // named by id, not by the user's file name
  assert.deepEqual(readdirSync(join(root, "staging")), []);                          // staging emptied
  assert.ok(repo.media.has(result.mediaId));
});

test("OVERSIZED: refused with 413 BEFORE anything is stored", needFfmpeg, async () => {
  const { repo, storage, ctxFor } = setup({ maxUploadBytes: 1000 });
  const error = await errorOf(upload(ctxFor("bob"), fixtures.mp4));
  assert.deepEqual([error.status, error.code], [413, "file_too_large"]); assert.match(error.message, /limit for one upload/);
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 0 }); assert.equal(repo.media.size, 0);
  // Exactly at the limit is allowed.
  const exact = setup({ maxUploadBytes: fixtures.png.length });
  assert.equal((await upload(exact.ctxFor("bob"), fixtures.png, "a.png", "image/png")).kind, "image");
});

test("INVALID MEDIA: wrong bytes, wrong claims and empty files are refused with the right status; nothing stored", needFfmpeg, async () => {
  const { repo, storage, ctxFor } = setup();
  const text = new TextEncoder().encode("<html><script>alert(1)</script></html>".padEnd(60));
  const cases: [string, Parameters<typeof uploadMedia>[1], number, string][] = [
    ["text renamed .mp4", { filename: "clip.mp4", declaredMimeType: "video/mp4", data: text }, 415, "unsupported_media_type"],
    ["PNG claiming to be a video", { filename: "x.mp4", declaredMimeType: "video/mp4", data: fixtures.png }, 415, "unsupported_media_type"],
    ["MP4 claiming to be an image", { filename: "x.png", declaredMimeType: "image/png", data: fixtures.mp4 }, 415, "unsupported_media_type"],
    ["empty file", { filename: "x.mp4", declaredMimeType: "video/mp4", data: new Uint8Array(0) }, 422, "validation_failed"],
    ["no data", { filename: "x.mp4", declaredMimeType: "video/mp4", data: "not bytes" }, 422, "validation_failed"],
    ["no filename", { filename: "", declaredMimeType: "video/mp4", data: fixtures.mp4 }, 422, "validation_failed"],
    ["huge filename", { filename: "a".repeat(300), declaredMimeType: "video/mp4", data: fixtures.mp4 }, 422, "validation_failed"],
    ["non-text mime", { filename: "x.mp4", declaredMimeType: 5, data: fixtures.mp4 }, 422, "validation_failed"],
  ];
  for (const [name, input, status, code] of cases) { const e = await errorOf(uploadMedia(ctxFor("bob"), input)); assert.deepEqual([e.status, e.code], [status, code], name); }
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 0 }); assert.equal(repo.media.size, 0); assert.equal(repo.audit.length, 0);
});

test("CLEANUP: a file with a valid MP4 header but no real video fails ffprobe -> 422, staging removed, no record, nothing committed", { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffprobe not installed" : false }, async () => {
  const { repo, storage, ctxFor } = setup();
  const error = await errorOf(upload(ctxFor("bob"), fakeMp4()));
  assert.deepEqual([error.status, error.code], [422, "invalid_media"]);
  assert.ok(!/\/tmp|clipforge-|ffprobe/i.test(error.message), error.message); // no internals in the message
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 0 }); assert.equal(repo.media.size, 0);
});

test("CLEANUP on local disk: after a failed upload the private folder holds no leftovers", { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffprobe not installed" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "clipforge-upload-fail-")); tmpRoots.push(root);
  const { ctxFor } = setup({ storage: await LocalDiskMediaStorage.create(root) });
  await errorOf(upload(ctxFor("bob"), fakeMp4()));
  assert.deepEqual(readdirSync(join(root, "staging")), []);
  assert.deepEqual(readdirSync(root).filter((n) => n !== "staging"), []);            // no "media" folder content either
});

test("ORIGINALS ARE PRESERVED: a failed upload never touches media that already exists", { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffprobe not installed" : false }, async () => {
  const { repo, storage, ctxFor } = setup();
  const first = await upload(ctxFor("bob"), fixtures.mp4, "keep.mp4");
  const before = new Uint8Array((storage as MemoryMediaStorage).objects.get(`media/bob/${first.mediaId}`)!);
  await errorOf(upload(ctxFor("bob"), fakeMp4()));                                    // fails inside ffprobe
  await errorOf(upload(ctxFor("bob"), new TextEncoder().encode("nope".padEnd(40))));  // fails the signature check
  assert.equal(repo.media.get(first.mediaId)!.status, "active");
  assert.deepEqual((storage as MemoryMediaStorage).objects.get(`media/bob/${first.mediaId}`), before);
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 1 });
});

test("QUOTA: a file that does not fit the plan's storage is refused (403 plan_limit); nothing stored; existing media untouched", needFfmpeg, async () => {
  const { repo, storage, ctxFor } = setup({ plan: "free" });
  const limit = getPlan("free").limits.storageBytes;
  repo.media.set("big", makeMedia({ id: "big", ownerId: "bob", sizeBytes: limit - 100 }));
  const error = await errorOf(upload(ctxFor("bob"), fixtures.png, "a.png", "image/png"));
  assert.deepEqual([error.status, error.code], [403, "plan_limit"]); assert.match(error.message, /Not enough storage/);
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 0 });
  assert.equal(repo.media.size, 1); assert.equal(repo.media.get("big")!.status, "active");
  // Deleted media does not count toward the quota; another user's usage is independent.
  repo.media.set("big", { ...repo.media.get("big")!, status: "deleted" });
  assert.equal((await upload(ctxFor("bob"), fixtures.png, "a.png", "image/png")).kind, "image");
  repo.media.set("evebig", makeMedia({ id: "evebig", ownerId: "eve", sizeBytes: limit }));
  assert.equal((await upload(ctxFor("bob"), fixtures.png, "b.png", "image/png")).kind, "image");
  assert.equal((await errorOf(upload(ctxFor("eve"), fixtures.png, "c.png", "image/png"))).code, "plan_limit");
});

test("QUOTA (early check): a file that clearly does not fit is refused WITHOUT writing a single byte to storage", needFfmpeg, async () => {
  class CountingStorage extends MemoryMediaStorage { stageCalls = 0; override async stage(key: string, data: Uint8Array) { this.stageCalls++; return super.stage(key, data); } }
  const storage = new CountingStorage();
  const { repo, ctxFor } = setup({ plan: "free", storage });
  repo.media.set("big", makeMedia({ id: "big", ownerId: "bob", sizeBytes: getPlan("free").limits.storageBytes }));
  assert.equal((await errorOf(upload(ctxFor("bob"), fixtures.png, "a.png", "image/png"))).code, "plan_limit");
  assert.equal(storage.stageCalls, 0);
});

test("QUOTA RACE: two simultaneous uploads that each fit but not together - exactly one wins, the loser's file is cleaned up", needFfmpeg, async () => {
  const { repo, storage, ctxFor } = setup({ plan: "free" });
  const limit = getPlan("free").limits.storageBytes;
  repo.media.set("big", makeMedia({ id: "big", ownerId: "bob", sizeBytes: limit - fixtures.png.length - 10 })); // room for exactly one PNG
  const results = await Promise.allSettled([upload(ctxFor("bob"), fixtures.png, "one.png", "image/png"), upload(ctxFor("bob"), fixtures.png, "two.png", "image/png")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.deepEqual([(loser.reason as AppError).status, (loser.reason as AppError).code], [403, "plan_limit"]);
  const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<UploadResult>).value;
  assert.deepEqual(memoryCounts(storage as MemoryMediaStorage), { staged: 0, objects: 1 });         // loser's committed file removed
  assert.ok((storage as MemoryMediaStorage).objects.has(`media/bob/${winner.mediaId}`));
  assert.equal(repo.media.size, 2);                                                                     // "big" + the winner
});

test("NO FFPROBE: the upload is accepted by signature only and CLEARLY marked incomplete - never 'verified'", needFfmpeg, async () => {
  const { repo, ctxFor } = setup({ probe: null });
  const result = await upload(ctxFor("bob"), fixtures.mp4);
  assert.equal(result.validation, "incomplete"); assert.equal(result.durationMs, null); assert.match(result.warning ?? "", /ffprobe is not installed/);
  const record = repo.media.get(result.mediaId)!;
  assert.deepEqual([record.validation, record.width, record.height, record.durationMs], ["incomplete", null, null, null]);
  // Even without ffprobe, the signature check still blocks obviously wrong files.
  assert.equal((await errorOf(upload(ctxFor("bob"), new TextEncoder().encode("hello hello hello hello")))).status, 415);
});

test("a probe that throws or reports no picture/duration is treated as invalid media, never as success", needFfmpeg, async () => {
  const throwing = setup({ probe: async () => { throw new Error("/secret/path ffprobe crashed"); } });
  const e1 = await errorOf(upload(throwing.ctxFor("bob"), fixtures.mp4));
  assert.deepEqual([e1.status, e1.code], [422, "invalid_media"]); assert.ok(!e1.message.includes("secret"));
  const noPicture = setup({ probe: async () => ({ width: 0, height: 0, durationSeconds: 5 }) });
  assert.equal((await errorOf(upload(noPicture.ctxFor("bob"), fixtures.mp4))).code, "invalid_media");
  const noDuration = setup({ probe: async () => ({ width: 100, height: 100, durationSeconds: 0 }) });
  assert.equal((await errorOf(upload(noDuration.ctxFor("bob"), fixtures.mp4))).code, "invalid_media");
  for (const s of [throwing, noPicture, noDuration]) assert.deepEqual(memoryCounts(s.storage as MemoryMediaStorage), { staged: 0, objects: 0 });
});

test("PATH TRAVERSAL through the file name: hostile names become harmless titles and never reach storage keys", needFfmpeg, async () => {
  const { repo, storage, ctxFor } = setup({ probe: null });
  const names = ["../../../etc/passwd.png", "..\\..\\windows\\system32\\evil.png", "a/b/c.png", "x\u0000.png", "<img src=x onerror=alert(1)>.png", "%2e%2e%2fetc.png", "...png"];
  for (const name of names) {
    const r = await upload(ctxFor("bob"), fixtures.png, name, "image/png");
    assert.ok(!/[\/\\<>\u0000]/.test(r.title), `${JSON.stringify(name)} -> ${JSON.stringify(r.title)}`);
    assert.ok((storage as MemoryMediaStorage).objects.has(`media/bob/${r.mediaId}`));
  }
  assert.equal([...(storage as MemoryMediaStorage).objects.keys()].every((k) => /^media\/bob\/up\d+$/.test(k)), true);
  assert.equal(repo.media.size, names.length);
});

test("ffprobe availability check is real (true here only if ffprobe actually runs)", async () => {
  assert.equal(typeof (await isFfprobeAvailable()), "boolean");
  assert.equal(Boolean(realProbe), await isFfprobeAvailable());
});
