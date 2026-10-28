import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getSharingActorRole, canChangeVisibility, planGrantCreation, planGrantRevocation, countActiveRecipients,
  findGrantsOutsidePolicy, DELEGATE_MAX_GRANT_DAYS, type SharingPolicy,
} from "../src/lib/domain/sharing-management.ts";
import { PLAN_CATALOG } from "../src/lib/billing/catalog.ts";
import { NOW, inDays, makeCollection, makeGrant } from "./helpers.ts";

const PRO: SharingPolicy = PLAN_CATALOG.pro.sharing;
const CREATOR: SharingPolicy = PLAN_CATALOG.creator.sharing;
const col = makeCollection();
const create = (over: Partial<Parameters<typeof planGrantCreation>[0]> = {}) =>
  planGrantCreation({ actorId: "owner", granteeId: "carol", collection: col, existingGrants: [], capabilities: ["view", "use_in_cycle"], expiresAt: null, policy: PRO, now: NOW, ...over });
const managerGrant = (over = {}) => makeGrant({ granteeId: "mgr", capabilities: ["view", "use_in_cycle", "manage"], expiresAt: null, ...over });

test("roles: owner, delegate (only if plan includes delegation), none", () => {
  assert.equal(getSharingActorRole("owner", col, [], CREATOR, NOW), "owner");
  assert.equal(getSharingActorRole("mgr", col, [managerGrant()], PRO, NOW), "delegate");
  assert.equal(getSharingActorRole("mgr", col, [managerGrant()], CREATOR, NOW), "none"); // plan downgraded
  assert.equal(getSharingActorRole("mgr", col, [managerGrant({ status: "revoked" })], PRO, NOW), "none");
  assert.equal(getSharingActorRole("eve", col, [], PRO, NOW), "none");
});

test("owner can grant; result records who granted", () => {
  const r = create();
  assert.ok(r.ok && r.grant.grantedById === "owner" && r.grant.granteeId === "carol");
});

test("strangers and plain recipients cannot grant", () => {
  assert.equal(create({ actorId: "eve" }).ok, false);
  assert.equal(create({ actorId: "bob", existingGrants: [makeGrant()] }).ok, false);
});

test("cannot grant to the owner, to yourself, nothing, or unknown permissions", () => {
  assert.equal(create({ granteeId: "owner" }).ok, false);
  assert.equal(create({ capabilities: [] }).ok, false);
  assert.equal(create({ capabilities: ["fly" as never] }).ok, false);
});

test("expiring grants: need the plan feature, must be in the future", () => {
  assert.equal(create({ expiresAt: inDays(5) }).ok, true);
  assert.equal(create({ expiresAt: inDays(-1) }).ok, false);
  const creator = create({ policy: CREATOR, expiresAt: inDays(5) });
  assert.ok(!creator.ok && /not included/.test(creator.reason));
  assert.equal(create({ policy: CREATOR, expiresAt: null }).ok, true); // permanent grants still fine on Creator
});

test("manage can only be given by the owner and only when the plan includes delegation", () => {
  assert.equal(create({ capabilities: ["view", "manage"] }).ok, true);
  assert.equal(create({ capabilities: ["view", "manage"], policy: CREATOR }).ok, false);
  const viaDelegate = create({ actorId: "mgr", existingGrants: [managerGrant()], capabilities: ["view", "manage"], expiresAt: inDays(5) });
  assert.ok(!viaDelegate.ok && /Only the owner/.test(viaDelegate.reason));
});

