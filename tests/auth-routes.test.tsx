// The REAL authentication service behind the REAL routes and pages, in "local" mode (memory only).
// Proves the flow works in plain Node. It does NOT prove it works in a browser or under Next.js (neither is installed here).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createLocalRuntime, setRuntimeForTests, buildContext, getRuntime, type Runtime } from "../src/server/runtime.ts";
import { forgotPasswordRoute, loginRoute, logoutRoute, registerRoute, resetPasswordRoute, verifyEmailRoute, useSecureCookies } from "../src/server/auth/auth-routes.ts";
import { setPageCookieReaderForTests } from "../src/server/auth/page-cookies.ts";
import { requireCustomerPage } from "../src/server/auth/customer-page.ts";
import { uploadRoute } from "../src/server/upload-route.ts";
import { mediaFileRoute } from "../src/server/media-route.ts";
import { getMediaLibrary } from "../src/server/queries.ts";
import { MemoryMediaStorage } from "../src/server/storage/memory-storage.ts";
import type { MediaServices } from "../src/server/context.ts";
import { parseFlash } from "../src/server/flash.ts";
import DashboardPage from "../app/(app)/dashboard/page.tsx";
import MediaPage from "../app/(app)/media/page.tsx";
import AppLayout from "../app/(app)/layout.tsx";
import RootLayout from "../app/layout.tsx";
import LoginPage from "../app/login/page.tsx";
import RegisterPage from "../app/register/page.tsx";
import VerifyEmailPage from "../app/verify-email/page.tsx";
import ResetPasswordPage from "../app/reset-password/page.tsx";
import ForgotPasswordPage from "../app/forgot-password/page.tsx";
import DevOutboxPage from "../app/dev/outbox/page.tsx";

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const FAST = { logN: 10, r: 8, p: 1 };
const GOOD = "correct horse battery";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 60 }, (_, i) => i)]);
let rt: Runtime; let storage: MemoryMediaStorage; const clock = { now: new Date("2026-06-01T12:00:00Z") };

beforeEach(() => {
  clock.now = new Date("2026-06-01T12:00:00Z"); storage = new MemoryMediaStorage();
  const media: MediaServices = { storage, probe: null, maxUploadBytes: 1e7 };
  rt = createLocalRuntime({ scrypt: FAST, now: () => clock.now, media: async () => media });
  setRuntimeForTests(rt); setPageCookieReaderForTests(async () => null);
});
afterEach(() => { setRuntimeForTests(null); setPageCookieReaderForTests(null); });

