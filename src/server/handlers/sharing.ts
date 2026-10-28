// Granting and revoking collection access. The plan limits that apply are the COLLECTION OWNER's plan.
import { CAPABILITIES } from "../../lib/domain/types.ts";
import { getPlan } from "../../lib/billing/catalog.ts";
import { getCollectionCapabilities } from "../../lib/domain/sharing-permissions.ts";
import { planGrantCreation, planGrantRevocation } from "../../lib/domain/sharing-management.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, forbidden, notFound, planLimit, validationFailed } from "../errors.ts";
import { Problems, readEnumList, readId, readObject, readOptionalDate } from "../validation.ts";

/** Strangers must not learn that a collection exists, so "no view access" looks like "not found". */
async function loadCollectionForSharingAction(ctx: RequestContext, userId: string, collectionId: string) {
  const collection = await ctx.repo.getCollection(collectionId);
  if (!collection) throw notFound("Collection");
  const grants = await ctx.repo.getGrants(collectionId);
  if (!getCollectionCapabilities(userId, collection, grants, ctx.now).has("view")) throw notFound("Collection");
  const ownerPlanId = await ctx.repo.getPlanIdForUser(collection.ownerId);
  return { collection, grants, policy: getPlan(ownerPlanId).sharing };
}

export async function createGrant(ctx: RequestContext, rawInput: unknown): Promise<{ granteeId: string; capabilities: string[]; expiresAt: string | null }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const granteeId = readId(input, "granteeId", problems);
  const capabilities = readEnumList(input, "capabilities", problems, CAPABILITIES, { min: 1, max: CAPABILITIES.length });
  const expiresAt = readOptionalDate(input, "expiresAt", problems);
  problems.throwIfAny();

  const { collection, grants, policy } = await loadCollectionForSharingAction(ctx, userId, collectionId);
  const plan = planGrantCreation({ actorId: userId, granteeId, collection, existingGrants: grants, capabilities, expiresAt, policy, now: ctx.now });
  if (!plan.ok) {
    if (plan.code === "invalid") throw validationFailed([plan.reason]);
    if (plan.code === "plan_limit") throw planLimit(plan.reason);
    throw forbidden(plan.reason);
  }
  await ctx.repo.upsertGrant(plan.grant);
  await ctx.repo.appendAudit({ actorId: userId, action: "sharing.grant_created", entityType: "VideoCollection", entityId: collectionId, metadata: { granteeId, capabilities: plan.grant.capabilities, expiresAt: expiresAt?.toISOString() ?? null } });
  return { granteeId, capabilities: plan.grant.capabilities, expiresAt: expiresAt?.toISOString() ?? null };
}

export async function revokeGrant(ctx: RequestContext, rawInput: unknown): Promise<{ granteeId: string; status: "revoked" }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const granteeId = readId(input, "granteeId", problems);
  problems.throwIfAny();

  const { collection, grants, policy } = await loadCollectionForSharingAction(ctx, userId, collectionId);
  const grant = grants.find((g) => g.granteeId === granteeId && g.status === "active");
  if (!grant) throw notFound("Access grant");
  const plan = planGrantRevocation({ actorId: userId, collection, grant, allGrants: grants, policy, now: ctx.now });
  if (!plan.ok) throw forbidden(plan.reason);
  await ctx.repo.upsertGrant(plan.grant);
  await ctx.repo.appendAudit({ actorId: userId, action: "sharing.grant_revoked", entityType: "VideoCollection", entityId: collectionId, metadata: { granteeId } });
  return { granteeId, status: "revoked" };
}

export { AppError };
