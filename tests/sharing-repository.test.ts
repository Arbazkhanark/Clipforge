import { test } from "node:test";
import assert from "node:assert/strict";
import { PrismaRepository } from "../src/server/prisma/prisma-repository.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { NOW, inDays } from "./helpers.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import type { Capability } from "../src/lib/domain/types.ts";

async function setupPrismaSharing() {
  const db = new FakePrismaClient();
  for (const id of ["owner", "admin", "recipient", "recipient-2", "manager"]) {
    await db.user.create({ data: { id, email: `${id}@example.test`, role: "user" } });
  }
  await db.subscription.create({ data: { id: "sub-owner", userId: "owner", planId: "creator", interval: "monthly", status: "active", trialEndsAt: null, currentPeriodEnd: inDays(20), cancelAtPeriodEnd: false, razorpaySubscriptionId: null, lastEventAt: 0 } });
  await db.videoCollection.create({ data: { id: "col", ownerId: "owner", name: "Collection", description: null, visibility: "private", archived: false } });
  return { db, repo: new PrismaRepository(db, () => NOW) };
}

test("fake-Prisma concurrent sharing grants enforce the owner cap; identical retries do not add audits", async () => {
  const { db, repo } = await setupPrismaSharing();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => repo.createOrUpdateCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: `recipient-${index}`, capabilities: ["view"], expiresAt: null, now: NOW })));
  assert.equal(results.filter((result) => result.status === "applied").length, 5);
  assert.equal(results.filter((result) => result.status === "plan_limit").length, 3);
  assert.equal(await db.collectionPermission.count({ where: { collectionId: "col", status: "active" } }), 5);
  assert.equal(await db.auditLog.count({ where: { action: "sharing.grant_created" } }), 5);
  db.lockLog.length = 0;
  const first = (await db.collectionPermission.findFirst({ where: { collectionId: "col" } }))!;
  const retry = await repo.createOrUpdateCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: String(first["granteeId"]), capabilities: first["capabilities"], expiresAt: null, now: NOW });
  assert.equal(retry.status, "existing");
  assert.equal(await db.auditLog.count({ where: { action: "sharing.grant_created" } }), 5);
  assert.deepEqual(db.lockLog.slice(-2), ["user:owner", "collection:col"]);
});

