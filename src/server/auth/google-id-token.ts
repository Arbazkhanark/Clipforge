// Verifies a Google ID token (RS256) with Google's published keys.
// Rejects unsigned tokens and the wrong audience. Does not return the raw token.
import { createPublicKey, createVerify } from "node:crypto";
import type { GoogleProfile } from "./auth-service.ts";

export interface RsaJwk { kty?: string; n?: string; e?: string; kid?: string; alg?: string; use?: string; }

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

function decode(part: string): Buffer | null {
  try { return Buffer.from(part, "base64url"); } catch { return null; }
}

function readJson(part: string): Record<string, unknown> | null {
  const bytes = decode(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Returns the profile, or null when the token is not a valid Google ID token for this client. */
export function verifyGoogleIdToken(idToken: string, options: { clientId: string; now: Date; keys: RsaJwk[] }): GoogleProfile | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0 || part.length > 8192)) return null;
  const header = readJson(parts[0]!);
  const claims = readJson(parts[1]!);
  const signature = decode(parts[2]!);
  if (!header || !claims || !signature || header["alg"] !== "RS256" || typeof header["kid"] !== "string") return null;
  const jwk = options.keys.find((key) => key.kid === header["kid"] && key.kty === "RSA");
  if (!jwk) return null;
  let key;
  try { key = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" }); } catch { return null; }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  if (!verifier.verify(key, signature)) return null;

  const aud = claims["aud"];
  const audienceOk = aud === options.clientId || (Array.isArray(aud) && aud.includes(options.clientId));
  const exp = claims["exp"];
  if (!audienceOk || !ISSUERS.has(String(claims["iss"])) || typeof exp !== "number" || exp * 1000 + 60_000 <= options.now.getTime()) return null;
  if (typeof claims["sub"] !== "string" || typeof claims["email"] !== "string") return null;
  const emailVerified = claims["email_verified"] === true || claims["email_verified"] === "true";
  const name = typeof claims["name"] === "string" ? claims["name"] : null;
  return { sub: claims["sub"], email: claims["email"], emailVerified, name };
}