const form = (path: string, fields: [string, string][], headers: Record<string, string> = {}, url = "http://localhost:3000") =>
  new Request(`${url}${path}`, { method: "POST", headers: { host: new URL(url).host, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const where = (r: Response) => r.headers.get("location") ?? "";
const post = {
  register: (e: string, p = GOOD, extra: Record<string, string> = {}) => registerRoute(() => rt)(form("/api/auth/register", [["email", e], ["password", p], ["name", "Ann"]], extra)),
  login: (e: string, p = GOOD, url?: string) => loginRoute(() => rt)(form("/api/auth/login", [["email", e], ["password", p]], {}, url)),
  verify: (token: string) => verifyEmailRoute(() => rt)(form("/api/auth/verify-email", [["token", token]])),
  logout: (cookie: string) => logoutRoute(() => rt)(form("/api/auth/logout", [], { cookie })),
  forgot: (e: string) => forgotPasswordRoute(() => rt)(form("/api/auth/forgot-password", [["email", e]])),
  reset: (token: string, p: string) => resetPasswordRoute(() => rt)(form("/api/auth/reset-password", [["token", token], ["password", p]])),
};
const lastToken = () => /token=([A-Za-z0-9_-]+)/.exec(rt.outbox!.messages.at(-1)!.text)![1]!;
const cookieOf = (r: Response) => /^([^=;]+=[^;]*)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
async function signUp(email: string): Promise<string> {
  await post.register(email); await post.verify(lastToken());
  const login = await post.login(email); assert.equal(where(login), "/dashboard", `login failed: ${where(login)}`); return cookieOf(login);
}
const withCookie = (path: string, cookie: string, headers: Record<string, string> = {}) => new Request(`http://localhost:3000${path}`, { headers: { cookie, ...headers } });
const uploadAs = async (cookie: string, filename = "pic.png") => {
  const fd = new FormData(); fd.set("file", new File([PNG], filename, { type: "image/png" }));
  const packed = new Response(fd); const body = new Uint8Array(await packed.arrayBuffer());
  return uploadRoute(() => rt)(new Request("http://localhost:3000/api/forms/media-upload", { method: "POST", headers: { cookie, host: "localhost:3000", accept: "text/html", "content-type": packed.headers.get("content-type")!, "content-length": String(body.length) }, body }));
};

test("DEFAULT MODE: no authentication exists - every auth route says so and sets no cookie", async () => {
  const none: Runtime = { ...rt, auth: undefined, outbox: undefined, mode: "unconfigured" };
  for (const route of [registerRoute, loginRoute, logoutRoute, verifyEmailRoute, forgotPasswordRoute, resetPasswordRoute]) {
    const r = await route(() => none)(form("/x", [["email", "a@example.com"], ["password", GOOD], ["token", "t"]]));
    assert.match(where(r), /error=auth_not_available$/); assert.equal(r.headers.get("set-cookie"), null);
  }
});

test("REGISTER: same answer whether or not the email exists; weak passwords and bad emails are refused; nothing created for bad input", async () => {
  const first = await post.register("Ann@Example.com"); assert.equal(where(first), "/login?notice=registered");
  assert.equal(rt.outbox!.messages.length, 1); assert.match(rt.outbox!.messages[0]!.text, /\/verify-email\?token=/);
  const again = await post.register("ann@example.com", "another good password"); assert.equal(where(again), "/login?notice=registered"); assert.equal(rt.outbox!.messages.length, 1);
  assert.equal(where(await post.register("bob@example.com", "short")), "/register?error=weak_password");
  assert.equal(where(await post.register("not-an-email")), "/register?error=invalid_email");
  assert.equal(rt.outbox!.messages.length, 1);
});

test("FULL FLOW: unverified cannot sign in; the email link only shows a button; confirming then signing in sets a safe cookie", async () => {
  await post.register("ann@example.com");
  const early = await post.login("ann@example.com"); assert.equal(where(early), "/login?error=email_not_verified"); assert.equal(early.headers.get("set-cookie"), null);
  const token = lastToken();
  const verifyPage = html(await VerifyEmailPage({ searchParams: Promise.resolve({ token }) }));                          // opening the link must NOT consume it
  assert.ok(verifyPage.includes('action="/api/auth/verify-email"')); assert.ok(verifyPage.includes(`value="${token}"`)); assert.ok(!verifyPage.includes("disabled"));
  assert.equal(where(await post.login("ann@example.com")), "/login?error=email_not_verified");          // still unverified after "opening the link"
  const noToken = html(await VerifyEmailPage({ searchParams: Promise.resolve({ token: "<script>" }) })); assert.ok(/<button type="submit" disabled/.test(noToken)); assert.ok(!noToken.includes("<script>"));
  assert.equal(where(await post.verify(token)), "/login?notice=verified");
  assert.equal(where(await post.verify(token)), "/login?error=invalid_token");                           // single use
  const login = await post.login("ann@example.com");
  assert.equal(login.status, 303); assert.equal(where(login), "/dashboard"); assert.equal(login.headers.get("cache-control"), "no-store");
  const cookie = login.headers.get("set-cookie")!;
  for (const part of ["clipforge_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"]) assert.ok(cookie.includes(part), part);
  assert.ok(!cookie.includes("Secure"));                                                                  // plain http during local development only
  const secure = (await post.login("ann@example.com", GOOD, "https://app.example.com")).headers.get("set-cookie")!;
  assert.ok(secure.startsWith("__Host-clipforge_session=") && secure.includes("Secure") && secure.includes("HttpOnly") && !secure.includes("Domain"));
  assert.equal(useSecureCookies(new Request("http://x/", { headers: { "x-forwarded-proto": "https" } })), true);
});

test("LOGIN failures: wrong password and unknown email give the identical redirect and no cookie; repeated failures lock the account", async () => {
  await signUp("ann@example.com");
  const wrong = await post.login("ann@example.com", "wrong password here"); const unknown = await post.login("ghost@example.com", "wrong password here");
  assert.equal(where(wrong), "/login?error=invalid_credentials"); assert.equal(where(unknown), where(wrong)); assert.equal(wrong.headers.get("set-cookie"), null);
  for (let i = 0; i < 4; i++) await post.login("ann@example.com", "wrong password here");
  assert.equal(where(await post.login("ann@example.com", GOOD)), "/login?error=rate_limited");              // even the right password is refused while locked
  clock.now = new Date(clock.now.getTime() + 16 * 60_000);
  assert.equal(where(await post.login("ann@example.com", GOOD)), "/dashboard");
});

test("LOGIN IP limit uses only a trusted proxy hop, hides whether the email exists, and expires", async () => {
  process.env["CLIPFORGE_TRUSTED_PROXY_HOPS"] = "1";
  try {
    await signUp("ada@example.com"); await signUp("bea@example.com"); await signUp("cy@example.com");
    const attempt = (email: string, password: string, forwarded: string) => loginRoute(() => rt)(form("/api/auth/login", [["email", email], ["password", password]], { "x-forwarded-for": forwarded }));
    for (let i = 0; i < 5; i++) await attempt("ada@example.com", "wrong password here", "198.51.100.20");
    const spoofed = await attempt("bea@example.com", GOOD, "203.0.113.50");
    assert.equal(where(spoofed), "/dashboard");
    for (let i = 0; i < 5; i++) await attempt("bea@example.com", "wrong password here", "203.0.113.10, 127.0.0.1");
    const known = await attempt("cy@example.com", GOOD, "203.0.113.10, 127.0.0.1");
    const unknown = await attempt("ghost@example.com", "wrong password here", "203.0.113.10, 127.0.0.1");
    assert.equal(where(known), "/login?error=rate_limited");
    assert.equal(where(unknown), where(known));
    assert.equal(known.headers.get("set-cookie"), null);
    assert.equal(unknown.headers.get("set-cookie"), null);
    assert.equal(where(await attempt("cy@example.com", GOOD, "203.0.113.11, 127.0.0.1")), "/dashboard");
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    assert.equal(where(await attempt("cy@example.com", GOOD, "203.0.113.10, 127.0.0.1")), "/dashboard");
    delete process.env["CLIPFORGE_TRUSTED_PROXY_HOPS"];
    for (let i = 0; i < 5; i++) await attempt("cy@example.com", "wrong password here", `198.51.100.${i}`);
    assert.equal(where(await attempt("cy@example.com", GOOD, "198.51.100.99")), "/login?error=rate_limited");
  } finally { delete process.env["CLIPFORGE_TRUSTED_PROXY_HOPS"]; }
});

test("SESSIONS ON REQUESTS: the cookie identifies the user; anonymous, tampered and stranger cookies do not; each user sees only their own files", async () => {
  const ann = await signUp("ann@example.com"); const bob = await signUp("bob@example.com");
  const up = await uploadAs(ann); assert.equal(where(up), "/media?notice=upload_incomplete");              // probe is off in this test, so honestly "incomplete"
  const annCtx = await buildContext(rt, withCookie("/x", ann)); const bobCtx = await buildContext(rt, withCookie("/x", bob));
  assert.notEqual(annCtx.userId, bobCtx.userId); assert.ok(annCtx.userId);
  const annLib = await getMediaLibrary(annCtx, 1); const bobLib = await getMediaLibrary(bobCtx, 1);
  assert.deepEqual([annLib.total, bobLib.total], [1, 0]);
  const id = annLib.items[0]!.id;
  const fetchFile = (cookie: string | null, variant = "preview") => mediaFileRoute(() => rt)(new Request(`http://localhost:3000/api/media/file?id=${id}&variant=${variant}`, { headers: cookie ? { cookie } : {} }));
  assert.equal((await fetchFile(ann)).status, 200); assert.deepEqual(new Uint8Array(await (await fetchFile(ann, "download")).arrayBuffer()), PNG);
  assert.equal((await fetchFile(bob)).status, 404); assert.equal((await fetchFile(bob, "download")).status, 404);   // another user's file
  assert.equal((await fetchFile(null)).status, 401);
  assert.equal((await fetchFile(ann.slice(0, -3) + "AAA")).status, 401);                                    // tampered cookie
  assert.equal((await fetchFile("clipforge_session=" + "A".repeat(43))).status, 401);                       // well-formed but unknown
  assert.equal((await fetchFile("other=1")).status, 401);
  assert.equal((await uploadAs("clipforge_session=" + "A".repeat(43))).status, 303);                        // anonymous upload: redirected with an error
  assert.match(where(await uploadAs("clipforge_session=" + "A".repeat(43))), /error=not_authenticated$/);
  assert.equal(storage.objects.size, 1);
});

test("PAGES read the cookie from the request headers: signed-in users see their data, others are asked to sign in", async () => {
  const ann = await signUp("ann@example.com"); const bob = await signUp("bob@example.com"); await uploadAs(ann, "annpic.png");
  setPageCookieReaderForTests(async () => ann);
  assert.ok(html(await DashboardPage({})).includes("Your plan: <strong>Free</strong>")); assert.ok(html(await MediaPage({})).includes("annpic.png"));
  setPageCookieReaderForTests(async () => bob);
  assert.ok(!html(await MediaPage({})).includes("annpic.png")); assert.ok(html(await MediaPage({})).includes("Your library is empty"));
  for (const reader of [async () => null, async () => "clipforge_session=" + "B".repeat(43), async () => "garbage"]) {
    setPageCookieReaderForTests(reader);
    const outcome = await requireCustomerPage("/dashboard").then(() => ({ kind: "fulfilled" as const }), (error: unknown) => ({ kind: "rejected" as const, error }));
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") assert.ok(outcome.error instanceof Error && outcome.error.message === "NEXT_REDIRECT" && "digest" in outcome.error && String(outcome.error.digest).includes("/login?returnTo=%2Fdashboard"));
  }
  setPageCookieReaderForTests(async () => ann);
  const layout = html(await AppLayout({ children: <p>x</p> }));
  assert.ok(layout.includes("data-local-banner")); assert.ok(layout.includes("disappear when the server restarts")); assert.ok(layout.includes('action="/api/auth/logout"')); assert.ok(layout.includes("Connect Google")); assert.ok(!layout.includes("data-demo-banner"));
  const header = html(await RootLayout({ children: <p>x</p> }));
  assert.ok(header.includes('data-auth-state="signed-in"')); assert.ok(!header.includes('data-auth-state="signed-out"'));
  setPageCookieReaderForTests(async () => null);
  const signedOut = html(await AppLayout({ children: <p>x</p> }));
  assert.ok(signedOut.includes("data-local-banner")); assert.ok(signedOut.includes('href="/login"')); assert.ok(!signedOut.includes('action="/api/auth/logout"')); assert.ok(!signedOut.includes("Connect Google"));
  const signedOutHeader = html(await RootLayout({ children: <p>x</p> }));
  assert.ok(signedOutHeader.includes('data-auth-state="signed-out"')); assert.ok(signedOutHeader.includes(">Sign in</a>")); assert.ok(!signedOutHeader.includes("Signed in"));
});

test("LOGOUT ends the session everywhere that cookie is used and clears it", async () => {
  const ann = await signUp("ann@example.com"); await uploadAs(ann);
  const out = await post.logout(ann);
  assert.equal(where(out), "/login?notice=logged_out"); assert.match(out.headers.get("set-cookie")!, /clipforge_session=; .*Max-Age=0/);
  assert.equal((await mediaFileRoute(() => rt)(withCookie("/api/media/file?id=x&variant=thumbnail", ann))).status, 401);
  assert.equal((await buildContext(rt, withCookie("/x", ann))).userId, null);
  assert.equal(where(await post.logout("")), "/login?notice=logged_out");                                  // logging out when signed out is harmless
});

test("PASSWORD RESET: generic answers, link only shows a form, a typo does not burn the link, success ends ALL sessions", async () => {
  const ann = await signUp("ann@example.com"); const ann2 = (await post.login("ann@example.com")).headers.get("set-cookie")!.split(";")[0]!;
  const before = rt.outbox!.messages.length;
  assert.equal(where(await post.forgot("ghost@example.com")), "/forgot-password?notice=reset_email_sent"); assert.equal(rt.outbox!.messages.length, before);
  assert.equal(where(await post.forgot("ann@example.com")), "/forgot-password?notice=reset_email_sent"); assert.equal(rt.outbox!.messages.length, before + 1);
  const token = lastToken();
  assert.ok(html(await ResetPasswordPage({ searchParams: Promise.resolve({ token }) })).includes('action="/api/auth/reset-password"'));
  const typo = await post.reset(token, "short"); assert.equal(where(typo), `/reset-password?error=weak_password&token=${token}`);
  assert.equal(where(await post.reset("a".repeat(30), "a brand new password")), "/login?error=invalid_token");
  const done = await post.reset(token, "a brand new password");
  assert.equal(where(done), "/login?notice=password_changed"); assert.match(done.headers.get("set-cookie")!, /Max-Age=0/);
  for (const old of [ann, ann2]) assert.equal((await buildContext(rt, withCookie("/x", old))).userId, null);
  assert.equal(where(await post.login("ann@example.com", GOOD)), "/login?error=invalid_credentials");
  assert.equal(where(await post.login("ann@example.com", "a brand new password")), "/dashboard");
  assert.equal(where(await post.reset(token, "yet another password")), "/login?error=invalid_token");     // single use
  assert.ok(html(await ForgotPasswordPage({})).includes('action="/api/auth/forgot-password"'));
});

test("CSRF: cross-site posts to every auth route are refused (403) and change nothing; other content types never succeed", async () => {
  await post.register("ann@example.com"); const token = lastToken();
  type AuthFormRoute = typeof registerRoute;
  const attacks: [AuthFormRoute, string, [string, string][]][] = [
    [registerRoute, "/api/auth/register", [["email", "x@example.com"], ["password", GOOD]]], [loginRoute, "/api/auth/login", [["email", "ann@example.com"], ["password", GOOD]]],
    [logoutRoute, "/api/auth/logout", []], [verifyEmailRoute, "/api/auth/verify-email", [["token", token]]], [forgotPasswordRoute, "/api/auth/forgot-password", [["email", "ann@example.com"]]], [resetPasswordRoute, "/api/auth/reset-password", [["token", token], ["password", GOOD]]],
  ];
  const crossSiteHeaders: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
  const sentBefore = rt.outbox!.messages.length;
  for (const [route, path, fields] of attacks) for (const headers of crossSiteHeaders) {
    const r = await route(() => rt)(form(path, fields, headers)); assert.equal(r.status, 403, `${path} ${JSON.stringify(headers)}`); assert.equal(r.headers.get("set-cookie"), null);
  }
  assert.equal(rt.outbox!.messages.length, sentBefore);                                                    // nothing was triggered
  assert.equal(where(await post.verify(token)), "/login?notice=verified");                                // the token was NOT consumed by the attacks
  const json = await loginRoute(() => rt)(form("/api/auth/login", [], { "content-type": "application/json" })); assert.match(where(json), /error=error$/); assert.equal(json.headers.get("set-cookie"), null);
});

test("REDIRECTS and messages are fixed: user input never appears in a Location header or page text", async () => {
  const evil = '"><script>alert(1)</script>@evil.example';
  for (const r of [await post.register(evil), await post.login(evil, evil), await post.forgot(evil)]) { assert.ok(!decodeURIComponent(where(r)).includes("script")); assert.match(where(r), /^\/[a-z-]+\?(notice|error)=[a-z_]+$/); }
  const page = html(await LoginPage({ searchParams: Promise.resolve({ error: "<script>x</script>", notice: "javascript:alert(1)" }) })); assert.ok(!page.includes("<script>x")); assert.ok(!page.includes('data-flash'));
  assert.equal(parseFlash({ error: "invalid_credentials" })?.message, "Email or password is not correct.");
});

test("LOCAL MODE screens: forms are enabled and labelled; the dev outbox exists only in local mode and never in production", async () => {
  for (const Page of [LoginPage, RegisterPage]) { const out = html(await Page({})); assert.ok(out.includes("Local development accounts")); assert.ok(!/<button type="submit" disabled/.test(out)); assert.ok(out.includes('action="/api/auth/')); }
  assert.ok(html(await RegisterPage({})).includes("minLength"));
  await post.register("ann@example.com");
  assert.throws(() => DevOutboxPage());
  setRuntimeForTests({ ...rt, mode: "demo", outbox: undefined }); assert.throws(() => DevOutboxPage());
});

test("getRuntime(): local mode turns on ONLY with the explicit flag, and never in production", async () => {
  setRuntimeForTests(null);
  const holder = globalThis as { __clipforgeLocalRuntime?: unknown };
  try {
    assert.equal(getRuntime({}).mode, "unconfigured");
    const local = getRuntime({ CLIPFORGE_LOCAL_AUTH: "true", NODE_ENV: "development" });
    assert.equal(local.mode, "local"); assert.ok(local.auth);
    assert.equal(getRuntime({ CLIPFORGE_LOCAL_AUTH: "true", NODE_ENV: "production" }).mode, "unconfigured");
  } finally { delete holder.__clipforgeLocalRuntime; }
});
