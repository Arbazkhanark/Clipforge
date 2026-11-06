// Form routes for sign-up, sign-in, sign-out, email confirmation and password reset.
// All are POST-only form posts that redirect with short whitelisted codes, never echoing user text.
// Protections: same-origin check (also covers login CSRF), size caps, no-store, HttpOnly + SameSite=Lax cookies (+ Secure on https),
// and identical answers for unknown/wrong accounts (see AuthService). Real email delivery does not exist.
import { AppError } from "../errors.ts";
import { buildFlashLocation, type FlashErrorCode } from "../flash.ts";
import { readUrlEncoded, redirectResponse, type FormFields } from "../form-routes.ts";
import { checkSameOrigin } from "../http.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { buildClearedSessionCookie, buildSessionCookie, readSessionToken } from "./tokens.ts";

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

async function authRoute(request: Request, runtime: RuntimeProvider, work: (auth: NonNullable<Runtime["auth"]>, fields: FormFields, rt: Runtime) => Promise<Response>, failurePath: string): Promise<Response> {
  if (checkSameOrigin(request)) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const rt = runtime();
  if (!rt.auth) return respond(buildFlashLocation(failurePath, "error", "auth_not_available"));
  try { return await work(rt.auth, await readUrlEncoded(request), rt); }
  catch (error) {
    const code: FlashErrorCode = error instanceof AppError && error.code === "database_unavailable" ? "database_unavailable"
      : error instanceof AppError && error.code === "email_not_configured" ? "email_not_configured" : "error";
    return respond(buildFlashLocation(failurePath, "error", code));
  }
}

export const registerRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f, rt) => {
    const result = await auth.register({ email: f.get("email"), password: f.get("password"), name: f.get("name") });
    if (!result.ok) { const code: FlashErrorCode = result.problems.some((p) => /email/i.test(p) && /valid/i.test(p)) ? "invalid_email" : "weak_password"; return respond(buildFlashLocation("/register", "error", code)); }
    const notice = rt.emailDelivery === "unavailable" ? "registered_no_email" : "registered";
    return respond(buildFlashLocation("/login", "notice", notice));   // the same answer whether or not the email already existed
  }, "/register");

export const loginRoute = (runtime: RuntimeProvider = getRuntime) => (request: Request): Promise<Response> =>
  authRoute(request, runtime, async (auth, f, rt) => {
    const result = await auth.login({ email: f.get("email"), password: f.get("password") });
    if (!result.ok) return respond(buildFlashLocation("/login", "error", result.code));
    return respond("/dashboard", { "Set-Cookie": buildSessionCookie(result.sessionToken, result.expiresAt, rt.now(), useSecureCookies(request)) });
  }, "/login");

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
