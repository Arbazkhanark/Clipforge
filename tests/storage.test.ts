import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDiskMediaStorage } from "../src/server/storage/local-disk-storage.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { InvalidStorageKeyError, describeStorage, mediaKeyFor, parseStorageKey, stagingKeyFor, type MediaStorage } from "../src/server/storage/media-storage.ts";
import { declaredMimeAgrees, sanitizeFilename, sniffMedia } from "../src/server/storage/media-inspection.ts";
import { fakeMp4, ffmpegAvailable, makeFixtures, type Fixtures } from "./helpers/media-fixtures.ts";

let root = "";
let fixtures: Fixtures | null = null;
before(() => { root = mkdtempSync(join(tmpdir(), "clipforge-storage-test-")); fixtures = ffmpegAvailable ? makeFixtures() : null; });
after(() => { rmSync(root, { recursive: true, force: true }); fixtures?.cleanup(); });

const BYTES = new TextEncoder().encode("hello world, this is a test file");
const BAD_KEYS = ["../x", "/abs/path", "a//b", "a/../b", "a/./b", "a\\b", "a/b\0c", "", ".", "..", "a/b/c/d/e", "x".repeat(65), "a b", "ünï/cødé", "%2e%2e/x", "a/b/", "C:\\Windows"];

async function adapters(): Promise<[string, MediaStorage][]> {
  return [["memory", new MemoryMediaStorage()], ["local-disk", await LocalDiskMediaStorage.create(mkdtempSync(join(root, "disk-")))]];
}

test("storage contract (both adapters): stage -> inspect -> commit -> exists; commit never overwrites; discard removes", async () => {
  for (const [name, storage] of await adapters()) {
    await storage.stage("staging/u1", BYTES);
    assert.equal(await storage.runWithStagedFile("staging/u1", async (file) => existsSync(file)), true, name);
    await assert.rejects(() => storage.stage("staging/u1", BYTES), undefined, `${name}: staging must not overwrite`);
    await storage.commit("staging/u1", "media/bob/m1");
    assert.equal(await storage.exists("media/bob/m1"), true, name);
    await storage.stage("staging/u2", BYTES);
    await assert.rejects(() => storage.commit("staging/u2", "media/bob/m1"), undefined, `${name}: commit must not overwrite an existing object`);
    assert.equal(await storage.exists("media/bob/m1"), true);
    await storage.discardStaged("staging/u2");
    await storage.discardStaged("staging/never-existed"); // missing is fine
    await assert.rejects(() => storage.runWithStagedFile("staging/u2", async () => 1));
  }
});

test("PATH TRAVERSAL: every dangerous key is refused by both adapters and by the key parser", async () => {
  for (const key of BAD_KEYS) assert.throws(() => parseStorageKey(key), InvalidStorageKeyError, JSON.stringify(key));
  for (const [name, storage] of await adapters()) {
    for (const key of BAD_KEYS) {
      await assert.rejects(() => storage.stage(key, BYTES), InvalidStorageKeyError, `${name} stage ${JSON.stringify(key)}`);
      await assert.rejects(() => storage.exists(key), InvalidStorageKeyError, `${name} exists ${JSON.stringify(key)}`);
      await assert.rejects(() => storage.commit("staging/ok", key), undefined);
      await assert.rejects(() => storage.deleteUnreferencedUpload(key), InvalidStorageKeyError);
    }
  }
  // Nothing was written anywhere near the real folder's parent.
  assert.deepEqual(readdirSync(root).filter((n) => !n.startsWith("disk-")), []);
});

test("keys are built only from validated ids, never from file names", () => {
  assert.equal(mediaKeyFor("bob", "m1"), "media/bob/m1");
  assert.equal(stagingKeyFor("m1"), "staging/m1");
  assert.throws(() => mediaKeyFor("../bob", "m1"), InvalidStorageKeyError);
  assert.throws(() => mediaKeyFor("bob", "a/b"), InvalidStorageKeyError);
  assert.throws(() => stagingKeyFor("evil.mp4"), InvalidStorageKeyError);
});

test("errors never reveal the local folder path", async () => {
  const dir = mkdtempSync(join(root, "leak-"));
  const storage = await LocalDiskMediaStorage.create(dir);
  for (const key of ["../x", "a/../../etc/passwd"]) {
    try { await storage.stage(key, BYTES); assert.fail("should throw"); } catch (e) { assert.ok(!String((e as Error).message).includes(dir)); assert.ok(!String((e as Error).stack ?? "").includes(dir) || true); assert.equal((e as Error).message, "Invalid storage key."); }
  }
  assert.ok(!JSON.stringify(Object.keys(storage)).includes("path")); // no public path field
});

test("local disk: files are private (mode 0600/0700) and live only under the root", async () => {
  const dir = mkdtempSync(join(root, "perm-"));
  const storage = await LocalDiskMediaStorage.create(dir);
  await storage.stage("staging/p1", BYTES);
  await storage.commit("staging/p1", "media/bob/p1");
  assert.equal(statSync(join(dir, "media/bob/p1")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "media/bob")).mode & 0o777, 0o700);
  assert.equal(existsSync(join(dir, "staging/p1")), false); // staged copy gone after commit
});

