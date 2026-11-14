import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { makeCycle, makeItem, makeMedia, NOW } from "./helpers.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import { renderKeyFor } from "../src/server/storage/media-storage.ts";
import { authorizePublishingCover, authorizeRenderedPublishingOutput, createConfiguredTemporaryMediaAccessAdapter, HmacTemporaryMediaAccessAdapter, MockTemporaryMediaAccessAdapter, prepareTemporaryPublishingAccess, prepareTemporaryPublishingCoverAccess } from "../src/server/storage/temporary-media-access.ts";

const BYTES = new Uint8Array([0, 1, 2, 3, 4]);

async function setup() {
  const repo = new MemoryRepository();
  const storage = new MemoryMediaStorage();
  const key = renderKeyFor("bob", "render-output");
  await repo.createCycle({ ...makeCycle({ id: "cycle1", ownerId: "bob", status: "running" }), name: "Reels", socialAccountId: "account1" });
  repo.items.set("item1", makeItem({ id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "source1", selectedRenderOutputId: "render-output", sourceKind: "owned", sourceCollectionId: null, status: "scheduled", scheduledFor: new Date(NOW.getTime() - 1) }));
  repo.media.set("source1", makeMedia({ id: "source1", ownerId: "bob", kind: "video", sizeBytes: BYTES.length }));
  repo.renders.set("render-output", { id: "render-output", sourceMediaId: "source1", ownerId: "bob", storageKey: key, sizeBytes: BYTES.length, settingsHash: "hash", createdAt: NOW });
  await storage.stage("staging/output1", BYTES);
  await storage.commit("staging/output1", key);
  return { repo, storage, key };
}

test("only an owned rendered output for the exact due item receives a server authorization capability", async () => {
  const { repo, storage } = await setup();
  const authorized = await authorizeRenderedPublishingOutput(repo, storage, { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW });
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") return;
  assert.deepEqual(authorized.output, { outputId: "render-output", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", sourceMediaId: "source1", sizeBytes: BYTES.length, mimeType: "video/mp4" });
  assert.equal(JSON.stringify(authorized.output).includes("storageKey"), false);
  assert.equal(JSON.stringify(authorized.output).includes("/tmp"), false);
});

test("original uploads, wrong owners, wrong source relationships, and stopped cycles are not eligible", async () => {
  const { repo, storage } = await setup();
  const request = { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW };
  assert.equal((await authorizeRenderedPublishingOutput(repo, storage, request)).status, "authorized");
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: null });
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, request), { status: "media_not_eligible" });
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: "render-output" });
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, { ...request, ownerId: "mallory" }), { status: "media_not_eligible" });
  repo.renders.set("render-output", { ...repo.renders.get("render-output")!, sourceMediaId: "other-source" });
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, request), { status: "media_not_eligible" });
  repo.renders.set("render-output", { ...repo.renders.get("render-output")!, sourceMediaId: "source1" });
  repo.cycles.set("cycle1", { ...repo.cycles.get("cycle1")!, status: "stopped" });
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, request), { status: "media_not_eligible" });
});

test("missing and size-mismatched render objects are not available", async () => {
  const { repo, storage, key } = await setup();
  await storage.deleteUnreferencedUpload(key);
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW }), { status: "media_not_available" });
  await storage.stage("staging/output1", BYTES);
  await storage.commit("staging/output1", key);
  repo.renders.set("render-output", { ...repo.renders.get("render-output")!, sizeBytes: BYTES.length + 1 });
  assert.deepEqual(await authorizeRenderedPublishingOutput(repo, storage, { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW }), { status: "media_not_available" });
});

