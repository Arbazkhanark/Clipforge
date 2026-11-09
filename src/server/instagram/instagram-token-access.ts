import { evaluateInstagramEligibility, normalizeInstagramScopes } from "../../lib/integrations/instagram-eligibility.ts";
import type { Repository } from "../repository.ts";
import { decryptToken, encryptToken } from "./token-cipher.ts";

const GRAPH_ORIGIN = "https://graph.instagram.com";
const REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
export type InstagramTokenAccessResult =
  | { status: "ready"; accessToken: string; expiresAt: Date }
  | { status: "not_eligible" | "invalid_ciphertext" | "expired" | "refresh_failed" | "stale_refresh" };

/** Server-only boundary: token plaintext exists only in this module's return value and must never enter logs/jobs/client responses. */
export async function accessInstagramToken(args: {
  repo: Repository; ownerId: string; accountId: string; encryptionKey: Buffer; now: Date; fetchImpl?: typeof fetch;
}): Promise<InstagramTokenAccessResult> {
  const account = await args.repo.getSocialAccount(args.accountId);
  if (!account || account.userId !== args.ownerId) return { status: "not_eligible" };
  const stored = await args.repo.getInstagramTokenCiphertext(args.ownerId, args.accountId);
  if (!stored || stored.status !== "connected") return { status: "not_eligible" };
  if (!stored.tokenExpiresAt || Number.isNaN(stored.tokenExpiresAt.getTime())) return { status: "not_eligible" };
  if (stored.tokenExpiresAt <= args.now) return { status: "expired" };
  const parsedScopes = normalizeInstagramScopes(account.grantedScopes);
  const eligibility = evaluateInstagramEligibility({ platform: account.platform, status: stored.status, accountType: account.accountType, grantedScopes: parsedScopes.scopes, hasToken: true, tokenExpiresAt: stored.tokenExpiresAt, now: args.now });
  if (!eligibility.eligible) return { status: "not_eligible" };
  let accessToken = decryptToken(args.encryptionKey, stored.encryptedAccessToken);
  if (!accessToken) return { status: "invalid_ciphertext" };
  if (stored.tokenExpiresAt.getTime() - args.now.getTime() > REFRESH_BEFORE_MS) return { status: "ready", accessToken, expiresAt: stored.tokenExpiresAt };
  const url = new URL("/refresh_access_token", GRAPH_ORIGIN);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);
  let response: Response;
  try { response = await (args.fetchImpl ?? fetch)(url, { method: "GET", cache: "no-store" }); }
  catch { return { status: "refresh_failed" }; }
  let data: Record<string, unknown> | null = null;
  try { const value: unknown = await response.json(); if (typeof value === "object" && value !== null && !Array.isArray(value)) data = value as Record<string, unknown>; }
  catch { return { status: "refresh_failed" }; }
  const refreshed = data?.["access_token"];
  const expiresIn = typeof data?.["expires_in"] === "number" ? data["expires_in"] : Number(data?.["expires_in"]);
  if (!response.ok || typeof refreshed !== "string" || refreshed.length === 0 || refreshed.length > 16_384 || !Number.isFinite(expiresIn) || expiresIn <= 0) return { status: "refresh_failed" };
  const expiresAt = new Date(args.now.getTime() + expiresIn * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= args.now) return { status: "refresh_failed" };
  const saved = await args.repo.updateInstagramTokenCiphertext(args.ownerId, args.accountId, stored.encryptedAccessToken, encryptToken(args.encryptionKey, refreshed), expiresAt);
  if (!saved) return { status: "stale_refresh" };
  accessToken = refreshed;
  return { status: "ready", accessToken, expiresAt };
}
