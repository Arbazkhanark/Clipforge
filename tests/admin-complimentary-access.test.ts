import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST, PATCH } from "../app/api/admin/complimentary-access/route.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import type { AuthService } from "../src/server/auth/auth-service.ts";

function install(verified = true) {
  const repo = new MemoryRepository(); repo.setUserRole("admin", "admin"); repo.setUserRole("target", "user");
  if (verified) repo.setUserEmailVerified("admin");
  const runtime = { mode: "local", repo, currentUserId: async () => "admin", currentPrincipal: async () => ({ userId: "admin", role: "admin" as const }), newId: () => "id", now: () => new Date("2026-11-21T10:00:00.000Z"), auth: { isEmailVerified: async () => verified } as unknown as AuthService } as Runtime;
  setRuntimeForTests(runtime);
  return { repo, reset: () => setRuntimeForTests(null) };
}
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/admin/complimentary-access", { method, headers: { origin: "http://localhost", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("verified admin API grants, holds, resumes, and revokes with explicit state responses", async () => {
  const fixture = install();
  try {
    const created = await POST(request("POST", { userId: "target", planId: "creator", note: "courtesy" }, { "idempotency-key": "test-key-1234567890" }));
    assert.equal(created.status, 201);
    const grant = (await created.json()).grant;
    for (const [action, status] of [["HOLD", 200], ["RESUME", 200], ["REVOKE", 200]] as const) {
      const response = await PATCH(request("PATCH", { userId: "target", grantId: grant.id, action }));
      assert.equal(response.status, status);
    }
    const history = await GET(new Request("http://localhost/api/admin/complimentary-access?userId=target"));
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).events.map((event: { action: string }) => event.action), ["GRANT", "HOLD", "RESUME", "REVOKE"]);
  } finally { fixture.reset(); }
});

test("complimentary admin API rejects unverified admins and cross-origin state changes", async () => {
  const fixture = install(false);
  try {
    const unverified = await POST(request("POST", { userId: "target", planId: "pro" }, { "idempotency-key": "test-key-1234567890" }));
    assert.equal(unverified.status, 403);
    assert.equal((await fixture.repo.listComplimentaryAccessForUser("target")).grants.length, 0);
  } finally { fixture.reset(); }
  const second = install();
  try {
    const crossOrigin = await POST(request("POST", { userId: "target", planId: "pro" }, { origin: "https://attacker.invalid", "idempotency-key": "test-key-1234567890" }));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await second.repo.listComplimentaryAccessForUser("target")).grants.length, 0);
  } finally { second.reset(); }
});
