import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { MediaServices, RequestContext } from "../src/server/context.ts";
import { AppError } from "../src/server/errors.ts";
import { MAX_PARTIAL_BYTES, contentDisposition, parseRange, serveMedia } from "../src/server/handlers/media-serve.ts";
import { uploadMedia } from "../src/server/handlers/media-upload.ts";
import { mediaFileRoute } from "../src/server/media-route.ts";
import { decideMediaAccess } from "../src/lib/domain/media-access.ts";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { S3MediaStorage } from "../src/server/storage/s3-storage.ts";
import type { S3Client } from "@aws-sdk/client-s3";
import { detectProbe, makeThumbnailWithFfmpeg, type ThumbnailMaker } from "../src/server/storage/media-inspection.ts";
import { getMediaDetail, getMediaLibrary } from "../src/server/queries.ts";
import { MediaDetailView } from "../src/components/MediaDetailView.tsx";
import { MediaTable } from "../src/components/MediaTable.tsx";
import type { Runtime } from "../src/server/runtime.ts";
import { ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media-fixtures.ts";
import { NOW, inDays, makeCollection, makeGrant, makeMedia } from "./helpers.ts";

const ffprobeInstalled = spawnSync("ffprobe", ["-version"]).status === 0;
let fixtures: Fixtures; const tmp: string[] = [];
before(() => { if (ffmpegAvailable) fixtures = makeFixtures(); });
after(() => { fixtures?.cleanup(); tmp.forEach((d) => rmSync(d, { recursive: true, force: true })); });

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const THUMB = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const read = async (body: ReadableStream<Uint8Array> | null) => new Uint8Array(await new Response(body).arrayBuffer());
const errorOf = async (p: Promise<unknown>): Promise<AppError> => { try { await p; } catch (e) { assert.ok(e instanceof AppError, String(e)); return e as AppError; } assert.fail("expected error"); };

function setup(opts: { storage?: MemoryMediaStorage; thumbnail?: boolean; mimeType?: string; title?: string; sizeBytes?: number } = {}) {
  const repo = new MemoryRepository(); const storage = opts.storage ?? new MemoryMediaStorage();
  storage.objects.set("media/owner/m1", BYTES); if (opts.thumbnail !== false) storage.objects.set("thumb/owner/m1", THUMB);
  repo.media.set("m1", makeMedia({ id: "m1", ownerId: "owner", title: opts.title ?? "Clip One.mp4", mimeType: opts.mimeType ?? "video/mp4", sizeBytes: opts.sizeBytes ?? BYTES.length }));
  repo.storageKeys.set("m1", "media/owner/m1"); repo.thumbnailKeys.set("m1", opts.thumbnail === false ? null : "thumb/owner/m1");
  repo.collections.set("col1", makeCollection({ id: "col1", ownerId: "owner", mediaIds: ["m1"] }));
  const media: MediaServices = { storage, probe: null, maxUploadBytes: 1e9 };
  const ctxFor = (userId: string | null, now = NOW): RequestContext => ({ userId, now, repo, newId: () => "x", config: { coverSupport: "unknown" }, media });
  return { repo, storage, ctxFor };
}
const get = (ctx: RequestContext, variant: string, range: string | null = null, id: unknown = "m1") => serveMedia(ctx, { mediaId: id, variant, rangeHeader: range });

// ---------- pure access rules ----------
test("access rules: owner everything; recipients see thumbnails only unless the owner gave 'download'; public view and use-in-cycle never reveal the original", () => {
  const media = makeMedia({ id: "m1", ownerId: "owner" });
  const decide = (userId: string, variant: "thumbnail" | "preview" | "download", grants = [makeGrant({ granteeId: "bob" })], collection = makeCollection({ mediaIds: ["m1"] }), m = media, now = NOW) =>
    decideMediaAccess({ userId, media: m, containing: [{ collection, grants }], variant, now }).allowed;
  for (const v of ["thumbnail", "preview", "download"] as const) assert.equal(decide("owner", v, []), true, `owner ${v}`);
  assert.deepEqual((["thumbnail", "preview", "download"] as const).map((v) => decide("bob", v)), [true, false, false]);                                  // view only
  const dl = [makeGrant({ granteeId: "bob", capabilities: ["view", "download"] })];
  assert.deepEqual((["thumbnail", "preview", "download"] as const).map((v) => decide("bob", v, dl)), [true, true, true]);
  const useOnly = [makeGrant({ granteeId: "bob", capabilities: ["use_in_cycle"] })];
  assert.deepEqual((["thumbnail", "preview", "download"] as const).map((v) => decide("bob", v, useOnly)), [true, false, false]);                     // can use it, cannot take it
  assert.deepEqual((["thumbnail", "preview", "download"] as const).map((v) => decide("eve", v, [], makeCollection({ visibility: "public_view", mediaIds: ["m1"] }))), [true, false, false]); // public view
  assert.deepEqual((["thumbnail", "preview", "download"] as const).map((v) => decide("eve", v)), [false, false, false]);                              // stranger
  assert.equal(decide("bob", "thumbnail", [makeGrant({ granteeId: "bob", status: "revoked" })]), false);
  assert.equal(decide("bob", "thumbnail", [makeGrant({ granteeId: "bob", expiresAt: new Date(NOW.getTime() - 1) })]), false);
  assert.equal(decide("bob", "download", dl, makeCollection({ mediaIds: ["m1"], archived: true })), false);                                           // archived: no downloads for recipients
  assert.equal(decide("bob", "thumbnail", dl, makeCollection({ mediaIds: ["other"] })), false);                                                      // media not in that collection
  assert.equal(decide("bob", "thumbnail", dl, undefined, makeMedia({ id: "m1", ownerId: "owner", status: "deleted" })), false);
  assert.equal(decide("owner", "thumbnail", [], undefined, makeMedia({ id: "m1", ownerId: "owner", status: "deleted" })), false);
  const grace = makeMedia({ id: "m1", ownerId: "owner", status: "pending_deletion", deleteAfter: inDays(2) });
  assert.equal(decide("bob", "download", dl, undefined, grace), true); assert.equal(decide("bob", "download", dl, undefined, grace, inDays(3)), false);
});

// ---------- range parsing ----------
test("range parsing: single ranges, suffixes, open ends, clamping, unsatisfiable, and everything else ignored", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=500-9999", 1000), { start: 500, end: 999 });
  for (const bad of ["bytes=1000-", "bytes=2000-3000", "bytes=-0", "bytes=50-10"]) assert.equal(parseRange(bad, 1000), "unsatisfiable", bad);
  for (const ignored of [null, "", "bytes=", "bytes=-", "items=0-5", "bytes=0-5,10-20", "bytes=a-b", "garbage"]) assert.equal(parseRange(ignored, 1000), null, String(ignored));
});

