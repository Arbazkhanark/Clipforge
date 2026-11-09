import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateInstagramEligibility, isValidInstagramConnectionProfile, missingInstagramScopes, normalizeInstagramScopes } from "../src/lib/integrations/instagram-eligibility.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const scopes = ["instagram_business_basic", "instagram_business_content_publish"];
const input = (over: Record<string, unknown> = {}) => ({ platform: "instagram", status: "connected", accountType: "BUSINESS", grantedScopes: scopes, hasToken: true, tokenExpiresAt: new Date("2026-08-01T00:00:00Z"), now: NOW, ...over });

test("shared account policy permits only explicitly supported professional accounts", () => {
  for (const accountType of ["PERSONAL", "UNKNOWN", null, undefined, "CREATOR", "business", 1]) {
    assert.equal(evaluateInstagramEligibility(input({ accountType })).eligible, false, `type ${String(accountType)} must fail closed`);
  }
  for (const accountType of ["BUSINESS", "MEDIA_CREATOR"]) assert.equal(evaluateInstagramEligibility(input({ accountType })).eligible, true);
});

test("shared account policy fails closed for unknown status, platform, token, expiry, and scope states", () => {
  for (const patch of [
    { platform: "youtube_shorts" }, { status: "UNKNOWN" }, { hasToken: false }, { tokenExpiresAt: null },
    { tokenExpiresAt: new Date("2026-06-01T12:00:00Z") }, { grantedScopes: ["instagram_business_basic"] },
    { grantedScopes: ["instagram_business_basic", "instagram_business_content_publish", "bad!scope"] },
  ]) assert.equal(evaluateInstagramEligibility(input(patch)).eligible, false);
});

test("scope normalization deduplicates known scopes and ignores empty and unexpected values without granting them", () => {
  assert.deepEqual(normalizeInstagramScopes(["", ...scopes, scopes[0], "unexpected_scope"]), { scopes, malformed: false });
  assert.deepEqual(missingInstagramScopes("instagram_business_basic"), ["instagram_business_content_publish"]);
  assert.deepEqual(missingInstagramScopes(["instagram_business_basic", "instagram_business_content_publish", "bad!scope"]), scopes);
  assert.deepEqual(missingInstagramScopes(["instagram_business_basic", "instagram_business_content_publish", "unexpected_scope"]), []);
});

test("callback profile validation rejects incomplete, unsupported, expired, and malformed values", () => {
  const profile = { externalAccountId: "1789001", username: "ada.clips", accountType: "BUSINESS", grantedScopes: scopes, accessToken: "fake-token", tokenExpiresAt: new Date("2026-08-01T00:00:00Z") };
  assert.equal(isValidInstagramConnectionProfile(profile, NOW), true);
  for (const patch of [
    { accountType: "UNKNOWN" }, { accountType: null }, { username: null }, { externalAccountId: "not-numeric" },
    { grantedScopes: ["instagram_business_basic"] }, { tokenExpiresAt: NOW }, { accessToken: "" },
  ]) assert.equal(isValidInstagramConnectionProfile({ ...profile, ...patch }, NOW), false);
});
