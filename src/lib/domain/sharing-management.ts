// Advanced sharing management: who may create/revoke grants, expiring grants, delegated
// managers with clear limits, and recipient caps. Pure rules - the server calls these on EVERY request.
//
// WHAT A DELEGATED MANAGER ("manage" capability) MAY DO
//   + approve/create grants for other people, but ONLY for capabilities the manager holds themselves
//   + only with an expiry date, no later than their own expiry and no later than DELEGATE_MAX_GRANT_DAYS from now
//   + revoke grants THEY created
// WHAT THEY MAY NEVER DO
//   - give anyone the "manage" capability (only the owner can delegate)
//   - revoke the owner's or other managers' grants, or grants made by someone else
//   - change collection visibility (e.g. make it public), delete the collection, or touch the owner's media files
//   - exceed the recipient cap that belongs to the collection OWNER's plan
// Delegation only works while the owner's plan includes delegatedManagement.
import { getCollectionCapabilities } from "./sharing-permissions.ts";
import type { Capability, CollectionPermissionGrant, UserId, VideoCollection } from "./types.ts";
import { CAPABILITIES } from "./types.ts";

/** Adjustable limit (placeholder chosen by the developer; confirm with the product owner). */
export const DELEGATE_MAX_GRANT_DAYS = 90;

/** The slice of the plan catalog these rules need (PlanDefinition["sharing"] of the OWNER's plan). */
export interface SharingPolicy {
  expiringGrants: boolean;
  delegatedManagement: boolean;
  maxRecipientsPerCollection: number;
}

export type SharingActorRole = "owner" | "delegate" | "none";

export function getSharingActorRole(
  actorId: UserId, collection: VideoCollection, grants: CollectionPermissionGrant[], policy: SharingPolicy, now: Date,
): SharingActorRole {
  if (collection.ownerId === actorId) return "owner";
  if (!policy.delegatedManagement) return "none"; // owner's plan no longer includes delegation
  const capabilities = getCollectionCapabilities(actorId, collection, grants, now);
  return capabilities.has("manage") ? "delegate" : "none";
}

/** Only the owner changes visibility (private / link / public view). Delegates never do. */
export function canChangeVisibility(actorId: UserId, collection: VideoCollection): boolean {
  return collection.ownerId === actorId;
}

const isCurrentlyValid = (g: CollectionPermissionGrant, now: Date): boolean =>
  g.status === "active" && (g.expiresAt === null || g.expiresAt > now);

/** People (not the owner) holding a currently valid grant on this collection. */
export function countActiveRecipients(collectionId: string, ownerId: UserId, grants: CollectionPermissionGrant[], now: Date): number {
  return new Set(grants.filter((g) => g.collectionId === collectionId && g.granteeId !== ownerId && isCurrentlyValid(g, now)).map((g) => g.granteeId)).size;
}

export type GrantPlan =
  | { ok: true; grant: CollectionPermissionGrant }
  | { ok: false; reason: string };

