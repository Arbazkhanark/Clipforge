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
  assert.deepEqual(await store.consume(state, NOW), { status: "consumed", userId: "owner1" });
  assert.deepEqual(await store.consume(state, NOW), { status: "already_consumed" });
  const expiredState = `${state}-expired`;
  await store.issue(expiredState, "owner1", NOW);
  assert.deepEqual(await store.consume(expiredState, new Date(NOW.getTime() + 600_000)), { status: "expired" });
  assert.deepEqual(await store.consume("unknown-state", NOW), { status: "not_found" });
});

test("new OAuth state does not invalidate another live one-time state for the same owner", async () => {
  const repo = new MemoryAuthRepository();
  let id = 0;
  const store = new AuthTokenInstagramOAuthStateStore(repo, () => `state-${++id}`);
  await store.issue("older-state", "owner1", NOW);
  await store.issue("newer-state", "owner1", NOW);
  assert.deepEqual(await store.consume("older-state", NOW), { status: "consumed", userId: "owner1" });
  assert.deepEqual(await store.consume("newer-state", NOW), { status: "consumed", userId: "owner1" });
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
  assert.equal(outcomes.filter((outcome) => outcome.status === "consumed").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "already_consumed").length, 1);
  const expiredState = `${state}-expired`;
  await store.issue(expiredState, "owner1", NOW);
  assert.deepEqual(await store.consume(expiredState, new Date(NOW.getTime() + 600_000)), { status: "expired" });
});