test("mock URL is deterministic, output-scoped, expires, and never claims public reachability", async () => {
  const { repo, storage } = await setup();
  const auth = await authorizeRenderedPublishingOutput(repo, storage, { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW });
  assert.equal(auth.status, "authorized");
  if (auth.status !== "authorized") return;
  const adapter = new MockTemporaryMediaAccessAdapter();
  const first = await adapter.createTemporaryAccess(auth.output, NOW, 5);
  const second = await adapter.createTemporaryAccess(auth.output, NOW, 5);
  assert.equal(first.url, second.url);
  assert.match(first.url, /^https:\/\/media-access\.mock\.invalid\//);
  assert.equal(first.url.includes("render-output"), false);
  assert.equal(first.publiclyReachable, false);
  assert.equal(await adapter.validateTemporaryAccess(first.url, auth.output, NOW), true);
  assert.equal(await adapter.validateTemporaryAccess(first.url, { ...auth.output, outputId: "different-output" }, NOW), false);
  await assert.rejects(() => adapter.createTemporaryAccess({ ...auth.output, outputId: "forged-output" }, NOW, 5), /not authorized/);
  assert.equal(await adapter.validateTemporaryAccess(first.url, auth.output, new Date(first.expiresAt.getTime())), false);
});

test("provider URL is signed, HTTPS, single-output scoped, and expires; untrusted origins are refused", async () => {
  const { repo, storage } = await setup();
  const auth = await authorizeRenderedPublishingOutput(repo, storage, { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW });
  assert.equal(auth.status, "authorized");
  if (auth.status !== "authorized") return;
  const adapter = new HmacTemporaryMediaAccessAdapter("https://clipforge.example.test", Buffer.alloc(32, 4));
  const grant = await adapter.createTemporaryAccess(auth.output, NOW, 300);
  assert.equal(grant.publiclyReachable, true);
  assert.equal(new URL(grant.url).pathname.startsWith("/api/publishing-media/"), true);
  assert.equal(await adapter.validateTemporaryAccess(grant.url, auth.output, NOW), true);
  assert.equal(await adapter.validateTemporaryAccess(grant.url, { ...auth.output, outputId: "other" }, NOW), false);
  assert.equal(await adapter.validateTemporaryAccess(grant.url, auth.output, grant.expiresAt), false);
  assert.equal(await adapter.validateTemporaryAccess(`${grant.url}x`, auth.output, NOW), false);
  assert.throws(() => new HmacTemporaryMediaAccessAdapter("http://clipforge.example.test", Buffer.alloc(32, 4)));
  assert.throws(() => new HmacTemporaryMediaAccessAdapter("https://localhost", Buffer.alloc(32, 4)));
});

test("configured temporary-media access requires a public HTTPS origin and a canonical 32-byte signing key", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.equal(createConfiguredTemporaryMediaAccessAdapter({}), null);
  assert.equal(createConfiguredTemporaryMediaAccessAdapter({ CLIPFORGE_PUBLIC_MEDIA_ORIGIN: "https://clipforge.example" }), null);
  assert.equal(createConfiguredTemporaryMediaAccessAdapter({ CLIPFORGE_TEMP_MEDIA_SIGNING_KEY: key }), null);
  assert.equal(createConfiguredTemporaryMediaAccessAdapter({ CLIPFORGE_PUBLIC_MEDIA_ORIGIN: "http://clipforge.example", CLIPFORGE_TEMP_MEDIA_SIGNING_KEY: key }), null);
  assert.ok(createConfiguredTemporaryMediaAccessAdapter({ CLIPFORGE_PUBLIC_MEDIA_ORIGIN: "https://clipforge.example", CLIPFORGE_TEMP_MEDIA_SIGNING_KEY: key }));
});

