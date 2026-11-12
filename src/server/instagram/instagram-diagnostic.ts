import { createHmac, timingSafeEqual } from "node:crypto";
import { readSessionToken } from "../auth/tokens.ts";

const COOKIE_BASE_NAME = "clipforge_ig_diagnostic";
const MAX_AGE_SECONDS = 180;
const MAX_COOKIE_LENGTH = 2048;

export type InstagramDiagnosticOutcome =
  | "identity_mismatch_but_remaining_flow_succeeded"
  | "identity_matched_diagnostic_only"
  | "long_lived_token_exchange_failed"
  | "profile_request_failed"
  | "profile_identity_missing"
  | "profile_identity_malformed";
export type InstagramDiagnosticStageStatus = "succeeded" | "failed" | "not_run";
export type InstagramDiagnosticIdentityStatus = "matched" | "mismatched" | "not_verified";
export interface InstagramDiagnosticResult {
  outcome: InstagramDiagnosticOutcome;
  tokenExchange: InstagramDiagnosticStageStatus;
  identityComparison: InstagramDiagnosticIdentityStatus;
  longLivedTokenExchange: InstagramDiagnosticStageStatus;
  profileRequest: InstagramDiagnosticStageStatus;
}

interface StoredDiagnosticResult extends InstagramDiagnosticResult {
  expiresAt: number;
}

function cookieName(secure: boolean): string {
  return `${secure ? "__Host-" : ""}${COOKIE_BASE_NAME}`;
}

function signingKey(tokenKey: Buffer, sessionToken: string): Buffer {
  return Buffer.from(createHmac("sha256", tokenKey).update(`clipforge:instagram:oauth-diagnostic:v1:${sessionToken}`).digest("base64url"), "base64url");
}

function signature(payload: string, tokenKey: Buffer, sessionToken: string): Buffer {
  return Buffer.from(createHmac("sha256", signingKey(tokenKey, sessionToken)).update(payload).digest("base64url"), "base64url");
}

function validResult(value: unknown): value is InstagramDiagnosticResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    "identity_mismatch_but_remaining_flow_succeeded",
    "identity_matched_diagnostic_only",
    "long_lived_token_exchange_failed",
    "profile_request_failed",
    "profile_identity_missing",
    "profile_identity_malformed",
  ].includes(String(record["outcome"]))
    && ["succeeded", "failed", "not_run"].includes(String(record["tokenExchange"]))
    && ["matched", "mismatched", "not_verified"].includes(String(record["identityComparison"]))
    && ["succeeded", "failed", "not_run"].includes(String(record["longLivedTokenExchange"]))
    && ["succeeded", "failed", "not_run"].includes(String(record["profileRequest"]));
}

export function buildInstagramDiagnosticCookie(args: {
  result: InstagramDiagnosticResult;
  sessionToken: string;
  tokenKey: Buffer;
  secure: boolean;
  now: Date;
}): string {
  if (args.tokenKey.length !== 32 || !/^[A-Za-z0-9_-]{20,100}$/.test(args.sessionToken) || !validResult(args.result)) {
    throw new Error("Invalid Instagram diagnostic cookie input.");
  }
  const stored: StoredDiagnosticResult = {
    ...args.result,
    expiresAt: args.now.getTime() + MAX_AGE_SECONDS * 1000,
  };
  const payload = Buffer.from(JSON.stringify(stored)).toString("base64url");
  const value = `v1.${payload}.${signature(payload, args.tokenKey, args.sessionToken).toString("base64url")}`;
  if (value.length > MAX_COOKIE_LENGTH) throw new Error("Instagram diagnostic result is too large.");
  return [
    `${cookieName(args.secure)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
    ...(args.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearInstagramDiagnosticCookie(secure: boolean): string {
  return [
    `${cookieName(secure)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Validates a one-session, signed, short-lived result. It contains statuses only, never provider data. */
export function readInstagramDiagnosticCookie(args: {
  cookieHeader: string | null | undefined;
  sessionToken: string | null;
  tokenKey: Buffer;
  now: Date;
}): InstagramDiagnosticResult | null {
  const header = args.cookieHeader;
  if (!header || header.length > 8192 || !args.sessionToken || args.tokenKey.length !== 32) return null;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name === cookieName(false) || name === cookieName(true)) {
      value = part.slice(index + 1).trim();
      break;
    }
  }
  if (!value || value.length > MAX_COOKIE_LENGTH) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return null;
  const expected = signature(parts[1]!, args.tokenKey, args.sessionToken);
  let supplied: Buffer;
  try { supplied = Buffer.from(parts[2]!, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown; } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stored = parsed as Record<string, unknown>;
  if (!validResult(stored)) return null;
  const expiresAt = stored["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= args.now.getTime() || expiresAt > args.now.getTime() + MAX_AGE_SECONDS * 1000) return null;
  return {
    outcome: stored.outcome,
    tokenExchange: stored.tokenExchange,
    identityComparison: stored.identityComparison,
    longLivedTokenExchange: stored.longLivedTokenExchange,
    profileRequest: stored.profileRequest,
  };
}

export function readInstagramDiagnosticCookieFromRequest(cookieHeader: string | null | undefined, tokenKey: Buffer, now: Date): InstagramDiagnosticResult | null {
  const sessionToken = readSessionToken(cookieHeader);
  return readInstagramDiagnosticCookie({ cookieHeader, sessionToken, tokenKey, now });
}
