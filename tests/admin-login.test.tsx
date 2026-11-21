import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { adminLoginRoute } from "../src/server/auth/auth-routes.ts";
import { AuthService, DEFAULT_AUTH_CONFIG } from "../src/server/auth/auth-service.ts";
import { MemoryAuthRepository } from "../src/server/auth/memory-auth-repository.ts";
import { MemoryEmailOutbox } from "../src/server/auth/email.ts";
import { InMemoryRateLimiter } from "../src/server/auth/rate-limiter.ts";
import { hashPassword } from "../src/server/auth/password.ts";
import { readSessionToken } from "../src/server/auth/tokens.ts";
import { readPageCookieHeader, setPageCookieReaderForTests } from "../src/server/auth/page-cookies.ts";
import { setRuntimeForTests, type Runtime } from "../src/server/runtime.ts";
import { MemoryRepository } from "../src/server/memory-repository.ts";
import { AdminLoginForm } from "../src/components/admin/AdminLoginForm.tsx";
import { shouldShowPublicSiteChrome } from "../src/components/PublicSiteChrome.tsx";
import { metadata as adminMetadata } from "../app/admin/layout.tsx";
import AdminLoginPage, { metadata as loginMetadata } from "../app/admin/login/page.tsx";
import ProtectedAdminLayout from "../app/admin/(protected)/layout.tsx";
import AdminOverviewPage from "../app/admin/(protected)/page.tsx";

const NOW = new Date("2026-11-08T12:00:00.000Z");
const FAST_SCRYPT = { logN: 10, r: 8, p: 1 };
const PASSWORD = "correct horse battery";

async function fixture(role: "user" | "admin" = "user") {
  const repository = new MemoryAuthRepository();
  const id = `${role}-user-id`;
  repository.users.set(id, {
    id, email: `${role}@example.test`, emailVerifiedAt: NOW,
    passwordHash: await hashPassword(PASSWORD, FAST_SCRYPT), name: role, role, createdAt: NOW,
  });
  let serial = 0;
  const auth = new AuthService({
    repo: repository, email: new MemoryEmailOutbox(), limiter: new InMemoryRateLimiter(), now: () => NOW,
    newId: () => `session-${++serial}`,
    config: { ...DEFAULT_AUTH_CONFIG("http://localhost:3000"), requireVerifiedEmail: false, scrypt: FAST_SCRYPT },
  });
  const runtime: Runtime = {
    mode: "local", repo: new MemoryRepository(), auth,
    currentUserId: async () => null,
    currentPrincipal: async (request) => auth.getSessionPrincipal(readSessionToken(request ? request.headers.get("cookie") : await readPageCookieHeader())),
    newId: () => `runtime-${++serial}`, now: () => NOW,
  };
  return { auth, repository, runtime };
}