test("Content-Disposition: quotes, newlines, semicolons and non-ASCII cannot break out of the header", () => {
  const evil = contentDisposition("attachment", 'a"; filename=evil.exe\r\nSet-Cookie: x=1.mp4');
  assert.ok(!/[\r\n]/.test(evil)); assert.equal((evil.match(/"/g) ?? []).length, 2);
  assert.match(contentDisposition("inline", "résumé ✓.mp4"), /^inline; filename="r_sum_ _\.mp4"; filename\*=UTF-8''r%C3%A9sum%C3%A9%20%E2%9C%93\.mp4$/);
  assert.match(contentDisposition("attachment", ""), /filename="file"/);
});

// ---------- the serving handler ----------
test("UNAUTHORIZED: signed-out requests get 401 and no data; invalid ids/variants are 422; no storage = 503", async () => {
  const { ctxFor } = setup();
  assert.equal((await errorOf(get(ctxFor(null), "thumbnail"))).status, 401);
  for (const [variant, id] of [["bogus", "m1"], ["", "m1"], [5, "m1"], ["thumbnail", "../m1"], ["thumbnail", ""], ["thumbnail", 7], ["thumbnail", "a/b"]] as const) assert.equal((await errorOf(get(ctxFor("owner"), variant as string, null, id))).status, 422, `${variant}|${id}`);
  const noStorage = { ...ctxFor("owner"), media: undefined }; assert.equal((await errorOf(get(noStorage, "thumbnail"))).status, 503);
});

test("OWNER: thumbnail, inline preview and download all work, with the right headers and exact bytes", async () => {
  const { ctxFor } = setup(); const owner = ctxFor("owner");
  const thumb = await get(owner, "thumbnail");
  assert.deepEqual([thumb.status, thumb.headers["Content-Type"], thumb.headers["Content-Disposition"], thumb.headers["Content-Length"]], [200, "image/jpeg", "inline", String(THUMB.length)]);
  assert.deepEqual(await read(thumb.body), THUMB);
  const preview = await get(owner, "preview");
  assert.deepEqual([preview.status, preview.headers["Content-Type"], preview.headers["Accept-Ranges"]], [200, "video/mp4", "bytes"]);
  assert.match(preview.headers["Content-Disposition"]!, /^inline; filename="Clip One\.mp4"/); assert.deepEqual(await read(preview.body), BYTES);
  const download = await get(owner, "download");
  assert.match(download.headers["Content-Disposition"]!, /^attachment; filename="Clip One\.mp4"/); assert.deepEqual(await read(download.body), BYTES);
  for (const r of [thumb, preview, download]) {
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff"); assert.equal(r.headers["Cache-Control"], "private, no-store");
    assert.equal(r.headers["Cross-Origin-Resource-Policy"], "same-origin"); assert.match(r.headers["Content-Security-Policy"]!, /sandbox/); assert.equal(r.headers["Referrer-Policy"], "no-referrer");
  }
});

test("NOTHING PRIVATE LEAKS: no storage key, folder or bucket in headers; denials are byte-identical to 'not found'", async () => {
  const { ctxFor } = setup();
  const served = await get(ctxFor("owner"), "download");
  assert.ok(!/media\/owner|thumb\/owner|staging|\/tmp|clipforge-|s3|amazonaws/i.test(JSON.stringify(served.headers)));
  const stranger = await errorOf(get(ctxFor("eve"), "preview")); const missing = await errorOf(get(ctxFor("eve"), "preview", null, "doesnotexist"));
  assert.deepEqual([stranger.status, stranger.code, stranger.message], [missing.status, missing.code, missing.message]); assert.equal(stranger.status, 404);
  assert.ok(!/media\/owner|m1/.test(JSON.stringify(stranger)));
});

test("SHARED ACCESS: view-only recipient gets the thumbnail only; with 'download' also the original; each request is re-checked", async () => {
  const { repo, ctxFor } = setup(); const bob = ctxFor("bob");
  repo.grants.push(makeGrant({ granteeId: "bob", capabilities: ["view", "use_in_cycle"] }));
  assert.equal((await get(bob, "thumbnail")).status, 200);
  assert.equal((await errorOf(get(bob, "preview"))).status, 404); assert.equal((await errorOf(get(bob, "download"))).status, 404);
  repo.grants[0] = { ...repo.grants[0]!, capabilities: ["view", "download"] };
  assert.equal((await get(bob, "preview")).status, 200); assert.deepEqual(await read((await get(bob, "download")).body), BYTES);
  // Revoked: the very next request is refused, nothing is remembered.
  repo.grants[0] = { ...repo.grants[0]!, status: "revoked" };
  for (const v of ["thumbnail", "preview", "download"]) assert.equal((await errorOf(get(bob, v))).status, 404, v);
});

test("ACCESS IS RE-CHECKED OVER TIME: expiry, removal from the collection, owner deletion and the end of the grace period", async () => {
  const { repo, ctxFor } = setup();
  repo.grants.push(makeGrant({ granteeId: "bob", capabilities: ["view", "download"], expiresAt: inDays(1) }));
  assert.equal((await get(ctxFor("bob", NOW), "download")).status, 200);
  assert.equal((await errorOf(get(ctxFor("bob", inDays(2)), "download"))).status, 404);                          // expired grant
  repo.grants[0] = { ...repo.grants[0]!, expiresAt: null };
  repo.collections.set("col1", makeCollection({ id: "col1", ownerId: "owner", mediaIds: [] }));                      // owner removed it from the collection
  assert.equal((await errorOf(get(ctxFor("bob"), "thumbnail"))).status, 404);
  repo.collections.set("col1", makeCollection({ id: "col1", ownerId: "owner", mediaIds: ["m1"] }));
  repo.media.set("m1", { ...repo.media.get("m1")!, status: "pending_deletion", deleteAfter: inDays(3) });
  assert.equal((await get(ctxFor("bob", NOW), "download")).status, 200);                                            // grace period
  assert.equal((await errorOf(get(ctxFor("bob", inDays(4)), "download"))).status, 404);                              // grace over
  assert.equal((await get(ctxFor("owner", inDays(4)), "download")).status, 200);                                     // the owner still can
  repo.media.set("m1", { ...repo.media.get("m1")!, status: "deleted" });
  assert.equal((await errorOf(get(ctxFor("owner"), "download"))).status, 404);
});

test("MISSING PIECES: no thumbnail, or the object is gone from storage -> 404, never an error with internals", async () => {
  const noThumb = setup({ thumbnail: false });
  assert.equal((await errorOf(get(noThumb.ctxFor("owner"), "thumbnail"))).status, 404); assert.equal((await get(noThumb.ctxFor("owner"), "preview")).status, 200);
  const gone = setup(); gone.storage.objects.delete("media/owner/m1");
  const e = await errorOf(get(gone.ctxFor("owner"), "download")); assert.deepEqual([e.status, e.code], [404, "not_found"]);
  const noRecordKeys = setup(); noRecordKeys.repo.storageKeys.delete("m1"); assert.equal((await errorOf(get(noRecordKeys.ctxFor("owner"), "download"))).status, 404);
});

test("CONTENT TYPES: only known media types are shown inline; anything else becomes an opaque download", async () => {
  const html = setup({ mimeType: "text/html", title: "evil.html" });
  const preview = await get(html.ctxFor("owner"), "preview");
  assert.equal(preview.headers["Content-Type"], "application/octet-stream"); assert.match(preview.headers["Content-Disposition"]!, /^attachment/);
  const unknown = setup({ mimeType: undefined as unknown as string }); unknown.repo.media.set("m1", { ...unknown.repo.media.get("m1")!, mimeType: undefined });
  assert.equal((await get(unknown.ctxFor("owner"), "preview")).headers["Content-Type"], "application/octet-stream");
});

test("RANGE requests (video seeking): 206 with exact bytes and headers; 416 when impossible; garbage ranges serve the whole file; previews are capped", async () => {
  const { ctxFor } = setup(); const owner = ctxFor("owner");
  const part = await get(owner, "preview", "bytes=10-19");
  assert.deepEqual([part.status, part.headers["Content-Range"], part.headers["Content-Length"]], [206, "bytes 10-19/1000", "10"]); assert.deepEqual(await read(part.body), BYTES.slice(10, 20));
  assert.deepEqual(await read((await get(owner, "preview", "bytes=-4")).body), BYTES.slice(996));
  const open = await get(owner, "preview", "bytes=990-"); assert.equal(open.headers["Content-Range"], "bytes 990-999/1000");
  const bad = await get(owner, "preview", "bytes=5000-"); assert.deepEqual([bad.status, bad.headers["Content-Range"], bad.body], [416, "bytes */1000", null]);
  assert.equal((await get(owner, "preview", "bytes=0-1,5-6")).status, 200); assert.equal((await get(owner, "preview", "nonsense")).status, 200);
  const big = setup({ sizeBytes: 9 * 1024 * 1024 }); big.storage.objects.set("media/owner/m1", new Uint8Array(9 * 1024 * 1024));
  const capped = await get(big.ctxFor("owner"), "preview", "bytes=0-"); assert.equal(capped.status, 206);
  assert.equal(Number(capped.headers["Content-Length"]), MAX_PARTIAL_BYTES); assert.equal((await read(capped.body)).length, MAX_PARTIAL_BYTES);
});

test("downloads are written to the audit log (who, which file) - previews and thumbnails are not", async () => {
  const { repo, ctxFor } = setup();
  await get(ctxFor("owner"), "thumbnail"); await get(ctxFor("owner"), "preview"); assert.equal(repo.audit.length, 0);
  await get(ctxFor("owner"), "download");
  assert.deepEqual(repo.audit.map((a) => [a.action, a.actorId, a.entityId, a.metadata]), [["media.downloaded", "owner", "m1", { byOwner: true }]]);
  assert.ok(!JSON.stringify(repo.audit).includes("media/owner"));
});

test("local disk storage streams ranges from the private folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clipforge-serve-")); tmp.push(dir);
  const storage = await LocalDiskMediaStorage.create(dir);
  await storage.stage("staging/s1", BYTES); await storage.commit("staging/s1", "media/owner/m1");
  assert.equal(await storage.statSize("media/owner/m1"), 1000); assert.equal(await storage.statSize("media/owner/nope"), null);
  assert.deepEqual(await read(await storage.openRead("media/owner/m1", { start: 5, end: 14 })), BYTES.slice(5, 15));
  assert.deepEqual(await read(await storage.openRead("media/owner/m1")), BYTES);
  await assert.rejects(() => storage.openRead("../etc/passwd"));
});

