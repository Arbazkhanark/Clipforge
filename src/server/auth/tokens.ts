import { createHash, randomBytes } from "node:crypto";

/** A random, unguessable token for cookies and emailed links. Only its hash is stored. */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const SESSION_COOKIE_SECURE_NAME = "__Host-clipforge_session"; // "__Host-" cookies must be Secure, Path=/, no Domain
export const SESSION_COOKIE_PLAIN_NAME = "clipforge_session";        // used over plain http during local development only

export function sessionCookieName(secure: boolean): string { return secure ? SESSION_COOKIE_SECURE_NAME : SESSION_COOKIE_PLAIN_NAME; }

export function buildSessionCookie(token: string, expiresAt: Date, now: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return [`${sessionCookieName(secure)}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
}
export function buildClearedSessionCookie(secure: boolean): string {
  return [`${sessionCookieName(secure)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
}

/** Reads the session token from a Cookie header. Looks only for our own cookie names; ignores everything else. */
export function readSessionToken(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if ((name === SESSION_COOKIE_SECURE_NAME || name === SESSION_COOKIE_PLAIN_NAME) && /^[A-Za-z0-9_-]{20,100}$/.test(value)) return value;
  }
  return null;
}
