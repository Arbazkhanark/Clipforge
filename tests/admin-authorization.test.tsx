import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { adminApiRoute } from "../src/server/admin/api-route.ts";
import { requireAdmin } from "../src/server/admin/authorization.ts";
import { requireAdminPage } from "../src/server/admin/page-authorization.ts";
import { AppError } from "../src/server/errors.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashToken } from "../src/server/auth/tokens.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import ProtectedAdminLayout from "../app/admin/(protected)/layout.tsx";
import AdminOverviewPage from "../app/admin/(protected)/page.tsx";

const now = new Date("2026-11-08T12:00:00.000Z");
const token = "A".repeat(43);

function makeAuth(role: "user" | "admin" = "user") {
  const repo = new MemoryAuthRepository();
  repo.users.set("persisted-user-id", {
    id: "persisted-user-id", email: "person@example.test", emailVerifiedAt: now,
    passwordHash: null, name: "Person", role, createdAt: now,
  });
  repo.sessions.set("session-id", {
    id: "session-id", userId: "persisted-user-id", tokenHash: hashToken(token),
    createdAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + 60_000), revokedAt: null,
  });
  const auth = new AuthService({
    repo, email: new MemoryEmailOutbox(), limiter: new InMemoryRateLimiter(), now: () => now,
    newId: () => "unused", config: DEFAULT_AUTH_CONFIG("http://localhost:3000"),
  });
  return { repo, auth };
}

function runtimeWithPrincipal(currentPrincipal: Runtime["currentPrincipal"]): Runtime {
  return {
    mode: "unconfigured", repo: {} as Runtime["repo"], currentUserId: async () => null,
    currentPrincipal, newId: () => "unused", now: () => now,
  };
}

afterEach(() => {
  setRuntimeForTests(null);
});

test("admin authorization validates the session and reads the current persisted role", async () => {
  const { auth, repo } = makeAuth("admin");
  assert.deepEqual(await auth.getSessionPrincipal(token), { userId: "persisted-user-id", role: "admin" });
  repo.users.get("persisted-user-id")!.role = "user";
  assert.equal((await auth.getSessionPrincipal(token))?.role, "user");
  assert.equal(await auth.getSessionPrincipal("B".repeat(43)), null);
  const runtime = runtimeWithPrincipal((request) => auth.getSessionPrincipal(request?.headers.get("cookie")?.slice("clipforge_session=".length) ?? null));
  const request = new Request("http://localhost:3000/api/admin", { headers: { cookie: `clipforge_session=${token}` } });
  await assert.rejects(requireAdmin(runtime, request), (error: unknown) => error instanceof AppError && error.status === 403);
});

test("normal registration creates an ordinary user", async () => {
  const repo = new MemoryAuthRepository();
  const auth = new AuthService({
    repo, email: new MemoryEmailOutbox(), limiter: new InMemoryRateLimiter(), now: () => now,
    newId: () => "registered-user", config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), requireVerifiedEmail: false, scrypt: { logN: 10, r: 8, p: 1 } },
  });
  const result = await auth.register({ email: "new-user@example.test", password: "correct horse battery" });
  assert.deepEqual(result, { ok: true });
  assert.equal((await repo.getUserById("registered-user"))?.role, "user");
});

test("requireAdmin rejects missing sessions, ordinary users, and runtimes without a principal resolver", async () => {
  await assert.rejects(requireAdmin(runtimeWithPrincipal(async () => null)), (e: unknown) => e instanceof AppError && e.status === 401);
  await assert.rejects(requireAdmin(runtimeWithPrincipal(async () => ({ userId: "ordinary", role: "user" }))), (e: unknown) => e instanceof AppError && e.status === 403);
  await assert.rejects(requireAdmin({ mode: "unconfigured", repo: {} as Runtime["repo"], currentUserId: async () => null, now: () => now, newId: () => "unused" }), (e: unknown) => e instanceof AppError && e.status === 401);
});

test("admin API denies ordinary users before handler and ignores client role or userId", async () => {
  let called = false;
  const route = adminApiRoute(async (_request, adminUserId) => {
    called = true;
    return Response.json({ adminUserId });
  }, () => runtimeWithPrincipal(async () => ({ userId: "real-session-user", role: "user" })));
  const response = await route(new Request("http://localhost:3000/api/admin/example", {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({ role: "admin", userId: "attacker-selected-id" }),
  }));
  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("admin API requires same-origin context on mutations and passes authenticated actor ID", async () => {
  const route = adminApiRoute(async (_request, adminUserId) => Response.json({ adminUserId }), () => runtimeWithPrincipal(async () => ({ userId: "db-admin-id", role: "admin" })));
  const noOrigin = await route(new Request("http://localhost:3000/api/admin/example", { method: "POST" }));
  assert.equal(noOrigin.status, 403);
  const ok = await route(new Request("http://localhost:3000/api/admin/example", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000" } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { adminUserId: "db-admin-id" });
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("admin API rejects cross-origin mutations when scheme, host, or port differs", async () => {
  let called = false;
  const route = adminApiRoute(async () => { called = true; return Response.json({ ok: true }); }, () => runtimeWithPrincipal(async () => ({ userId: "admin-id", role: "admin" })));
  for (const origin of ["https://localhost:3000", "http://localhost:3001", "http://attacker.example:3000"]) {
    const response = await route(new Request("http://localhost:3000/api/admin/example", {
      method: "POST", headers: { host: "localhost:3000", origin, "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(response.status, 403, origin);
  }
  assert.equal(called, false);
});

test("admin API rejects unauthenticated mutation requests before invoking the handler", async () => {
  let called = false;
  const route = adminApiRoute(async () => { called = true; return Response.json({ ok: true }); }, () => runtimeWithPrincipal(async () => null));
  const response = await route(new Request("http://localhost:3000/api/admin/example", {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("admin page redirects anonymous visitors and conceals the page from ordinary users", async () => {
  await assert.rejects(requireAdminPage(runtimeWithPrincipal(async () => null)), (e: unknown) => (e as { digest?: string }).digest?.includes("307"));
  await assert.rejects(requireAdminPage(runtimeWithPrincipal(async () => ({ userId: "ordinary", role: "user" }))), (e: unknown) => (e as { digest?: string }).digest?.endsWith(";404"));

  setRuntimeForTests(runtimeWithPrincipal(async () => ({ userId: "ordinary", role: "user" })));
  await assert.rejects(ProtectedAdminLayout({ children: "protected" }), (e: unknown) => (e as { digest?: string }).digest?.endsWith(";404"));
});

test("admin page and shell render only for an admin principal", async () => {
  setRuntimeForTests(runtimeWithPrincipal(async () => ({ userId: "admin-id", role: "admin" })));
  const shell = await ProtectedAdminLayout({ children: await AdminOverviewPage() });
  const html = renderToStaticMarkup(shell);
  assert.match(html, /ClipForge/);
  assert.match(html, /Live data is not connected/);
  assert.match(html, /Overview/);
  assert.doesNotMatch(html, /financial|payments|expenses/i);
});