// ---------- the HTTP route ----------
test("ROUTE: GET /api/media/file works end to end; cross-site, bad ids and signed-out calls get clean JSON errors", async () => {
  const { repo, storage, ctxFor } = setup(); void repo;
  const runtime = (userId: string | null): Runtime => ({ mode: "demo", repo: ctxFor(userId).repo, currentUserId: async () => userId, newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) });
  const call = (userId: string | null, query: string, headers: Record<string, string> = {}) => mediaFileRoute(() => runtime(userId))(new Request(`http://localhost:3000/api/media/file?${query}`, { headers }));
  const ok = await call("owner", "id=m1&variant=preview", { range: "bytes=0-9" });
  assert.deepEqual([ok.status, ok.headers.get("content-range"), ok.headers.get("content-type")], [206, "bytes 0-9/1000", "video/mp4"]); assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), BYTES.slice(0, 10));
  assert.equal((await call("owner", "id=m1")).headers.get("content-type"), "image/jpeg");                                      // default variant: thumbnail
  assert.equal((await call("owner", "id=m1&variant=preview", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call(null, "id=m1&variant=preview")).status, 401);
  assert.equal((await call("owner", "variant=preview")).status, 422); assert.equal((await call("owner", "id=m1&variant=evil")).status, 422);
  const denied = await call("eve", "id=m1&variant=download"); assert.equal(denied.status, 404);
  const body = await denied.json() as { error: { code: string } }; assert.equal(body.error.code, "not_found"); assert.equal(denied.headers.get("cache-control"), "no-store");
});