test("fake-Prisma grant audit failure rolls back; revoke audit failure preserves the active grant", async () => {
  const { db, repo } = await setupPrismaSharing();
  const originalAuditCreate = db.auditLog.create.bind(db.auditLog);
  db.auditLog.create = async (args) => { if (args.data["action"] === "sharing.grant_created") throw new Error("injected audit failure"); return originalAuditCreate(args); };
  await assert.rejects(() => repo.createOrUpdateCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", capabilities: ["view"], expiresAt: null, now: NOW }));
  assert.equal(await db.collectionPermission.count({ where: { collectionId: "col" } }), 0);
  assert.equal(await db.auditLog.count(), 0);
  db.auditLog.create = originalAuditCreate;
  await repo.createOrUpdateCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", capabilities: ["view"], expiresAt: null, now: NOW });
  db.auditLog.create = async (args) => { if (args.data["action"] === "sharing.grant_revoked") throw new Error("injected audit failure"); return originalAuditCreate(args); };
  await assert.rejects(() => repo.revokeCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", now: NOW }));
  assert.equal((await db.collectionPermission.findFirst({ where: { collectionId: "col", granteeId: "recipient" } }))?.["status"], "active");
  assert.equal(await db.auditLog.count(), 1);
});

test("fake-Prisma revocation is owner-authorized, atomic, and repeated requests do not add audit rows", async () => {
  const { db, repo } = await setupPrismaSharing();
  await db.collectionPermission.create({ data: { collectionId: "col", granteeId: "manager", capabilities: ["view"], status: "active", expiresAt: null, grantedById: "owner", revokedAt: null } });
  assert.equal((await repo.createOrUpdateCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", capabilities: ["view"], expiresAt: null, now: NOW })).status, "applied");
  assert.equal((await repo.revokeCollectionGrant({ collectionId: "col", actorId: "manager", granteeId: "recipient", now: NOW })).status, "forbidden");
  assert.equal((await repo.revokeCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", now: NOW })).status, "applied");
  assert.equal((await repo.revokeCollectionGrant({ collectionId: "col", actorId: "owner", granteeId: "recipient", now: NOW })).status, "not_found");
  assert.equal((await db.collectionPermission.findFirst({ where: { collectionId: "col", granteeId: "recipient" } }))?.["status"], "revoked");
  assert.equal(await db.auditLog.count({ where: { action: "sharing.grant_revoked" } }), 1);
});

test("fake-Prisma access requests are owner/requester scoped, idempotent, and approval atomically grants owner-plan-approved permissions", async () => {
  const { db, repo } = await setupPrismaSharing();
  const input = { id: "req-1", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view", "use_in_cycle"] as Capability[], now: NOW };
  assert.equal((await repo.createCollectionAccessRequest(input)).status, "created");
  assert.equal((await repo.createCollectionAccessRequest({ ...input, id: "retry-id" })).status, "existing");
  assert.equal(await db.collectionAccessRequest.count({ where: { collectionId: "col", requesterId: "recipient", status: "pending" } }), 1);
  assert.equal(await db.auditLog.count({ where: { action: "sharing.access_request_created" } }), 1);
  assert.equal((await repo.listPendingCollectionAccessRequests("col", "owner")).length, 1);
  assert.equal((await repo.listPendingCollectionAccessRequests("col", "recipient")).length, 0);
  assert.equal((await repo.listCollectionAccessRequestsForRequester("recipient")).length, 1);

  const decision = await repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req-1", ownerId: "owner", decision: "approved", now: NOW });
  assert.equal(decision.status, "applied");
  const approvedGrant = await db.collectionPermission.findUnique({ where: { collectionId_granteeId: { collectionId: "col", granteeId: "recipient" } } });
  assert.deepEqual(approvedGrant?.["capabilities"], ["view", "use_in_cycle"]);
  assert.equal(await db.auditLog.count({ where: { action: "sharing.access_request_approved" } }), 1);
  assert.equal((await repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req-1", ownerId: "owner", decision: "rejected", now: NOW })).status, "already_decided");
  assert.deepEqual(db.lockLog.slice(-3), ["user:owner", "user:recipient", "collection:col"]);
});

test("memory access-request rejection grants nothing; a later approval grants only active requested permission and requester sees decisions", async () => {
  const repo = new MemoryRepository();
  repo.collections.set("col", { id: "col", ownerId: "owner", name: "Private", visibility: "private", archived: false, mediaIds: [] });
  repo.plans.set("owner", "creator");
  const input = { id: "req-1", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view", "import_copy"] as Capability[], now: NOW };
  assert.equal((await repo.createCollectionAccessRequest(input)).status, "created");
  assert.equal((await repo.createCollectionAccessRequest({ ...input, id: "different-id" })).status, "existing");
  assert.equal((await repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req-1", ownerId: "owner", decision: "rejected", now: NOW })).status, "applied");
  assert.equal(repo.grants.length, 0);
  assert.equal((await repo.listCollectionAccessRequestsForRequester("recipient"))[0]?.status, "rejected");

  assert.equal((await repo.createCollectionAccessRequest({ ...input, id: "req-2" })).status, "created");
  assert.equal((await repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req-2", ownerId: "owner", decision: "approved", now: NOW })).status, "applied");
  assert.deepEqual(repo.grants[0]?.capabilities, ["view", "import_copy"]);
  assert.equal((await repo.listPendingCollectionAccessRequests("col", "owner")).length, 0);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["sharing.access_request_created", "sharing.access_request_rejected", "sharing.access_request_created", "sharing.access_request_approved"]);
});

test("memory concurrent duplicate access requests are serialized and audited once", async () => {
  const repo = new MemoryRepository();
  repo.collections.set("col", { id: "col", ownerId: "owner", name: "Private", visibility: "private", archived: false, mediaIds: [] });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.createCollectionAccessRequest({ id: `req-${i}`, collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW })));
  assert.equal(results.filter((result) => result.status === "created").length, 1);
  assert.equal(results.filter((result) => result.status === "existing").length, 7);
  assert.equal(repo.collectionAccessRequests.size, 1);
  assert.equal(repo.audit.filter((entry) => entry.action === "sharing.access_request_created").length, 1);
});

test("fake-Prisma concurrent duplicate requests and decisions remain idempotent", async () => {
  const { db, repo } = await setupPrismaSharing();
  const requested = await Promise.all(Array.from({ length: 6 }, (_, i) => repo.createCollectionAccessRequest({ id: `parallel-${i}`, collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW })));
  assert.equal(requested.filter((result) => result.status === "created").length, 1);
  assert.equal(requested.filter((result) => result.status === "existing").length, 5);
  const decisions = await Promise.all([
    repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "parallel-0", ownerId: "owner", decision: "approved", now: NOW }),
    repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "parallel-0", ownerId: "owner", decision: "rejected", now: NOW }),
  ]);
  assert.equal(decisions.filter((result) => result.status === "applied").length, 1);
  assert.equal(decisions.filter((result) => result.status === "already_decided").length, 1);
  assert.equal(await db.auditLog.count({ where: { action: { contains: "sharing.access_request_" } } }), 2);
  assert.equal(await db.collectionPermission.count({ where: { collectionId: "col", granteeId: "recipient" } }), decisions.some((result) => result.status === "applied" && result.grant) ? 1 : 0);
});

test("memory approval serializes against the final owner-plan recipient slot", async () => {
  const repo = new MemoryRepository();
  repo.collections.set("col", { id: "col", ownerId: "owner", name: "Private", visibility: "private", archived: false, mediaIds: [] });
  repo.plans.set("owner", "creator");
  for (let i = 0; i < 4; i++) repo.grants.push({ collectionId: "col", granteeId: `existing-${i}`, capabilities: ["view"], status: "active", expiresAt: null, grantedById: "owner" });
  for (const [id, requesterId] of [["r-a", "a-recipient"], ["r-b", "b-recipient"]] as const) {
    await repo.createCollectionAccessRequest({ id, collectionId: "col", requesterId, requestedCapabilities: ["view"], now: NOW });
  }
  const decisions = await Promise.all([
    repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "r-a", ownerId: "owner", decision: "approved", now: NOW }),
    repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "r-b", ownerId: "owner", decision: "approved", now: NOW }),
  ]);
  assert.equal(decisions.filter((result) => result.status === "applied").length, 1);
  assert.equal(decisions.filter((result) => result.status === "plan_limit").length, 1);
  assert.equal(repo.grants.filter((grant) => grant.collectionId === "col" && grant.status === "active").length, 5);
  assert.equal(repo.collectionAccessRequests.get("r-a")?.status === "approved" || repo.collectionAccessRequests.get("r-b")?.status === "approved", true);
});

test("owner plan recipient limit is rechecked atomically when approving a pending request", async () => {
  const { db, repo } = await setupPrismaSharing();
  for (let i = 0; i < 5; i++) await db.collectionPermission.create({ data: { collectionId: "col", granteeId: `existing-${i}`, capabilities: ["view"], status: "active", expiresAt: null, grantedById: "owner", revokedAt: null } });
  await repo.createCollectionAccessRequest({ id: "request-at-cap", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW });
  const result = await repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "request-at-cap", ownerId: "owner", decision: "approved", now: NOW });
  assert.equal(result.status, "plan_limit");
  assert.equal((await db.collectionAccessRequest.findUnique({ where: { id: "request-at-cap" } }))?.["status"], "pending");
  assert.equal(await db.collectionPermission.count({ where: { collectionId: "col", granteeId: "recipient" } }), 0);
  assert.equal(await db.auditLog.count({ where: { action: "sharing.access_request_approved" } }), 0);
});

test("memory audit failures roll back access-request creation and approval completely", async () => {
  const repo = new MemoryRepository();
  repo.collections.set("col", { id: "col", ownerId: "owner", name: "Private", visibility: "private", archived: false, mediaIds: [] });
  repo.plans.set("owner", "creator");
  repo.beforeSharingAuditInsert = () => false;
  await assert.rejects(() => repo.createCollectionAccessRequest({ id: "req", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW }));
  assert.equal(repo.collectionAccessRequests.size, 0);
  assert.equal(repo.grants.length, 0);
  assert.equal(repo.audit.length, 0);

  repo.beforeSharingAuditInsert = null;
  await repo.createCollectionAccessRequest({ id: "req", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW });
  repo.beforeSharingAuditInsert = () => false;
  await assert.rejects(() => repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req", ownerId: "owner", decision: "approved", now: NOW }));
  assert.equal(repo.collectionAccessRequests.get("req")?.status, "pending");
  assert.equal(repo.grants.length, 0);
  assert.deepEqual(repo.audit.map((entry) => entry.action), ["sharing.access_request_created"]);
});

test("fake-Prisma access-request audit failures roll back creation and approval grant/status changes", async () => {
  const { db, repo } = await setupPrismaSharing();
  const originalAuditCreate = db.auditLog.create.bind(db.auditLog);
  db.auditLog.create = async (args) => { if (String(args.data["action"]).startsWith("sharing.access_request")) throw new Error("injected access-request audit failure"); return originalAuditCreate(args); };
  await assert.rejects(() => repo.createCollectionAccessRequest({ id: "req", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW }));
  assert.equal(await db.collectionAccessRequest.count(), 0);
  assert.equal(await db.auditLog.count(), 0);

  db.auditLog.create = originalAuditCreate;
  await repo.createCollectionAccessRequest({ id: "req", collectionId: "col", requesterId: "recipient", requestedCapabilities: ["view"], now: NOW });
  db.auditLog.create = async (args) => { if (args.data["action"] === "sharing.access_request_approved") throw new Error("injected approval audit failure"); return originalAuditCreate(args); };
  await assert.rejects(() => repo.decideCollectionAccessRequest({ collectionId: "col", requestId: "req", ownerId: "owner", decision: "approved", now: NOW }));
  assert.equal((await db.collectionAccessRequest.findUnique({ where: { id: "req" } }))?.["status"], "pending");
  assert.equal(await db.collectionPermission.count(), 0);
  assert.equal(await db.auditLog.count(), 1);
});
