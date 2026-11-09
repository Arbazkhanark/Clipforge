import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { AuthTokenInstagramOAuthStateStore } from "../src/server/instagram/oauth-state-store.ts";
import { PrismaAuthRepository } from "../src/server/prisma/prisma-auth-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { NOW } from "./helpers.ts";

test("OAuth state is stored as a hash, is owner-bound, expires, and can be consumed once", async () => {
  const repo = new MemoryAuthRepository();
  const store = new AuthTokenInstagramOAuthStateStore(repo, () => "oauth-state-row");
  await store.issue("random-state-value-00000000000000000000000000000000000000000", "owner1", NOW);
  const row = [...repo.tokens.values()][0]!;
  assert.equal(row.kind, "instagram_oauth_state");
  assert.equal(row.tokenHash.includes("random-state"), false);
  const state = "random-state-value-00000000000000000000000000000000000000000";
  assert.equal(await store.consume(state, NOW), "owner1");
  assert.equal(await store.consume(state, NOW), null);
  const expiredState = `${state}-expired`;
  await store.issue(expiredState, "owner1", NOW);
  assert.equal(await store.consume(expiredState, new Date(NOW.getTime() + 600_000)), null);
});

test("new OAuth state invalidates the previous outstanding state for that account owner", async () => {
  const repo = new MemoryAuthRepository();
  let id = 0;
  const store = new AuthTokenInstagramOAuthStateStore(repo, () => `state-${++id}`);
  await store.issue("older-state", "owner1", NOW);
  await store.issue("newer-state", "owner1", NOW);
  assert.equal(await store.consume("older-state", NOW), null);
  assert.equal(await store.consume("newer-state", NOW), "owner1");
});

test("Prisma-backed OAuth state stores only a hash and atomic consume rejects replay and expiry", async () => {
  const db = new FakePrismaClient();
  let sequence = 0;
  const store = new AuthTokenInstagramOAuthStateStore(new PrismaAuthRepository(db), () => `prisma-state-row-${++sequence}`);
  const state = "fake-prisma-state-that-is-never-a-real-credential";
  await store.issue(state, "owner1", NOW);
  const row = db.authToken.rows[0]!;
  assert.equal(row["tokenHash"].includes(state), false);
  const outcomes = await Promise.all([store.consume(state, NOW), store.consume(state, NOW)]);
  assert.deepEqual(outcomes.sort(), [null, "owner1"]);
  const expiredState = `${state}-expired`;
  await store.issue(expiredState, "owner1", NOW);
  assert.equal(await store.consume(expiredState, new Date(NOW.getTime() + 600_000)), null);
});