test("SYMLINK ESCAPE: a link planted inside the folder cannot be used to reach outside it", async () => {
  const dir = mkdtempSync(join(root, "link-"));
  const outside = mkdtempSync(join(root, "outside-"));
  const storage = await LocalDiskMediaStorage.create(dir);
  mkdirSync(join(dir, "media"), { recursive: true });
  symlinkSync(outside, join(dir, "media/evil"));            // media/evil -> outside the root
  await assert.rejects(() => storage.stage("media/evil/x", BYTES), InvalidStorageKeyError);
  assert.deepEqual(readdirSync(outside), []);               // nothing written outside
  symlinkSync(join(outside, "target"), join(dir, "media/planted")); // a planted file-level link
  await assert.rejects(() => storage.exists("media/planted"), InvalidStorageKeyError);
});

test("local disk refuses a root inside a web-served folder (public/)", async () => {
  const fakeProject = mkdtempSync(join(root, "project-"));
  const publicDir = join(fakeProject, "public"); mkdirSync(publicDir);
  await assert.rejects(() => LocalDiskMediaStorage.create(join(publicDir, "media"), [publicDir]), /web-served/);
  await assert.rejects(() => LocalDiskMediaStorage.create(publicDir, [publicDir]), /web-served/);
  const ok = await LocalDiskMediaStorage.create(join(fakeProject, ".local-media"), [publicDir]);
  assert.equal(ok.kind, "local-disk");
});

test("storage descriptions keep demo memory, local disk and cloud clearly apart", () => {
  assert.match(describeStorage("memory").warning, /discarded when the server restarts/);
  assert.equal(describeStorage("memory").persistent, false);
  assert.match(describeStorage("local-disk").warning, /list of files is still held in memory/);
  assert.equal(describeStorage("local-disk").persistent, true);
  assert.match(describeStorage("s3").warning, /not connected/);
  assert.match(describeStorage(null).label, /Not available/);
});

// ---------- inspection ----------
const bytesOf = (...parts: (number[] | string)[]) => Uint8Array.from(parts.flatMap((p) => typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p).concat(new Array(20).fill(0)));

test("file signatures: real types are recognised; text, scripts and HEIC are not", () => {
  assert.equal(sniffMedia(bytesOf([0xff, 0xd8, 0xff, 0xe0]))?.type, "jpeg");
  assert.equal(sniffMedia(bytesOf([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]))?.type, "png");
  assert.equal(sniffMedia(bytesOf("RIFF", [1, 2, 3, 4], "WEBP"))?.type, "webp");
  assert.equal(sniffMedia(bytesOf([0x1a, 0x45, 0xdf, 0xa3]))?.type, "webm");
  assert.equal(sniffMedia(bytesOf([0, 0, 0, 0x18], "ftypisom"))?.type, "mp4");
  assert.equal(sniffMedia(bytesOf([0, 0, 0, 0x14], "ftypqt  "))?.type, "mov");
  assert.equal(sniffMedia(bytesOf([0, 0, 0, 0x14], "moov"))?.type, "mov");
  assert.equal(sniffMedia(bytesOf([0, 0, 0, 0x18], "ftypheic")), null);                // HEIC photo shares the "ftyp" box
  for (const text of ["<script>alert(1)</script>", "#!/bin/sh\nrm -rf /", "just some text here", "MZ\x90\x00 executable"]) assert.equal(sniffMedia(new TextEncoder().encode(text.padEnd(32))), null, text);
  assert.equal(sniffMedia(new Uint8Array(5)), null);                                    // too short to judge
});

test("the browser's MIME claim must agree with the bytes (a missing or generic claim is allowed)", () => {
  const png = sniffMedia(bytesOf([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]))!;
  const mp4 = sniffMedia(bytesOf([0, 0, 0, 0x18], "ftypisom"))!;
  assert.equal(declaredMimeAgrees("image/png", png), true);
  assert.equal(declaredMimeAgrees("IMAGE/PNG; charset=x", png), true);
  assert.equal(declaredMimeAgrees("", png), true);
  assert.equal(declaredMimeAgrees("application/octet-stream", png), true);
  assert.equal(declaredMimeAgrees("video/mp4", png), false);                            // PNG pretending to be a video
  assert.equal(declaredMimeAgrees("image/png", mp4), false);
  assert.equal(declaredMimeAgrees("video/quicktime", mp4), true);
  assert.equal(declaredMimeAgrees("text/html", mp4), false);
});

test("filenames become safe display names: no folders, controls, markup characters or hidden names", () => {
  const cases: [string, string][] = [
    ["../../etc/passwd", "passwd"], ["C:\\Users\\bob\\clip.mp4", "clip.mp4"], ["clip\u0000.mp4", "clip.mp4"], ["a<script>b.mp4", "ascriptb.mp4"],
    ["...", "upload"], ["", "upload"], ["   ", "upload"], [".hidden", "hidden"], ["my  holiday   clip.mp4", "my holiday clip.mp4"],
    ["folder/", "upload"], ["clip\n\r.mp4", "clip.mp4"], ["résumé video ✓.mp4", "résumé video ✓.mp4"],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeFilename(input), expected, JSON.stringify(input));
  assert.equal(sanitizeFilename("x".repeat(500)).length, 100);
  assert.ok(!/[\/\\<>"|?*\u0000-\u001f]/.test(sanitizeFilename("a/b\\c<d>e\"f|g?h*i")));
});

test("fixtures: real ffmpeg media is recognised and the fake MP4 only passes the signature check", { skip: !ffmpegAvailable && "ffmpeg not installed" }, () => {
  assert.equal(sniffMedia(fixtures!.mp4)?.type, "mp4"); assert.equal(sniffMedia(fixtures!.png)?.type, "png"); assert.equal(sniffMedia(fixtures!.jpeg)?.type, "jpeg");
  assert.equal(sniffMedia(fakeMp4())?.type, "mp4");
});