test("ROUTE: unexpected storage failure logs only safe diagnostics and keeps the HTTP 500 generic", async () => {
  const { repo, storage, ctxFor } = setup();
  const sensitiveMessage = "secret-token signed-url https://private.example/key media/owner/m1 uploaded-name.mp4";
  const failingStorage = new Proxy(storage, {
    get(target, property) {
      if (property === "statSize") return async () => { throw Object.assign(new Error(sensitiveMessage), { name: "AccessDenied", code: "AccessDenied", $metadata: { httpStatusCode: 403 }, secret: "aws-secret" }); };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryMediaStorage;
  const runtime = (userId: string | null): Runtime => ({ mode: "demo", repo, currentUserId: async () => userId, newId: () => "x", now: () => NOW, media: async () => ({ storage: failingStorage, probe: null, maxUploadBytes: 1e9 }) });
  const lines: string[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const response = await mediaFileRoute(() => runtime("owner"))(new Request("http://localhost:3000/api/media/file?id=m1&variant=thumbnail"));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "internal_error", message: "Something went wrong on our side. Please try again." } });
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(lines.length, 1);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([log["event"], log["requestId"], log["variant"], log["operation"], log["provider"], log["errorCategory"], log["errorType"], log["errorName"], log["errorCode"], log["storageHttpStatus"]], [
      "media_file_serve_failed", requestId, "thumbnail", "storage.stat_size", "memory", "aws_permission_denied", "exception", "AccessDenied", "AccessDenied", 403,
    ]);
    assert.equal(lines.join(" ").includes(sensitiveMessage), false);
    assert.doesNotMatch(lines.join(" "), /aws-secret|private\.example|media\/owner\/m1|uploaded-name\.mp4|secret-token/);
  } finally { console.error = oldError; }
});