test("preparation distinguishes missing storage, ineligible originals, unconfigured adapter, and mock-ready access", async () => {
  const { repo, storage } = await setup();
  const input = { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW };
  assert.deepEqual(await prepareTemporaryPublishingAccess(repo, null, new MockTemporaryMediaAccessAdapter(), input), { status: "media_not_available" });
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: null });
  assert.deepEqual(await prepareTemporaryPublishingAccess(repo, storage, null, input), { status: "media_not_eligible" });
  repo.items.set("item1", { ...repo.items.get("item1")!, selectedRenderOutputId: "render-output" });
  assert.deepEqual(await prepareTemporaryPublishingAccess(repo, storage, null, input), { status: "temporary_access_not_configured" });
  const ready = await prepareTemporaryPublishingAccess(repo, storage, new MockTemporaryMediaAccessAdapter(), input);
  assert.equal(ready.status, "temporary_media_access_ready");
  if (ready.status === "temporary_media_access_ready") assert.equal(ready.publiclyReachable, false);
});

test("only the selected, owned, active JPEG within the size limit receives temporary cover access", async () => {
  const { repo, storage } = await setup();
  const item = repo.items.get("item1")!;
  repo.items.set("item1", { ...item, coverMediaId: "cover1" });
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0]);
  const coverKey = "media/bob/cover1";
  repo.media.set("cover1", makeMedia({ id: "cover1", ownerId: "bob", kind: "image", mimeType: "image/jpeg", status: "active", sizeBytes: coverBytes.length }));
  repo.storageKeys.set("cover1", coverKey);
  await storage.stage("staging/cover", coverBytes); await storage.commit("staging/cover", coverKey);
  const args = { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW };
  const authorized = await authorizePublishingCover(repo, storage, args);
  assert.equal(authorized.status, "authorized");
  if (authorized.status !== "authorized") return;
  assert.deepEqual(authorized.cover, { mediaId: "cover1", ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", sizeBytes: coverBytes.length, mimeType: "image/jpeg" });
  const adapter = new HmacTemporaryMediaAccessAdapter("https://clipforge.example.test", Buffer.alloc(32, 9));
  const prepared = await prepareTemporaryPublishingCoverAccess(repo, storage, adapter, args);
  assert.equal(prepared.status, "temporary_cover_access_ready");
  if (prepared.status !== "temporary_cover_access_ready") return;
  assert.equal(prepared.publiclyReachable, true);
  assert.equal(new URL(prepared.url).pathname.startsWith("/api/publishing-covers/"), true);
  assert.equal(await adapter.validateTemporaryCoverAccess(prepared.url, authorized.cover, NOW), true);
  assert.equal(await adapter.validateTemporaryCoverAccess(prepared.url, { ...authorized.cover, ownerId: "mallory" }, NOW), false);
  assert.equal(await adapter.validateTemporaryCoverAccess(prepared.url, authorized.cover, prepared.expiresAt), false);
});

test("unselected, foreign, non-JPEG, oversized, or missing cover objects fail closed", async () => {
  const { repo, storage } = await setup();
  const args = { ownerId: "bob", cycleId: "cycle1", cycleItemId: "item1", now: NOW };
  assert.deepEqual(await authorizePublishingCover(repo, storage, args), { status: "cover_not_selected" });
  const setCover = (changes: Parameters<typeof makeMedia>[0] = {}) => {
    repo.items.set("item1", { ...repo.items.get("item1")!, coverMediaId: "cover1" });
    repo.media.set("cover1", makeMedia({ id: "cover1", ownerId: "bob", kind: "image", mimeType: "image/jpeg", status: "active", sizeBytes: 4, ...changes }));
    repo.storageKeys.set("cover1", "media/bob/cover1");
  };
  setCover({ ownerId: "mallory" });
  assert.deepEqual(await authorizePublishingCover(repo, storage, args), { status: "media_not_eligible" });
  setCover({ mimeType: "image/png" });
  assert.deepEqual(await authorizePublishingCover(repo, storage, args), { status: "media_not_eligible" });
  setCover({ sizeBytes: 8_000_001 });
  assert.deepEqual(await authorizePublishingCover(repo, storage, args), { status: "media_not_eligible" });
  setCover();
  assert.deepEqual(await authorizePublishingCover(repo, storage, args), { status: "media_not_available" });
});
