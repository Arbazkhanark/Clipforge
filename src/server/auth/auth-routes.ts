// Form routes for sign-up, sign-in, sign-out, email confirmation and password reset.
// All are POST-only form posts that redirect with short whitelisted codes, never echoing user text.
// Protections: same-origin check (also covers login CSRF), size caps, no-store, HttpOnly + SameSite=Lax cookies (+ Secure on https),
// and identical answers for unknown/wrong accounts (see AuthService). Real email delivery does not exist.
import { performance } from "node:perf_hooks";
import { AppError } from "../errors.ts";
import { buildFlashLocation, type FlashErrorCode } from "../flash.ts";
import { readUrlEncoded, redirectResponse, type FormFields } from "../form-routes.ts";
import { checkSameOrigin } from "../http.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { clientIpForRateLimit } from "./client-ip.ts";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from "./tokens.ts";
import { safeCustomerReturnPath } from "./return-path.ts";

type RuntimeProvider = () => Runtime;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

/** Secure cookies on https (and always in production). Plain http is allowed only for local development. */
export function useSecureCookies(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || process.env["NODE_ENV"] === "production";
}

function respond(location: string, extraHeaders: Record<string, string> = {}): Response {
  const response = redirectResponse(location);
  for (const [name, value] of Object.entries(extraHeaders)) response.headers.append(name, value);
  return response;
}
const withToken = (location: string, token: string | null): string => (token && TOKEN_PATTERN.test(token) ? `${location}&token=${token}` : location);
const withCustomerReturnPath = (location: string, returnTo: string): string => returnTo === "/dashboard" ? location : `${location}&returnTo=${encodeURIComponent(returnTo)}`;

async function authRoute(request: Request, runtime: RuntimeProvider, work: (auth: NonNullable<Runtime["auth"]>, fields: FormFields, rt: Runtime) => Promise<Response>, failurePath: string): Promise<Response> {
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const rt = runtime();
  if (!rt.auth) {
    const code: FlashErrorCode = rt.mode === "unconfigured" && process.env["NODE_ENV"] === "production" ? "database_unavailable" : "auth_not_available";
    return respond(buildFlashLocation(failurePath, "error", code));
  }
  try { return await work(rt.auth, await readUrlEncoded(request), rt); }
  catch (error) {
    const code: FlashErrorCode = error instanceof AppError && error.code === "database_unavailable" ? "database_unavailable"
      : error instanceof AppError && error.code === "email_not_configured" ? "email_not_configured" : "error";
    return respond(buildFlashLocation(failurePath, "error", code));
  }
}

export const registerRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f, rt) => {
    const returnTo = safeCustomerReturnPath(f.get("returnTo"));
    const result = await auth.register({ email: f.get("email"), password: f.get("password"), name: f.get("name") });
    if (!result.ok) { const code: FlashErrorCode = result.problems.some((p) => /email/i.test(p) && /valid/i.test(p)) ? "invalid_email" : "weak_password"; return respond(withCustomerReturnPath(buildFlashLocation("/register", "error", code), returnTo)); }
    const notice = rt.emailDelivery === "unavailable" ? "registered_no_email" : "registered";
    return respond(withCustomerReturnPath(buildFlashLocation("/login", "notice", notice), returnTo));   // the same answer whether or not the email already existed
  }, "/register");

export const loginRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f, rt) => {
    const returnTo = safeCustomerReturnPath(f.get("returnTo"));
    const result = await auth.login({ email: f.get("email"), password: f.get("password"), ip: clientIpForRateLimit(request) });
    if (!result.ok) return respond(withCustomerReturnPath(buildFlashLocation("/login", "error", result.code), returnTo));
    return respond(returnTo, { "Set-Cookie": buildSessionCookie(result.sessionToken, result.expiresAt, rt.now(), useSecureCookies(request)) });
  }, "/login");

/** Private admin login. The normal login route remains unchanged; a session cookie is issued only after a fresh role lookup. */
export const adminLoginRoute = (runtime: RuntimeProvider = getRuntime) => async (request: Request): Promise<Response> => {
  const startedAt = performance.now();
  const failure = async (): Promise<Response> => {
    // Equalize expected invalid-credential and non-admin rejection work under normal service latency.
    // This is a minimum floor, not a constant-time guarantee for unusually slow infrastructure.
    const remainingMs = 250 - (performance.now() - startedAt);
    if (remainingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
    return respond(buildFlashLocation("/admin/login", "error", "admin_login_failed"));
  };
  if (request.method.toUpperCase() !== "POST") return new Response(null, { status: 405, headers: { "Cache-Control": "no-store", Allow: "POST" } });
  const origin = request.headers.get("origin");
  let exactOrigin = false;
  if (origin) {
    try { exactOrigin = new URL(origin).origin === new URL(request.url).origin; } catch { exactOrigin = false; }
  }
  if (!exactOrigin || checkSameOrigin(request)) {
    return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const rt = runtime();
  if (!rt.auth) return failure();
  let temporarySessionToken: string | null = null;
  try {
    const fields = await readUrlEncoded(request);
    const emails = fields.getAll("email");
    const passwords = fields.getAll("password");
    if (emails.length !== 1 || passwords.length !== 1 || !emails[0]?.trim() || emails[0].length > 320 || !passwords[0] || passwords[0].length > 1024) return failure();

    const result = await rt.auth.login({ email: emails[0], password: passwords[0], ip: clientIpForRateLimit(request) });
    if (!result.ok) return failure();
    temporarySessionToken = result.sessionToken;

    const principal = await rt.auth.getSessionPrincipal(temporarySessionToken);
    if (!principal || principal.userId !== result.userId || principal.role !== "admin") {
      await rt.auth.logout(temporarySessionToken);
      temporarySessionToken = null;
      return failure();
    }

    const cookie = buildSessionCookie(temporarySessionToken, result.expiresAt, rt.now(), useSecureCookies(request));
    temporarySessionToken = null;
    return respond("/admin", { "Set-Cookie": cookie });
  } catch {
    // If role lookup or another step fails after authentication created a session, revoke it without logging its token.
    if (temporarySessionToken) {
      try { await rt.auth.logout(temporarySessionToken); } catch { /* Never issue the cookie; infrastructure can be retried safely. */ }
    }
    return failure();
  }
};

export const logoutRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth) => {
    await auth.logout(readSessionToken(request.headers.get("cookie")));
    return respond(buildFlashLocation("/login", "notice", "logged_out"), { "Set-Cookie": buildClearedSessionCookie(useSecureCookies(request)) });
  }, "/login");

export const verifyEmailRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f) => {
    const result = await auth.verifyEmail(f.get("token"));
    return respond(result.ok ? buildFlashLocation("/login", "notice", "verified") : buildFlashLocation("/login", "error", "invalid_token"));
  }, "/login");

export const forgotPasswordRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f, rt) => { await auth.requestPasswordReset(f.get("email")); return respond(buildFlashLocation("/forgot-password", "notice", rt.emailDelivery === "unavailable" ? "reset_unavailable" : "reset_email_sent")); }, "/forgot-password");

export const resetPasswordRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f) => {
    const token = f.get("token");
    const result = await auth.resetPassword(token, f.get("password"));
    if (result.ok) return respond(buildFlashLocation("/login", "notice", "password_changed"), { "Set-Cookie": buildClearedSessionCookie(useSecureCookies(request)) });
    const invalidLink = result.problems.some((p) => /not valid or has expired/.test(p));
    return respond(invalidLink ? buildFlashLocation("/login", "error", "invalid_token") : withToken(buildFlashLocation("/reset-password", "error", "weak_password"), token));
  }, "/reset-password");