function s3StorageForRoute(options: { headError?: Error; getError?: Error; streamError?: Error } = {}) {
  const client = {
    async send(command: unknown): Promise<Record<string, unknown>> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "HeadObjectCommand") {
        if (options.headError) throw options.headError;
        return { ContentLength: BYTES.length, ContentType: "video/mp4" };
      }
      if (name === "GetObjectCommand") {
        if (options.getError) throw options.getError;
        const body = options.streamError
          ? Readable.from((async function* () { throw options.streamError; })())
          : Readable.from([BYTES]);
        Object.assign(body, { transformToWebStream: () => Readable.toWeb(body) as ReadableStream<Uint8Array> });
        return { Body: body };
      }
      throw new Error("Unexpected synthetic S3 command.");
    },
    destroy(): void {},
  };
  return new S3MediaStorage(client as unknown as S3Client, "clipforge-test-bucket");
}

test("ROUTE: S3 GetObject failure logs the underlying safe AWS cause and operation", async () => {
  const { repo } = setup();
  const sensitiveMessage = "synthetic token, signed URL, private media key";
  const storage = s3StorageForRoute({ getError: Object.assign(new Error(sensitiveMessage), { name: "InvalidToken", code: "InvalidToken", $metadata: { httpStatusCode: 400, requestId: "synthetic-s3-request" } }) });
  const runtime: Runtime = { mode: "demo", repo, currentUserId: async () => "owner", newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) };
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    const response = await mediaFileRoute(() => runtime)(new Request("http://localhost:3000/api/media/file?id=m1&variant=preview"));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: { code: "internal_error", message: "Something went wrong on our side. Please try again." } });
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(lines.length, 1);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([log["event"], log["requestId"], log["variant"], log["operation"], log["provider"], log["errorCategory"], log["errorName"], log["errorCode"], log["storageHttpStatus"], log["awsRequestId"]], [
      "media_file_serve_failed", requestId, "original", "s3.GetObject", "s3", "aws_credentials_or_session_token", "InvalidToken", "InvalidToken", 400, "synthetic-s3-request",
    ]);
    assert.doesNotMatch(lines.join(" "), /synthetic token|signed URL|private media key|clipforge-test-bucket|media\/owner/);
  } finally { console.error = originalError; }
});

