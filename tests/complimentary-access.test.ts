import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { resolveEffectiveEntitlement } from "../src/lib/billing/entitlement-resolver.ts";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const now = new Date("2026-11-21T10:00:00.000Z");
function setup() {
  const repo = new MemoryRepository();
  repo.setUserRole("admin-a", "admin"); repo.setUserEmailVerified("admin-a");
  repo.setUserRole("admin-b", "admin"); repo.setUserEmailVerified("admin-b");
  repo.setUserRole("user-a", "user");
  return repo;
}
const grantInput = (repo: MemoryRepository, id = "grant-a", adminId = "admin-a") => repo.grantComplimentaryAccess({ id, userId: "user-a", planId: "pro", adminId, note: "reviewed", now });

test("complimentary grant transitions ACTIVE → ON_HOLD → ACTIVE → REVOKED with durable audit and stable grant origin", async () => {
  const repo = setup();
  const created = await grantInput(repo);
  assert.equal(created.status, "created");
  assert.equal(await repo.getPlanIdForUser("user-a", now), "pro");
  const originalCreatedAt = created.grant!.createdAt.getTime();
  const originalAdmin = created.grant!.grantedByAdminId;
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "HOLD", note: "pause", now }), "updated");
  assert.equal(await repo.getPlanIdForUser("user-a", now), "free");
  assert.equal(await repo.getActiveComplimentaryAccessState("user-a"), "ON_HOLD");
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "HOLD", note: "duplicate", now }), "existing");
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "RESUME", note: null, now }), "updated");
  assert.equal(await repo.getPlanIdForUser("user-a", now), "pro");
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "REVOKE", note: "closed", now }), "updated");
  assert.equal(await repo.getPlanIdForUser("user-a", now), "free");
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "RESUME", note: null, now }), "invalid_transition");
  const history = await repo.listComplimentaryAccessForUser("user-a");
  assert.deepEqual(history.events.map((event) => [event.action, event.previousState, event.newState]), [
    ["GRANT", null, "ACTIVE"], ["HOLD", "ACTIVE", "ON_HOLD"], ["RESUME", "ON_HOLD", "ACTIVE"], ["REVOKE", "ACTIVE", "REVOKED"],
  ]);
  assert.equal(history.grants[0]!.createdAt.getTime(), originalCreatedAt);
  assert.equal(history.grants[0]!.grantedByAdminId, originalAdmin);
});

test("only one non-revoked grant can be created under concurrent grants; replay is idempotent", async () => {
  const repo = setup();
  const results = await Promise.all([grantInput(repo, "grant-one"), grantInput(repo, "grant-two", "admin-b")]);
  assert.equal(results.filter((result) => result.status === "created").length, 1);
  assert.equal(results.filter((result) => result.status === "already_granted").length, 1);
  const winner = results.find((result) => result.status === "created")!;
  const replay = await repo.grantComplimentaryAccess({ id: winner.grant!.id, userId: "user-a", planId: "pro", adminId: winner.grant!.grantedByAdminId, note: "reviewed", now });
  assert.equal(replay.status, "existing");
  assert.equal((await repo.listComplimentaryAccessForUser("user-a")).events.length, 1);
});

test("unverified admins cannot grant or transition complimentary access", async () => {
  const repo = setup();
  repo.setUserEmailVerified("admin-a", false);
  assert.equal((await grantInput(repo)).status, "forbidden");
  repo.setUserEmailVerified("admin-a", true);
  await grantInput(repo);
  repo.setUserEmailVerified("admin-b", false);
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-a", userId: "user-a", adminId: "admin-b", action: "HOLD", note: null, now }), "forbidden");
});

test("held complimentary access falls back to legitimate paid access, otherwise Free", () => {
  const paid = { planId: "creator", status: "active" as const, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasCapturedPayment: true, hasFailedPayment: false };
  assert.equal(resolveEffectiveEntitlement({ now, complimentaryGrant: { planId: "agency", status: "ON_HOLD" } }).planId, "free");
  assert.equal(resolveEffectiveEntitlement({ now, subscription: paid, complimentaryGrant: { planId: "agency", status: "ON_HOLD" } }).planId, "creator");
  assert.equal(resolveEffectiveEntitlement({ now, complimentaryGrant: { planId: "agency", status: "REVOKED" } }).planId, "free");
});

test("a new grant can be created after revocation without altering the revoked grant history", async () => {
  const repo = setup();
  await grantInput(repo, "grant-old");
  await repo.transitionComplimentaryAccess({ grantId: "grant-old", userId: "user-a", adminId: "admin-a", action: "REVOKE", note: null, now });
  assert.equal((await grantInput(repo, "grant-new")).status, "created");
  const history = await repo.listComplimentaryAccessForUser("user-a");
  assert.deepEqual(history.grants.map((grant) => grant.status), ["REVOKED", "ACTIVE"]);
  assert.equal(history.events.length, 3);
});

test("Prisma repository performs grant and transition writes transactionally with a lock and versioned append-only events", async () => {
  const db = new FakePrismaClient();
  await db.user.create({ data: { id: "admin", email: "admin@example.invalid", role: "admin", emailVerified: now } });
  await db.user.create({ data: { id: "target", email: "target@example.invalid", role: "user", emailVerified: now } });
  const repo = new PrismaRepository(db, () => now);
  assert.equal((await repo.grantComplimentaryAccess({ id: "grant-prisma", userId: "target", planId: "agency", adminId: "admin", note: null, now })).status, "created");
  assert.equal(await repo.transitionComplimentaryAccess({ grantId: "grant-prisma", userId: "target", adminId: "admin", action: "HOLD", note: "audit", now }), "updated");
  assert.equal(db.lockLog.filter((entry) => entry === "user:target").length, 2);
  const history = await repo.listComplimentaryAccessForUser("target");
  assert.equal(history.grants[0]!.version, 2);
  assert.deepEqual(history.events.map((event) => event.eventKey), ["grant-prisma:1", "grant-prisma:2"]);
  assert.equal(db.complimentaryAccessEvent.rows.length, 2);
});
