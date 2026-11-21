import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../app/api/admin/users/[userId]/suspension/route.ts";
import { PrismaAdminDataRepository } from "../src/server/admin/data-repository.ts";
import { AdminDataService } from "../src/server/admin/data-service.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { hashToken } from "../src/server/auth/tokens.ts";
import { FakePrismaClient } from "./helpers/fake-prisma.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";

const at = new Date("2026-11-21T12:00:00.000Z");

function install(verified = true, role: "admin" | "user" = "admin") {
  const db = new FakePrismaClient();
  db.user.rows.push(
    { id: "admin", email: "admin@example.test", role, emailVerified: verified ? at : null, createdAt: at },
    { id: "target", email: "target@example.test", role: "user", emailVerified: at, createdAt: at, profileData: "preserve" },
  );
  db.session.rows.push({ id: "session-1", userId: "target", revokedAt: null, tokenHash: "not-returned", createdAt: at });
  const adminData = new AdminDataService(new PrismaAdminDataRepository(db), () => at);
  const runtime = {
    mode: "database", repo: {} as Runtime["repo"], currentUserId: async () => "admin",
    currentPrincipal: async () => ({ userId: "admin", role }), auth: { isEmailVerified: async () => verified },
    adminData: async () => adminData, now: () => at, newId: (() => { let id = 0; return () => `audit-${++id}`; })(),
  } as unknown as Runtime;
  setRuntimeForTests(runtime);
  return { db, adminData, reset: () => setRuntimeForTests(null) };
}

function request(method: string, url = "http://localhost/api/admin/users/target/suspension", body?: unknown) {
  return new Request(url, { method, headers: { origin: "http://localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("suspension and reactivation are transactional, audited, idempotent and preserve user data", async () => {
  const fixture = install();
  try {
    const suspend = await POST(request("POST", undefined, { suspended: true, reason: "Abuse review" }));
    assert.equal(suspend.status, 201);
    assert.equal(fixture.db.userSuspension.rows.length, 1);
    assert.equal(fixture.db.session.rows[0]?.["revokedAt"]?.getTime(), at.getTime());
    assert.equal(fixture.db.auditLog.rows.length, 1);
    assert.deepEqual(fixture.db.auditLog.rows[0]?.["metadata"], { previousState: "ACTIVE", newState: "SUSPENDED", reason: "Abuse review" });
    assert.equal((await POST(request("POST", undefined, { suspended: true, reason: "Abuse review" })).then((response) => response.json())).status, "existing");
    assert.equal(fixture.db.auditLog.rows.length, 1);

    const read = await GET(request("GET"));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).data.isSuspended, true);
    const resume = await POST(request("POST", undefined, { suspended: false }));
    assert.equal(resume.status, 200);
    assert.equal((await resume.json()).status, "reactivated");
    assert.equal(fixture.db.userSuspension.rows.length, 0);
    assert.equal(fixture.db.auditLog.rows.length, 2);
    assert.equal(fixture.db.auditLog.rows[1]?.["action"], "admin.user_reactivated");
    assert.equal(fixture.db.user.rows.find((row) => row["id"] === "target")?.["profileData"], "preserve");
  } finally { fixture.reset(); }
});

test("suspension refuses unverified or non-admin actors and cross-origin mutation", async () => {
  const unverified = install(false);
  try {
    assert.equal((await POST(request("POST", undefined, { suspended: true }))).status, 403);
    assert.equal(unverified.db.userSuspension.rows.length, 0);
  } finally { unverified.reset(); }
  const nonAdmin = install(true, "user");
  try { assert.equal((await POST(request("POST", undefined, { suspended: true }))).status, 403); }
  finally { nonAdmin.reset(); }
  const crossOrigin = install();
  try {
    const response = await POST(new Request("http://localhost/api/admin/users/target/suspension", { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ suspended: true }) }));
    assert.equal(response.status, 403);
    assert.equal(crossOrigin.db.userSuspension.rows.length, 0);
  } finally { crossOrigin.reset(); }
});

test("suspended accounts cannot use existing sessions or password login", async () => {
  const repo = new MemoryAuthRepository();
  const password = "Sufficiently-long-Passphrase-92!";
  repo.users.set("user-1", { id: "user-1", email: "user@example.test", emailVerifiedAt: at, passwordHash: await hashPassword(password), name: null, role: "user", createdAt: at });
  const auth = new AuthService({ repo, email: { send: async () => undefined }, limiter: new InMemoryRateLimiter(), now: () => at, newId: () => "sid", config: DEFAULT_AUTH_CONFIG("http://localhost") });
  const sessionToken = "session-token-value-that-is-long-enough";
  await repo.createSession({ id: "session-1", userId: "user-1", tokenHash: hashToken(sessionToken), createdAt: at, lastUsedAt: at, expiresAt: new Date(at.getTime() + 60_000), revokedAt: null });
  repo.suspendedUsers.add("user-1");
  assert.equal(await auth.getSessionUserId(sessionToken), null);
  assert.deepEqual(await auth.login({ email: "user@example.test", password }), { ok: false, code: "account_suspended" });
});

test("suspension endpoints conceal missing users and validate payloads", async () => {
  const fixture = install();
  try {
    assert.equal((await GET(request("GET", "http://localhost/api/admin/users/missing/suspension"))).status, 404);
    assert.equal((await POST(request("POST", undefined, { suspended: "yes" }))).status, 422);
    assert.equal((await POST(request("POST", undefined, { suspended: true, unexpected: "field" }))).status, 422);
    assert.equal(fixture.db.userSuspension.rows.length, 0);
  } finally { fixture.reset(); }
});