test("ROUTE: S3 HeadObject failure is distinguished from GetObject and keeps the response generic", async () => {
  const { repo } = setup();
  const storage = s3StorageForRoute({ headError: Object.assign(new Error("synthetic permission response"), { name: "AccessDenied", code: "AccessDenied", $metadata: { httpStatusCode: 403, requestId: "synthetic-head-request" } }) });
  const runtime: Runtime = { mode: "demo", repo, currentUserId: async () => "owner", newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) };
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    const response = await mediaFileRoute(() => runtime)(new Request("http://localhost:3000/api/media/file?id=m1&variant=preview"));
    assert.equal(response.status, 500);
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(lines.length, 1);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([log["requestId"], log["operation"], log["errorCategory"], log["errorName"], log["errorCode"], log["storageHttpStatus"], log["awsRequestId"]], [
      requestId, "s3.HeadObject", "aws_permission_denied", "AccessDenied", "AccessDenied", 403, "synthetic-head-request",
    ]);
    assert.doesNotMatch(lines.join(" "), /synthetic permission response|clipforge-test-bucket|media\/owner/);
  } finally { console.error = originalError; }
});

test("ROUTE: S3 media read returns the private object bytes with safe response headers", async () => {
  const { repo } = setup();
  const storage = s3StorageForRoute();
  const runtime: Runtime = { mode: "demo", repo, currentUserId: async () => "owner", newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) };
  const response = await mediaFileRoute(() => runtime)(new Request("http://localhost:3000/api/media/file?id=m1&variant=preview"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), BYTES);
});

test("ROUTE: S3 media read succeeds, and a later body-stream failure is logged with its request reference", async () => {
  const { repo } = setup();
  const storage = s3StorageForRoute({ streamError: Object.assign(new Error("synthetic stream detail"), { code: "ECONNRESET" }) });
  const runtime: Runtime = { mode: "demo", repo, currentUserId: async () => "owner", newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) };
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
  try {
    const response = await mediaFileRoute(() => runtime)(new Request("http://localhost:3000/api/media/file?id=m1&variant=preview"));
    assert.equal(response.status, 200);
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/i);
    await assert.rejects(() => response.arrayBuffer());
    assert.equal(lines.length, 1);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual([log["event"], log["requestId"], log["operation"], log["errorCategory"], log["errorCode"]], ["media_s3_operation_failed", requestId, "s3.GetObjectStream", "storage_network_error", "ECONNRESET"]);
    assert.doesNotMatch(lines.join(" "), /synthetic stream detail|clipforge-test-bucket|media\/owner/);
  } finally { console.error = originalError; }
});

