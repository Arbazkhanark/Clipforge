import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstagramPublishingAdapters, isPublicInstagramMediaUrl } from "../src/server/publishing/instagram-publishing-adapter.ts";

const input = { attemptId: "attempt1", idempotencyKey: "key1", cycleId: "cycle1", cycleItemId: "item1", ownerId: "owner1", socialAccountId: "account1", instagramAccountId: "1789001", mediaAssetId: "source1", renderOutputId: "render1", selectedRenderOutputId: "render1", videoUrl: "https://media.example.test/api/publishing-media/signed", caption: "A Reel" };

test("official adapter creates, polls and publishes a Reel using selected public rendered output", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const responses = [Response.json({ id: "container1" }), Response.json({ status_code: "FINISHED" }), Response.json({ id: "instagram-media1" })];
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake-token" }), fetchImpl: async (url, init) => { calls.push({ url: new URL(String(url)), init }); return responses.shift()!; } });
  assert.deepEqual(await adapter.createContainer(input), { kind: "created", containerId: "container1" });
  assert.deepEqual(await adapter.pollContainer({ ...input, containerId: "container1" }), { kind: "ready" });
  assert.deepEqual(await adapter.publishContainer({ ...input, containerId: "container1" }), { kind: "confirmed", instagramMediaId: "instagram-media1" });
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/v25.0/1789001/media", "/v25.0/container1", "/v25.0/1789001/media_publish"]);
  assert.equal(new URLSearchParams(String(calls[0]?.init?.body)).get("media_type"), "REELS");
  assert.equal(new URLSearchParams(String(calls[0]?.init?.body)).get("video_url"), input.videoUrl);
  assert.equal(new URLSearchParams(String(calls[0]?.init?.body)).get("media_asset_id"), null);
  assert.equal(new URLSearchParams(String(calls[2]?.init?.body)).get("creation_id"), "container1");
  for (const call of calls) {
    assert.equal(call.url.searchParams.has("access_token"), false);
    assert.equal((call.init?.headers as Record<string, string>).authorization, "Bearer fake-token");
  }
});

test("unreachable mock/original URLs and unselected outputs are rejected before any provider call", async () => {
  let calls = 0;
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async () => { calls++; return Response.json({ id: "x" }); } });
  assert.deepEqual(await adapter.createContainer({ ...input, videoUrl: "https://media-access.mock.invalid/file" }), { kind: "definite_failure", category: "media_unavailable" });
  assert.deepEqual(await adapter.createContainer({ ...input, renderOutputId: "source1" }), { kind: "definite_failure", category: "media_unavailable" });
  assert.equal(calls, 0);
  assert.equal(isPublicInstagramMediaUrl("https://media.example.test/path"), true);
  assert.equal(isPublicInstagramMediaUrl("http://media.example.test/path"), false);
  assert.equal(isPublicInstagramMediaUrl("https://media-access.mock.invalid/path"), false);
});

test("Reel cover and supported frame offset are sent in the container request", async () => {
  let call: { url: URL; init?: RequestInit } | undefined;
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake-token" }), fetchImpl: async (url, init) => { call = { url: new URL(String(url)), init }; return Response.json({ id: "cover-container" }); } });
  const coverUrl = "https://media.example.test/api/publishing-covers/signed";
  assert.deepEqual(await adapter.createContainer({ ...input, coverSelected: true, coverUrl, thumbOffsetMs: 1250 }), { kind: "created", containerId: "cover-container" });
  assert.equal(call?.url.pathname, "/v25.0/1789001/media");
  const body = new URLSearchParams(String(call?.init?.body));
  assert.equal(body.get("cover_url"), coverUrl);
  assert.equal(body.get("thumb_offset"), "1250");
  assert.equal(body.get("media_type"), "REELS");
});

test("selected but missing, non-public, or otherwise invalid covers fail before Meta is called", async () => {
  let calls = 0;
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async () => { calls++; return Response.json({ id: "unexpected" }); } });
  for (const change of [{ coverSelected: true }, { coverSelected: true, coverUrl: "https://media-access.mock.invalid/cover" }, { coverSelected: false, coverUrl: "https://media.example.test/cover" }, { coverSelected: true, coverUrl: "https://media.example.test/cover", thumbOffsetMs: 900_001 }]) {
    assert.deepEqual(await adapter.createContainer({ ...input, ...change }), { kind: "definite_failure", category: "media_unavailable" });
  }
  assert.equal(calls, 0);
});

test("no-cover legacy request remains compatible and sends no cover parameters", async () => {
  let body: URLSearchParams | undefined;
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async (_url, init) => { body = new URLSearchParams(String(init?.body)); return Response.json({ id: "legacy-container" }); } });
  assert.deepEqual(await adapter.createContainer(input), { kind: "created", containerId: "legacy-container" });
  assert.equal(body?.has("cover_url"), false);
  assert.equal(body?.has("thumb_offset"), false);
});

test("live account publishing quota is requested with the pinned API version and fails closed", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async (_owner, account) => { assert.equal(account, "account1"); return { status: "ready", accessToken: "fake-token" }; }, fetchImpl: async (url, init) => { calls.push({ url: new URL(String(url)), init }); return Response.json({ data: [{ quota_usage: 24, config: { quota_total: 25, quota_duration: 86_400 } }] }); } });
  assert.deepEqual(await adapter.checkPublishingQuota(input), { kind: "available", usage: 24, total: 25, durationSeconds: 86_400 });
  assert.equal(calls[0]?.url.pathname, "/v25.0/1789001/content_publishing_limit");
  assert.equal(calls[0]?.url.searchParams.get("fields"), "quota_usage,config");
  assert.equal(calls[0]?.url.searchParams.has("access_token"), false);
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer fake-token");
});

test("full and malformed quota responses are unknown rather than guessed", async () => {
  const responses = [
    Response.json({ data: [{ quota_usage: 25, config: { quota_total: 25, quota_duration: 86_400 } }] }),
    Response.json({ data: [{ quota_usage: 24 }] }),
    Response.json({ data: [{ quota_usage: "24", config: { quota_total: 25, quota_duration: 86_400 } }] }),
    new Response(null, { status: 403 }),
  ];
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async () => responses.shift()! });
  assert.deepEqual(await adapter.checkPublishingQuota(input), { kind: "limit_reached", usage: 25, total: 25, durationSeconds: 86_400 });
  assert.deepEqual(await adapter.checkPublishingQuota(input), { kind: "unknown" });
  assert.deepEqual(await adapter.checkPublishingQuota(input), { kind: "unknown" });
  assert.deepEqual(await adapter.checkPublishingQuota(input), { kind: "unknown" });
  const networkFailure = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async () => { throw new Error("network"); } });
  assert.deepEqual(await networkFailure.checkPublishingQuota(input), { kind: "unknown" });
  const unavailable = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "unavailable" }), fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(await unavailable.checkPublishingQuota(input), { kind: "unknown" });
});

test("network or server errors during publication remain ambiguous and verifier never triggers a retry", async () => {
  const adapter = createInstagramPublishingAdapters({ graphApiVersion: "v25.0", access: async () => ({ status: "ready", accessToken: "fake" }), fetchImpl: async () => { throw new Error("network"); } });
  assert.deepEqual(await adapter.publishContainer({ ...input, containerId: "container1" }), { kind: "ambiguous" });
  assert.deepEqual(await adapter.verifyPublishingResult({ ...input, containerId: "container1" }), { kind: "unknown" });
});
