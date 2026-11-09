import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { accessInstagramToken } from "../src/server/instagram/instagram-token-access.ts";
import { decryptToken, encryptToken } from "../src/server/instagram/token-cipher.ts";
import { NOW } from "./helpers.ts";

const key = Buffer.alloc(32, 9);
const scopes = ["instagram_business_basic", "instagram_business_content_publish"];
async function repoWithToken(expiresAt: Date) {
  const repo = new MemoryRepository();
  await repo.saveInstagramConnection({ id: "ig1", userId: "owner1", externalAccountId: "1789001", username: "creator", accountType: "BUSINESS", grantedScopes: scopes, tokenExpiresAt: expiresAt, encryptedAccessToken: encryptToken(key, "fake-old-token") });
  return repo;
}

test("server token boundary returns current fake token without refreshing a valid long-lived token", async () => {
  const repo = await repoWithToken(new Date(NOW.getTime() + 30 * 86_400_000));
  const result = await accessInstagramToken({ repo, ownerId: "owner1", accountId: "ig1", encryptionKey: key, now: NOW, fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(result, { status: "ready", accessToken: "fake-old-token", expiresAt: new Date(NOW.getTime() + 30 * 86_400_000) });
});

test("near-expiry token refreshes through injected transport and stores only encrypted replacement", async () => {
  const repo = await repoWithToken(new Date(NOW.getTime() + 2 * 86_400_000));
  const requested: URL[] = [];
  const result = await accessInstagramToken({ repo, ownerId: "owner1", accountId: "ig1", encryptionKey: key, now: NOW, fetchImpl: async (input) => { requested.push(new URL(String(input))); return Response.json({ access_token: "fake-refreshed-token", expires_in: 5_184_000 }); } });
  assert.equal(result.status, "ready");
  assert.equal(requested[0]?.origin, "https://graph.instagram.com");
  assert.equal(requested[0]?.pathname, "/refresh_access_token");
  assert.equal(requested[0]?.searchParams.get("grant_type"), "ig_refresh_token");
  const stored = await repo.getInstagramTokenCiphertext("owner1", "ig1");
  assert.ok(stored);
  assert.equal(stored.encryptedAccessToken.includes("fake-refreshed-token"), false);
  assert.equal(decryptToken(key, stored.encryptedAccessToken), "fake-refreshed-token");
});

test("refresh failure, expired token, invalid ciphertext and wrong owner fail closed", async () => {
  const expiring = await repoWithToken(new Date(NOW.getTime() + 1000));
  const failed = await accessInstagramToken({ repo: expiring, ownerId: "owner1", accountId: "ig1", encryptionKey: key, now: NOW, fetchImpl: async () => new Response("no", { status: 500 }) });
  assert.deepEqual(failed, { status: "refresh_failed" });
  assert.deepEqual(await accessInstagramToken({ repo: expiring, ownerId: "wrong", accountId: "ig1", encryptionKey: key, now: NOW }), { status: "not_eligible" });
  const expired = await repoWithToken(new Date(NOW.getTime() - 1));
  assert.deepEqual(await accessInstagramToken({ repo: expired, ownerId: "owner1", accountId: "ig1", encryptionKey: key, now: NOW }), { status: "expired" });
  const invalid = await repoWithToken(new Date(NOW.getTime() + 30 * 86_400_000));
  assert.equal(await invalid.updateInstagramTokenCiphertext("owner1", "ig1", (await invalid.getInstagramTokenCiphertext("owner1", "ig1"))!.encryptedAccessToken, "broken-ciphertext", new Date(NOW.getTime() + 30 * 86_400_000)), true);
  assert.deepEqual(await accessInstagramToken({ repo: invalid, ownerId: "owner1", accountId: "ig1", encryptionKey: key, now: NOW }), { status: "invalid_ciphertext" });
});