function postLogin(fields: Record<string, string>, origin = "http://localhost:3000", url = "http://localhost:3000/api/admin/login", host = new URL(url).host) {
  return new Request(url, {
    method: "POST",
    headers: { host, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const location = (response: Response) => response.headers.get("location");

afterEach(() => {
  setRuntimeForTests(null);
  setPageCookieReaderForTests(null);
});

test("admin login issues a secure session only after persisted admin role verification and redirects to /admin", async () => {
  const { runtime, auth } = await fixture("admin");
  const response = await adminLoginRoute(() => runtime)(postLogin({ email: "admin@example.test", password: PASSWORD, role: "user", next: "https://attacker.example" }, "https://localhost:3000", "https://localhost:3000/api/admin/login"));
  assert.equal(response.status, 303);
  assert.equal(location(response), "/admin");
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie?.startsWith("__Host-clipforge_session="));
  assert.match(cookie!, /HttpOnly/);
  assert.match(cookie!, /SameSite=Lax/);
  assert.match(cookie!, /Secure/);
  assert.doesNotMatch(cookie!, /Domain=/);
  const token = readSessionToken(cookie);
  assert.equal((await auth.getSessionPrincipal(token))?.role, "admin");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("ordinary-user credentials and invalid credentials have identical generic responses and no session cookie", async () => {
  const { runtime, repository } = await fixture("user");
  const route = adminLoginRoute(() => runtime);
  const ordinaryStart = performance.now();
  const ordinary = await route(postLogin({ email: "user@example.test", password: PASSWORD }));
  const ordinaryDuration = performance.now() - ordinaryStart;
  const invalidStart = performance.now();
  const invalid = await route(postLogin({ email: "missing@example.test", password: PASSWORD }));
  const invalidDuration = performance.now() - invalidStart;
  assert.equal(location(ordinary), "/admin/login?error=admin_login_failed");
  assert.equal(location(invalid), location(ordinary));
  assert.equal(ordinary.headers.get("set-cookie"), null);
  assert.equal(invalid.headers.get("set-cookie"), null);
  assert.ok([...repository.sessions.values()].every((session) => session.revokedAt !== null));
  assert.ok(ordinaryDuration >= 240, `ordinary-user denial completed before the timing floor (${ordinaryDuration.toFixed(1)}ms)`);
  assert.ok(invalidDuration >= 240, `invalid credentials completed before the timing floor (${invalidDuration.toFixed(1)}ms)`);
  assert.equal(ordinary.headers.get("cache-control"), "no-store");
});

test("ordinary-user temporary session is revoked before the generic failure redirect", async () => {
  const { runtime, repository } = await fixture("user");
  const response = await adminLoginRoute(() => runtime)(postLogin({ email: "user@example.test", password: PASSWORD }));
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(repository.sessions.size, 1);
  assert.ok([...repository.sessions.values()][0]?.revokedAt instanceof Date);
});

test("temporary-session revoke failure still returns the generic response and never issues a cookie", async () => {
  const { runtime, repository } = await fixture("user");
  repository.revokeSession = async () => { throw new Error("simulated private storage failure"); };
  const response = await adminLoginRoute(() => runtime)(postLogin({ email: "user@example.test", password: PASSWORD }));
  assert.equal(response.status, 303);
  assert.equal(location(response), "/admin/login?error=admin_login_failed");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), "");
  assert.equal(repository.sessions.size, 1);
  assert.equal([...repository.sessions.values()][0]?.revokedAt, null);
});

test("admin login rejects missing origin, cross-origin requests, wrong methods, and malformed fields safely", async () => {
  const { runtime, repository } = await fixture("admin");
  const route = adminLoginRoute(() => runtime);
  const noOrigin = await route(new Request("http://localhost:3000/api/admin/login", {
    method: "POST", headers: { host: "localhost:3000", "content-type": "application/x-www-form-urlencoded" },
    body: "email=admin%40example.test&password=anything",
  }));
  assert.equal(noOrigin.status, 403);
  const crossOrigin = await route(postLogin({ email: "admin@example.test", password: PASSWORD }, "https://attacker.example"));
  assert.equal(crossOrigin.status, 403);
  const wrongMethod = await route(new Request("http://localhost:3000/api/admin/login", { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
  const duplicateFields = new URLSearchParams({ email: "admin@example.test", password: PASSWORD });
  duplicateFields.append("email", "attacker@example.test");
  const malformed = await route(new Request("http://localhost:3000/api/admin/login", {
    method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: duplicateFields,
  }));
  assert.equal(location(malformed), "/admin/login?error=admin_login_failed");
  assert.equal(malformed.headers.get("set-cookie"), null);
  assert.equal(repository.sessions.size, 0);
});

test("admin login accepts same-origin loopback access and a same-port loopback alias in development", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = environment["NODE_ENV"];
  environment["NODE_ENV"] = "development";
  try {
    const { runtime } = await fixture("admin");
    const route = adminLoginRoute(() => runtime);
    const direct = await route(postLogin({ email: "admin@example.test", password: PASSWORD }, "http://127.0.0.1:3000", "http://127.0.0.1:3000/api/admin/login"));
    assert.equal(direct.status, 303);
    assert.equal(location(direct), "/admin");

    const alias = await route(postLogin(
      { email: "admin@example.test", password: PASSWORD },
      "http://localhost:3000",
      "http://127.0.0.1:3000/api/admin/login",
      "127.0.0.1:3000",
    ));
    assert.equal(alias.status, 303);
    assert.equal(location(alias), "/admin");
  } finally {
    if (previousNodeEnv === undefined) delete environment["NODE_ENV"];
    else environment["NODE_ENV"] = previousNodeEnv;
  }
});

test("admin login keeps loopback alias mismatch rejected in production and rejects external origins in development", async () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousNodeEnv = environment["NODE_ENV"];
  const previousWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const { runtime } = await fixture("admin");
    const route = adminLoginRoute(() => runtime);
    environment["NODE_ENV"] = "production";
    const productionAlias = await route(postLogin(
      { email: "admin@example.test", password: PASSWORD },
      "http://localhost:3000",
      "http://127.0.0.1:3000/api/admin/login",
      "127.0.0.1:3000",
    ));
    assert.equal(productionAlias.status, 403);

    environment["NODE_ENV"] = "development";
    const external = await route(postLogin(
      { email: "admin@example.test", password: PASSWORD },
      "http://attacker.example:3000",
      "http://127.0.0.1:3000/api/admin/login",
      "127.0.0.1:3000",
    ));
    assert.equal(external.status, 403);
    const differentPort = await route(postLogin(
      { email: "admin@example.test", password: PASSWORD },
      "http://localhost:3001",
      "http://127.0.0.1:3000/api/admin/login",
      "127.0.0.1:3000",
    ));
    assert.equal(differentPort.status, 403);
    const differentScheme = await route(postLogin(
      { email: "admin@example.test", password: PASSWORD },
      "https://localhost:3000",
      "http://127.0.0.1:3000/api/admin/login",
      "127.0.0.1:3000",
    ));
    assert.equal(differentScheme.status, 403);
    assert.match(warnings.join("\n"), /"event":"admin_login_origin_rejected"/);
    assert.match(warnings.join("\n"), /"reason":"origin_url_mismatch"/);
    assert.doesNotMatch(warnings.join("\n"), /attacker\.example|admin@example\.test|correct horse battery/);
  } finally {
    console.warn = previousWarn;
    if (previousNodeEnv === undefined) delete environment["NODE_ENV"];
    else environment["NODE_ENV"] = previousNodeEnv;
  }
});

test("admin routes redirect anonymous visitors to the private login and conceal pages from ordinary users", async () => {
  const { runtime, auth } = await fixture("user");
  setRuntimeForTests(runtime);
  setPageCookieReaderForTests(async () => null);
  await assert.rejects(ProtectedAdminLayout({ children: "private" }), (error: unknown) => {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.includes("307");
  });

  const signedIn = await auth.login({ email: "user@example.test", password: PASSWORD });
  assert.ok(signedIn.ok);
  setPageCookieReaderForTests(async () => `clipforge_session=${signedIn.sessionToken}`);
  await assert.rejects(ProtectedAdminLayout({ children: "private" }), (error: unknown) => (error as { digest?: string }).digest?.endsWith(";404"));
  await assert.rejects(AdminOverviewPage(), (error: unknown) => (error as { digest?: string }).digest?.endsWith(";404"));
});

test("admin login page is separate, contains no public login links, and admin metadata disables indexing", async () => {
  const { runtime } = await fixture("user");
  setRuntimeForTests(runtime);
  const page = await AdminLoginPage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(page);
  assert.match(html, /action="\/api\/admin\/login"/);
  assert.doesNotMatch(html, /href="\/(login|register)"/);
  assert.deepEqual(adminMetadata.robots, { index: false, follow: false });
  assert.deepEqual(loginMetadata.robots, { index: false, follow: false });
  assert.match(renderToStaticMarkup(<AdminLoginForm available={true} flash={null} />), /Administrator sign in/);
  assert.match(renderToStaticMarkup(<AdminLoginForm available={true} flash={null} />), /class="admin-login-card"/);
  assert.equal(shouldShowPublicSiteChrome("/admin/login"), false);
  assert.equal(shouldShowPublicSiteChrome("/admin/users"), false);
  assert.equal(shouldShowPublicSiteChrome("/login"), true);
  assert.equal(shouldShowPublicSiteChrome("/"), true);
});