/** Decide whether `actorId` may give `granteeId` these capabilities. Returns the grant to save. */
export function planGrantCreation(args: {
  actorId: UserId; granteeId: UserId; collection: VideoCollection; existingGrants: CollectionPermissionGrant[];
  capabilities: Capability[]; expiresAt: Date | null; policy: SharingPolicy; now: Date;
}): GrantPlan {
  const { actorId, granteeId, collection, existingGrants, capabilities, expiresAt, policy, now } = args;
  const fail = (reason: string): GrantPlan => ({ ok: false, reason });

  const role = getSharingActorRole(actorId, collection, existingGrants, policy, now);
  if (role === "none") return fail("You are not allowed to manage sharing for this collection.");
  if (granteeId === collection.ownerId) return fail("The owner already has full access.");
  if (granteeId === actorId) return fail("You cannot give permissions to yourself.");

  const uniqueCapabilities = [...new Set(capabilities)];
  if (uniqueCapabilities.length === 0) return fail("Choose at least one permission.");
  if (!uniqueCapabilities.every((c) => (CAPABILITIES as readonly string[]).includes(c))) return fail("Unknown permission requested.");

  // "manage" is the delegation itself: owner only, and only if the plan includes it.
  if (uniqueCapabilities.includes("manage")) {
    if (role !== "owner") return fail("Only the owner can give someone the manage permission.");
    if (!policy.delegatedManagement) return fail("Delegated management is not included in your plan.");
  }

  // Expiry rules.
  if (expiresAt !== null) {
    if (!policy.expiringGrants) return fail("Expiring access is not included in your plan.");
    if (expiresAt <= now) return fail("The expiry date must be in the future.");
  }

  if (role === "delegate") {
    const delegateCapabilities = getCollectionCapabilities(actorId, collection, existingGrants, now);
    const tooMuch = uniqueCapabilities.filter((c) => !delegateCapabilities.has(c));
    if (tooMuch.length > 0) return fail(`You cannot give permissions you do not have yourself: ${tooMuch.join(", ")}.`);
    if (expiresAt === null) return fail("Grants made by a delegated manager must have an expiry date.");
    const latestAllowed = new Date(now.getTime() + DELEGATE_MAX_GRANT_DAYS * 86_400_000);
    if (expiresAt > latestAllowed) return fail(`Grants made by a delegated manager can last at most ${DELEGATE_MAX_GRANT_DAYS} days.`);
    const delegateOwnGrant = existingGrants.find((g) => g.collectionId === collection.id && g.granteeId === actorId && isCurrentlyValid(g, now));
    if (delegateOwnGrant?.expiresAt && expiresAt > delegateOwnGrant.expiresAt) return fail("A grant cannot outlast your own access.");
  }

  // Recipient cap (the collection owner's plan). Updating someone who already has access does not add a recipient.
  const alreadyRecipient = existingGrants.some((g) => g.collectionId === collection.id && g.granteeId === granteeId && isCurrentlyValid(g, now));
  const activeRecipients = countActiveRecipients(collection.id, collection.ownerId, existingGrants, now);
  if (!alreadyRecipient && activeRecipients + 1 > policy.maxRecipientsPerCollection) {
    return fail(`This collection already has ${activeRecipients} of ${policy.maxRecipientsPerCollection} allowed recipients.`);
  }

  return { ok: true, grant: { collectionId: collection.id, granteeId, capabilities: uniqueCapabilities, status: "active", expiresAt, grantedById: actorId } };
}

/** Owner can revoke any grant. A delegate can revoke only grants they created, never a manager's grant. */
export function planGrantRevocation(args: {
  actorId: UserId; collection: VideoCollection; grant: CollectionPermissionGrant;
  allGrants: CollectionPermissionGrant[]; policy: SharingPolicy; now: Date;
}): { ok: true; grant: CollectionPermissionGrant } | { ok: false; reason: string } {
  const { actorId, collection, grant, allGrants, policy, now } = args;
  const role = getSharingActorRole(actorId, collection, allGrants, policy, now);
  if (role === "none") return { ok: false, reason: "You are not allowed to manage sharing for this collection." };
  if (grant.collectionId !== collection.id) return { ok: false, reason: "That grant belongs to a different collection." };
  if (role === "delegate") {
    if (grant.capabilities.includes("manage")) return { ok: false, reason: "Only the owner can remove a manager." };
    if (grant.grantedById !== actorId) return { ok: false, reason: "You can only revoke access that you granted." };
  }
  return { ok: true, grant: { ...grant, status: "revoked" } };
}

/**
 * When the owner's plan drops (e.g. Pro -> Creator) delegation and expiry features may disappear.
 * We never silently delete anyone's access. We report what is now outside the plan so the owner can decide.
 */
export function findGrantsOutsidePolicy(
  collection: VideoCollection, grants: CollectionPermissionGrant[], policy: SharingPolicy, now: Date,
): { overCapBy: number; delegateGrantIds: string[]; expiringGrantCount: number } {
  const valid = grants.filter((g) => g.collectionId === collection.id && g.granteeId !== collection.ownerId && isCurrentlyValid(g, now));
  const recipients = countActiveRecipients(collection.id, collection.ownerId, grants, now);
  return {
    overCapBy: Math.max(0, recipients - policy.maxRecipientsPerCollection),
    delegateGrantIds: policy.delegatedManagement ? [] : valid.filter((g) => g.capabilities.includes("manage")).map((g) => g.granteeId),
    expiringGrantCount: policy.expiringGrants ? 0 : valid.filter((g) => g.expiresAt !== null).length,
  };
}
