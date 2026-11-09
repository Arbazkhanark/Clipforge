import { INSTAGRAM_REQUIRED_SCOPES } from "./instagram-capabilities.ts";

export const SUPPORTED_INSTAGRAM_ACCOUNT_TYPES = ["BUSINESS", "MEDIA_CREATOR"] as const;
export type SupportedInstagramAccountType = (typeof SUPPORTED_INSTAGRAM_ACCOUNT_TYPES)[number];

export type InstagramEligibilityReason =
  | "unsupported_platform"
  | "not_connected"
  | "unsupported_account_type"
  | "missing_token"
  | "invalid_token_expiry"
  | "expired_token"
  | "missing_permissions";

export interface InstagramEligibilityInput {
  platform: unknown;
  status: unknown;
  accountType: unknown;
  grantedScopes: unknown;
  hasToken: unknown;
  tokenExpiresAt: unknown;
  now: Date;
}

export interface InstagramEligibility {
  eligible: boolean;
  reason: InstagramEligibilityReason | null;
  missingScopes: string[];
}

export function isSupportedInstagramAccountType(value: unknown): value is SupportedInstagramAccountType {
  return typeof value === "string" && (SUPPORTED_INSTAGRAM_ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** Parse only scopes known to this login flow. Duplicates and empty separators are harmless; malformed and unknown values never grant a permission. */
export function normalizeInstagramScopes(value: unknown): { scopes: string[]; malformed: boolean } {
  if (value == null) return { scopes: [], malformed: false };
  const entries: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string" && value.length <= 4096
      ? value.split(/[\s,]+/)
      : [];
  const malformed = !Array.isArray(value) && typeof value !== "string"
    || typeof value === "string" && value.length > 4096;
  const scopes = new Set<string>();
  let invalid = malformed;
  for (const entry of entries) {
    if (typeof entry !== "string") { invalid = true; continue; }
    const scope = entry.trim();
    if (!scope) continue;
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(scope)) { invalid = true; continue; }
    if ((INSTAGRAM_REQUIRED_SCOPES as readonly string[]).includes(scope)) scopes.add(scope);
    // Well-formed but unexpected scopes are ignored and cannot satisfy a required permission.
  }
  return { scopes: [...scopes], malformed: invalid };
}

export function missingInstagramScopes(value: unknown): string[] {
  const { scopes, malformed } = normalizeInstagramScopes(value);
  if (malformed) return [...INSTAGRAM_REQUIRED_SCOPES];
  return INSTAGRAM_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
}

/** Shared fail-closed eligibility policy for OAuth persistence, preflight, and durable claims. */
export function evaluateInstagramEligibility(input: InstagramEligibilityInput): InstagramEligibility {
  const missingScopes = missingInstagramScopes(input.grantedScopes);
  let reason: InstagramEligibilityReason | null = null;
  if (input.platform !== "instagram") reason = "unsupported_platform";
  else if (input.status !== "connected") reason = "not_connected";
  else if (!isSupportedInstagramAccountType(input.accountType)) reason = "unsupported_account_type";
  else if (input.hasToken !== true) reason = "missing_token";
  else if (!(input.tokenExpiresAt instanceof Date) || Number.isNaN(input.tokenExpiresAt.getTime())) reason = "invalid_token_expiry";
  else if (input.tokenExpiresAt <= input.now) reason = "expired_token";
  else if (missingScopes.length > 0) reason = "missing_permissions";
  return { eligible: reason === null, reason, missingScopes };
}

export function isValidInstagramConnectionProfile(profile: {
  externalAccountId: unknown;
  username: unknown;
  accountType: unknown;
  grantedScopes: unknown;
  accessToken: unknown;
  tokenExpiresAt: unknown;
}, now: Date): boolean {
  if (typeof profile.externalAccountId !== "string" || !/^[0-9]{1,32}$/.test(profile.externalAccountId)) return false;
  if (typeof profile.username !== "string" || !/^[A-Za-z0-9._]{1,30}$/.test(profile.username)) return false;
  if (!isSupportedInstagramAccountType(profile.accountType)) return false;
  if (typeof profile.accessToken !== "string" || profile.accessToken.length < 1 || profile.accessToken.length > 16_384) return false;
  if (!(profile.tokenExpiresAt instanceof Date) || Number.isNaN(profile.tokenExpiresAt.getTime()) || profile.tokenExpiresAt <= now) return false;
  const normalized = normalizeInstagramScopes(profile.grantedScopes);
  return !normalized.malformed && missingInstagramScopes(normalized.scopes).length === 0;
}