test("delegate limits: only own capabilities, must set expiry, max days, not beyond own expiry", () => {
  const d = (over = {}) => create({ actorId: "mgr", existingGrants: [managerGrant()], expiresAt: inDays(10), ...over });
  assert.equal(d().ok, true);
  assert.equal(d({ capabilities: ["view", "download"] }).ok, false);      // manager lacks download
  assert.equal(d({ expiresAt: null }).ok, false);                          // expiry required
  assert.equal(d({ expiresAt: inDays(DELEGATE_MAX_GRANT_DAYS + 1) }).ok, false);
  assert.equal(d({ expiresAt: inDays(DELEGATE_MAX_GRANT_DAYS) }).ok, true);
  const shortLived = [managerGrant({ expiresAt: inDays(5) })];
  assert.equal(d({ existingGrants: shortLived, expiresAt: inDays(10) }).ok, false); // outlasts the manager
  assert.equal(d({ existingGrants: shortLived, expiresAt: inDays(4) }).ok, true);
  assert.equal(d({ granteeId: "owner" }).ok, false);
  assert.equal(d({ granteeId: "mgr" }).ok, false);
});

test("recipient cap uses the owner's plan; updating an existing recipient does not count twice", () => {
  const tiny: SharingPolicy = { ...PRO, maxRecipientsPerCollection: 2 };
  const grants = [makeGrant({ granteeId: "a" }), makeGrant({ granteeId: "b" })];
  assert.equal(countActiveRecipients("col1", "owner", grants, NOW), 2);
  const third = create({ policy: tiny, existingGrants: grants, granteeId: "c" });
  assert.ok(!third.ok && /2 of 2/.test(third.reason));
  assert.equal(create({ policy: tiny, existingGrants: grants, granteeId: "a", capabilities: ["view"] }).ok, true); // update
  // Revoked or expired grants free a slot.
  const freed = [makeGrant({ granteeId: "a", status: "revoked" }), makeGrant({ granteeId: "b", expiresAt: inDays(-1) })];
  assert.equal(create({ policy: tiny, existingGrants: freed, granteeId: "c" }).ok, true);
  assert.equal(create({ policy: { ...PRO, maxRecipientsPerCollection: 0 } }).ok, false); // Free-like cap
});

test("a delegate's grants count toward the same cap", () => {
  const tiny: SharingPolicy = { ...PRO, maxRecipientsPerCollection: 2 };
  const grants = [managerGrant({ granteeId: "mgr" }), makeGrant({ granteeId: "a" })];
  assert.equal(create({ actorId: "mgr", policy: tiny, existingGrants: grants, granteeId: "z", expiresAt: inDays(3) }).ok, false);
});

test("revocation: owner revokes anything; delegate only their own non-manager grants", () => {
  const theirs = makeGrant({ granteeId: "x", grantedById: "mgr" });
  const ownersGrant = makeGrant({ granteeId: "y", grantedById: "owner" });
  const otherManager = makeGrant({ granteeId: "m2", capabilities: ["view", "manage"], grantedById: "mgr" });
  const all = [managerGrant(), theirs, ownersGrant, otherManager];
  const revoke = (actorId: string, grant = theirs) => planGrantRevocation({ actorId, collection: col, grant, allGrants: all, policy: PRO, now: NOW });
  assert.ok(revoke("owner", ownersGrant).ok);
  assert.ok(revoke("mgr", theirs).ok);
  assert.equal(revoke("mgr", ownersGrant).ok, false);
  assert.equal(revoke("mgr", otherManager).ok, false);
  assert.equal(revoke("eve").ok, false);
  const result = revoke("owner", theirs);
  assert.ok(result.ok && result.grant.status === "revoked");
});

test("only the owner changes visibility", () => {
  assert.equal(canChangeVisibility("owner", col), true);
  assert.equal(canChangeVisibility("mgr", col), false);
});

test("plan downgrade: reports what is outside the new plan, never silently removes access", () => {
  const grants = [managerGrant(), makeGrant({ granteeId: "a", expiresAt: inDays(3) }), makeGrant({ granteeId: "b" }), makeGrant({ granteeId: "c" }), makeGrant({ granteeId: "d" }), makeGrant({ granteeId: "e" })];
  const report = findGrantsOutsidePolicy(col, grants, CREATOR, NOW);
  assert.deepEqual([report.overCapBy, report.delegateGrantIds, report.expiringGrantCount], [1, ["mgr"], 1]);
  assert.equal(grants.every((g) => g.status === "active"), true);
});
