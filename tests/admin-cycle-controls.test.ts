import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/admin/campaigns/[cycleId]/status/route.ts";
import { AdminDataService } from "../src/server/admin/data-service.ts";
import { PrismaAdminDataRepository } from "../src/server/admin/data-repository.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";

const at = new Date("2026-11-21T12:00:00.000Z");

function install() {
  const db = new FakePrismaClient();
  db.user.rows.push({ id: "admin", role: "admin", emailVerified: at, email: "admin@example.test", createdAt: at });
  db.publishingCycle.rows.push({ id: "cycle-1", ownerId: "owner-1", status: "running", updatedAt: at });
  db.cycleItem.rows.push({ id: "in-flight", cycleId: "cycle-1", status: "publishing" }, { id: "scheduled", cycleId: "cycle-1", status: "scheduled" });
  const service = new AdminDataService(new PrismaAdminDataRepository(db), () => at);
  setRuntimeForTests({ mode: "database", repo: {} as Runtime["repo"], currentUserId: async () => "admin", currentPrincipal: async () => ({ userId: "admin", role: "admin" }), auth: { isEmailVerified: async () => true }, adminData: async () => service, newId: (() => { let i = 0; return () => `cycle-audit-${++i}`; })(), now: () => at } as unknown as Runtime);
  return { db, reset: () => setRuntimeForTests(null) };
}

function request(body: unknown) {
  return new Request("http://localhost/api/admin/campaigns/cycle-1/status", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("cycle pause and resume use safe lifecycle transitions and durable audit records", async () => {
  const fixture = install();
  try {
    const pause = await POST(request({ action: "pause", reason: "Owner request" }));
    assert.equal(pause.status, 200);
    assert.deepEqual(await pause.json(), { status: "paused", inFlightItemCount: 1 });
    assert.equal(fixture.db.cycleItem.rows.find((row) => row["id"] === "in-flight")?.["status"], "publishing");
    assert.equal(fixture.db.cycleItem.rows.find((row) => row["id"] === "scheduled")?.["status"], "scheduled");
    assert.equal(fixture.db.auditLog.rows.length, 1);
    assert.deepEqual(fixture.db.auditLog.rows[0]?.["metadata"], { previousState: "running", newState: "paused", reason: "Owner request", inFlightItemCount: 1 });

    const resumed = await POST(request({ action: "resume" }));
    assert.equal(resumed.status, 200);
    assert.deepEqual(await resumed.json(), { status: "running", inFlightItemCount: 0 });
    assert.equal(fixture.db.auditLog.rows.length, 2);
    assert.equal(fixture.db.auditLog.rows[1]?.["action"], "admin.cycle_resumed");
  } finally { fixture.reset(); }
});

test("cycle controls are idempotent, reject unsupported transitions and require verified admin authorization", async () => {
  const fixture = install();
  try {
    await POST(request({ action: "pause" }));
    const repeated = await POST(request({ action: "pause" }));
    assert.deepEqual(await repeated.json(), { status: "existing", inFlightItemCount: 0 });
    assert.equal(fixture.db.auditLog.rows.length, 1);
    assert.equal((await POST(request({ action: "stop" }))).status, 422);
  } finally { fixture.reset(); }
  const unverified = install();
  try {
    // The request handler separately checks current persisted email verification.
    const runtime = (await import("../src/server/runtime.ts")).getRuntime();
    (runtime.auth as unknown as { isEmailVerified: () => Promise<boolean> }).isEmailVerified = async () => false;
    assert.equal((await POST(request({ action: "pause" }))).status, 403);
    assert.equal(unverified.db.auditLog.rows.length, 0);
  } finally { unverified.reset(); }
});

test("cycle pause and resume reject deleted cycles without changing state or auditing", async () => {
  const fixture = install();
  try {
    fixture.db.publishingCycle.rows[0]!["deletedAt"] = at;
    assert.equal((await POST(request({ action: "pause" }))).status, 404);
    assert.equal((await POST(request({ action: "resume" }))).status, 404);
    assert.equal(fixture.db.publishingCycle.rows[0]?.["status"], "running");
    assert.equal(fixture.db.auditLog.rows.length, 0);
  } finally { fixture.reset(); }
});
