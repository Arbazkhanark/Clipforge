import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeferredAccessState, resolveEffectiveEntitlement } from "../src/lib/billing/entitlement-resolver.ts";

const now = new Date("2026-11-08T12:00:00.000Z");
const period = (planId: string, startsAt = new Date(now.getTime() - 1), expiresAt = new Date(now.getTime() + 1)) => ({ planId, startsAt, expiresAt });
const paid = (planId: string) => ({ planId, status: "active" as const, trialEndsAt: null, currentPeriodEnd: new Date(now.getTime() + 1), cancelAtPeriodEnd: false, hasCapturedPayment: true, hasFailedPayment: false });
const promo = (planId: string, status = "active", startsAt = new Date(now.getTime() - 1), expiresAt = new Date(now.getTime() + 1), activationPolicy = "immediate") => ({ ...period(planId, startsAt, expiresAt), status, activationPolicy, activatedAt: status === "active" ? startsAt : null, revokedAt: null });

test("effective entitlement resolves Free and every paid catalog tier", () => {
  assert.equal(resolveEffectiveEntitlement({ now }).planId, "free");
  for (const planId of ["creator", "pro", "agency"] as const) {
    assert.equal(resolveEffectiveEntitlement({ now, subscription: paid(planId) }).planId, planId);
    assert.equal(resolveEffectiveEntitlement({ now, manualAccess: [period(planId)] }).planId, planId);
  }
});

test("active promotional tiers grant their tier and never downgrade a higher paid tier", () => {
  for (const planId of ["creator", "pro", "agency"] as const) assert.equal(resolveEffectiveEntitlement({ now, promotionalGrants: [promo(planId)] }).planId, planId);
  assert.equal(resolveEffectiveEntitlement({ now, subscription: paid("creator"), promotionalGrants: [promo("pro")] }).planId, "pro");
  assert.equal(resolveEffectiveEntitlement({ now, subscription: paid("pro"), promotionalGrants: [promo("creator")] }).planId, "pro");
});

test("promotion start/end boundaries are exact and queued/revoked/expired grants confer no access", () => {
  assert.equal(resolveEffectiveEntitlement({ now, promotionalGrants: [promo("agency", "active", now, new Date(now.getTime() + 1))] }).planId, "agency");
  assert.equal(resolveEffectiveEntitlement({ now, promotionalGrants: [promo("agency", "active", new Date(now.getTime() - 1), now)] }).planId, "free");
  for (const status of ["queued", "revoked", "expired"]) assert.equal(resolveEffectiveEntitlement({ now, promotionalGrants: [promo("agency", status)] }).planId, "free");
});

test("highest valid tier wins across multiple active access sources", () => {
  assert.equal(resolveEffectiveEntitlement({ now, subscription: paid("creator"), manualAccess: [period("pro")], promotionalGrants: [promo("agency")] }).planId, "agency");
});

test("unknown plan IDs and invalid access windows fail closed", () => {
  assert.equal(resolveEffectiveEntitlement({ now, promotionalGrants: [promo("executive")] }).planId, "free");
  assert.equal(resolveEffectiveEntitlement({ now, manualAccess: [period("pro", new Date(Number.NaN), new Date(now.getTime() + 1000))] }).planId, "free");
});

test("active deferred grants require a valid activation and authoritative paid-access end", () => {
  const stillPaid = resolveDeferredAccessState({ now, subscription: paid("creator") });
  assert.equal(stillPaid, "active");
  assert.equal(resolveEffectiveEntitlement({ now, subscription: paid("creator"), deferredAccessState: stillPaid, promotionalGrants: [promo("agency", "active", undefined, undefined, "after_current_access")] }).planId, "creator");

  const unresolved = resolveDeferredAccessState({ now, subscription: { ...paid("creator"), status: "halted", currentPeriodEnd: null } });
  assert.equal(unresolved, "unresolved");
  assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("creator"), status: "halted", currentPeriodEnd: null }, deferredAccessState: unresolved, promotionalGrants: [promo("agency", "active", undefined, undefined, "after_current_access")] }).planId, "free");

  const ended = resolveDeferredAccessState({ now, subscription: { ...paid("creator"), status: "cancelled", cancelAtPeriodEnd: false, currentPeriodEnd: null } });
  assert.equal(ended, "ended");
  assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("creator"), status: "cancelled", cancelAtPeriodEnd: false, currentPeriodEnd: null }, deferredAccessState: ended, promotionalGrants: [promo("agency", "active", undefined, undefined, "after_current_access")] }).planId, "agency");

  const malformed = { ...promo("agency", "active", undefined, undefined, "after_current_access"), activatedAt: null };
  assert.equal(resolveEffectiveEntitlement({ now, deferredAccessState: "ended", promotionalGrants: [malformed] }).planId, "free");
  const mismatchedActivation = { ...promo("agency", "active", undefined, undefined, "after_current_access"), activatedAt: new Date(now.getTime() - 2) };
  assert.equal(resolveEffectiveEntitlement({ now, deferredAccessState: "ended", promotionalGrants: [mismatchedActivation] }).planId, "free");
  assert.equal(resolveDeferredAccessState({ now, manualAccess: [period("creator", new Date(now.getTime() + 1), new Date(now.getTime() + 1000))] }), "unresolved");
});

test("recurring entitlements preserve the existing effectivePlanId state rules", () => {
  for (const status of ["active", "pending"] as const) {
    assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("creator"), status, hasCapturedPayment: false, hasFailedPayment: true, currentPeriodEnd: null } }).planId, "creator");
  }
  assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("pro"), status: "authenticated", trialEndsAt: Math.floor(now.getTime() / 1000) - 1, currentPeriodEnd: null, hasCapturedPayment: false } }).planId, "free");
  for (const status of ["cancelled", "completed", "expired"] as const) {
    assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("pro"), status, cancelAtPeriodEnd: false, currentPeriodEnd: null, hasCapturedPayment: false } }).planId, "free");
  }
  for (const status of ["halted", "paused", "created"] as const) {
    assert.equal(resolveEffectiveEntitlement({ now, subscription: { ...paid("pro"), status, cancelAtPeriodEnd: false, currentPeriodEnd: null, hasCapturedPayment: false } }).planId, "free");
  }
});