test("ROUTE: missing thumbnail remains a 404 and does not emit an unexpected-failure log", async () => {
  const { repo, storage } = setup({ thumbnail: false });
  const runtime: Runtime = { mode: "demo", repo, currentUserId: async () => "owner", newId: () => "x", now: () => NOW, media: async () => ({ storage, probe: null, maxUploadBytes: 1e9 }) };
  const lines: string[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const response = await mediaFileRoute(() => runtime)(new Request("http://localhost:3000/api/media/file?id=m1&variant=thumbnail"));
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "not_found");
    assert.equal(response.headers.has("x-request-id"), false);
    assert.equal(lines.length, 0);
  } finally { console.error = oldError; }
});

// ---------- thumbnails at upload ----------
const needReal = { skip: !ffmpegAvailable || !ffprobeInstalled ? "ffmpeg/ffprobe not installed" : false };

test("THUMBNAILS (real ffmpeg): an uploaded video and image each get a small real JPEG, stored beside the original and served through the checked route", needReal, async () => {
  const storage = new MemoryMediaStorage(); const repo = new MemoryRepository(); repo.plans.set("bob", "free"); let n = 0;
  const media: MediaServices = { storage, probe: await detectProbe(), thumbnail: makeThumbnailWithFfmpeg, maxUploadBytes: 1e8 };
  const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => `up${++n}`, config: { coverSupport: "unknown" }, media };
  const video = await uploadMedia(ctx, { filename: "a.mp4", declaredMimeType: "video/mp4", data: fixtures.mp4 });
  const image = await uploadMedia(ctx, { filename: "a.png", declaredMimeType: "image/png", data: fixtures.png });
  assert.deepEqual([video.hasThumbnail, image.hasThumbnail], [true, true]);
  const thumb = storage.objects.get(`thumb/bob/${video.mediaId}`)!; assert.deepEqual([...thumb.slice(0, 3)], [0xff, 0xd8, 0xff]); assert.ok(thumb.length > 100 && thumb.length < 100_000);
  assert.deepEqual([repo.media.get(video.mediaId)!.mimeType, repo.media.get(image.mediaId)!.mimeType], ["video/mp4", "image/png"]);
  assert.equal((await repo.getMediaStorageInfo(video.mediaId))!.thumbnailKey, `thumb/bob/${video.mediaId}`);
  const served = await serveMedia(ctx, { mediaId: video.mediaId, variant: "thumbnail", rangeHeader: null });
  assert.equal(served.headers["Content-Type"], "image/jpeg"); assert.deepEqual(await read(served.body), thumb);
  assert.equal(storage.staged.size, 0);
  assert.ok(!JSON.stringify(video).includes("thumb/bob"));
});

test("THUMBNAILS are optional: no maker, a maker that returns nothing, or one that throws -> the upload still succeeds without one", needReal, async () => {
  for (const thumbnail of [null, undefined, (async () => null) as ThumbnailMaker, (async () => { throw new Error("boom /secret/path"); }) as ThumbnailMaker, (async () => new Uint8Array(0)) as ThumbnailMaker]) {
    const storage = new MemoryMediaStorage(); const repo = new MemoryRepository(); let n = 0;
    const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => `up${++n}`, config: { coverSupport: "unknown" }, media: { storage, probe: null, thumbnail, maxUploadBytes: 1e8 } };
    const r = await uploadMedia(ctx, { filename: "a.png", declaredMimeType: "image/png", data: fixtures.png });
    assert.equal(r.hasThumbnail, false); assert.equal([...storage.objects.keys()].filter((k) => k.startsWith("thumb/")).length, 0); assert.equal(storage.staged.size, 0);
    assert.equal((await repo.getMediaStorageInfo(r.mediaId))!.thumbnailKey, null);
  }
});

test("THUMBNAILS: a failed upload (quota race loser) leaves NO thumbnail behind either", needReal, async () => {
  const storage = new MemoryMediaStorage(); const repo = new MemoryRepository(); repo.plans.set("bob", "free"); let n = 0;
  repo.media.set("big", makeMedia({ id: "big", ownerId: "bob", sizeBytes: 5 * 1024 ** 3 - fixtures.png.length - 10 }));
  const ctx: RequestContext = { userId: "bob", now: NOW, repo, newId: () => `up${++n}`, config: { coverSupport: "unknown" }, media: { storage, probe: null, thumbnail: makeThumbnailWithFfmpeg, maxUploadBytes: 1e8 } };
  const results = await Promise.allSettled([1, 2].map((i) => uploadMedia(ctx, { filename: `${i}.png`, declaredMimeType: "image/png", data: fixtures.png })).flat());
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(storage.objects.size, 2);                                                  // exactly the winner's original + thumbnail
  assert.equal([...storage.objects.keys()].filter((k) => k.startsWith("thumb/")).length, 1); assert.equal(storage.staged.size, 0);
});

// ---------- UI ----------
test("UI: media library explains validation and previews, shows the DB upload timestamp, and keeps owner-checked links", async () => {
  const uploadedAt = new Date("2026-11-14T10:30:00.000Z");
  const lib = renderToStaticMarkup(<MediaTable library={{ items: [{ id: "m1", title: "Clip", kind: "video", sizeBytes: 5e6, durationMs: 12_000, status: "active", validation: "verified", hasThumbnail: true, width: 160, height: 120, createdAt: uploadedAt }, { id: "m2", title: "Plain", kind: "image", sizeBytes: 1000, durationMs: null, status: "active", validation: "incomplete", hasThumbnail: false, width: null, height: null, createdAt: null }], total: 2, page: 1, pageCount: 1, pageSize: 24 }} />);
  assert.ok(lib.includes('src="/api/media/file?id=m1&amp;variant=thumbnail"')); assert.ok(lib.includes('src="/api/media/file?id=m2&amp;variant=preview"')); assert.ok(lib.includes('href="/media/m1"')); assert.ok(lib.includes("Incomplete"));
  assert.ok(lib.includes("Server media probe passed")); assert.ok(lib.includes("Full probe did not complete; no retry is queued")); assert.ok(lib.includes("Uploaded")); assert.ok(lib.includes('dateTime="2026-11-14T10:30:00.000Z"')); assert.ok(lib.includes("Unavailable"));
  const bareVideo = renderToStaticMarkup(<MediaTable library={{ items: [{ id: "m3", title: "Bare", kind: "video", sizeBytes: 1000, durationMs: 1000, status: "active", validation: "verified", hasThumbnail: false, width: 64, height: 64 }], total: 1, page: 1, pageCount: 1, pageSize: 24 }} />);
  assert.ok(bareVideo.includes("Preview unavailable; original unchanged"));
  assert.ok(!/storageKey|media\/owner|thumb\//.test(lib));
  const detailVideo = renderToStaticMarkup(<MediaDetailView timeZone="Asia/Kolkata" detail={{ mimeType: "video/mp4", addedAt: NOW, media: { id: "m1", title: "Clip", kind: "video", sizeBytes: 5e6, durationMs: 12_000, status: "active", validation: "verified", hasThumbnail: true, width: 160, height: 120 } }} />);
  for (const part of ["<video", 'controls', "variant=preview", "variant=thumbnail", "variant=download", "160 × 120", "0:12", "video/mp4", "decoded", "never change this original"]) assert.ok(detailVideo.includes(part), part);
  const detailIncomplete = renderToStaticMarkup(<MediaDetailView timeZone="UTC" detail={{ mimeType: null, addedAt: null, media: { id: "m2", title: "P", kind: "image", sizeBytes: 10, durationMs: null, status: "active", validation: "incomplete", hasThumbnail: false, width: null, height: null } }} />);
  assert.ok(detailIncomplete.includes("<img")); assert.ok(detailIncomplete.includes("signature accepted; ffprobe unavailable")); assert.ok(detailIncomplete.includes("Unknown"));
});

test("view models: media detail is owner-only (others see 'not found'); the library carries the thumbnail flag", async () => {
  const { repo, ctxFor } = setup();
  assert.equal((await getMediaDetail(ctxFor("owner"), "m1")).media.title, "Clip One.mp4");
  assert.equal((await errorOf(getMediaDetail(ctxFor("bob"), "m1"))).status, 404); assert.equal((await errorOf(getMediaDetail(ctxFor("owner"), "ghost"))).status, 404);
  assert.equal((await errorOf(getMediaDetail(ctxFor(null), "m1"))).status, 401);
  repo.media.set("m1", { ...repo.media.get("m1")!, status: "deleted" }); assert.equal((await errorOf(getMediaDetail(ctxFor("owner"), "m1"))).status, 404);
  const { repo: r2, ctxFor: c2 } = setup();
  const libraryItem = (await getMediaLibrary(c2("owner"), 1)).items[0]!;
  assert.equal(libraryItem.hasThumbnail, true);
  assert.deepEqual(libraryItem.createdAt, r2.media.get("m1")?.createdAt ?? null);
});
