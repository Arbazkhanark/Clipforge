// Granting and revoking collection access. The plan limits that apply are the COLLECTION OWNER's plan.
import { CAPABILITIES, type Capability } from "../../lib/domain/types.ts";
import { generateShareToken } from "../../lib/domain/sharing-permissions.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, conflict, forbidden, notFound, planLimit, validationFailed } from "../errors.ts";
import { Problems, readEnumList, readId, readObject, readOptionalDate } from "../validation.ts";

function throwGrantMutationError(result: { status: string; reason?: string }): never {
  if (result.status === "not_found") throw notFound("Collection or access grant");
  if (result.status === "plan_limit") throw planLimit(result.reason ?? "The collection owner’s plan does not allow this sharing change.");
  if (result.status === "invalid") throw validationFailed([result.reason ?? "The sharing request is invalid."]);
  if (result.status === "forbidden") throw forbidden(result.reason ?? "You are not allowed to manage this access.");
  throw conflict("Sharing changed while this request was being processed. Reload and try again.");
}

function throwShareLinkMutationError(result: { status: string; reason?: string }): never {
  if (result.status === "not_found") throw notFound("Collection share link");
  if (result.status === "plan_limit") throw planLimit(result.reason ?? "Your current plan does not allow this share link.");
  if (result.status === "invalid") throw validationFailed([result.reason ?? "The share link settings are invalid."]);
  if (result.status === "revoked") throw conflict("This share link has been revoked and cannot be changed.");
  throw conflict("The share link changed while this request was being processed. Reload and try again.");
}

/** Returns the raw capability URL only to this creation response. It is never persisted or audited. */
export async function createCollectionShareLink(ctx: RequestContext, rawInput: unknown): Promise<{ collectionId: string; path: string }> {
  const ownerId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const capabilities = readEnumList(input, "capabilities", problems, CAPABILITIES.filter((capability) => capability !== "manage"), { min: 1, max: CAPABILITIES.length - 1 });
  const expiresAt = readOptionalDate(input, "expiresAt", problems);
  problems.throwIfAny();
  const { token, tokenHash } = generateShareToken();
  const result = await ctx.repo.createCollectionShareLink({ id: ctx.newId(), collectionId, ownerId, tokenHash, capabilities: [...new Set(capabilities)] as Capability[], expiresAt, now: ctx.now });
  if (result.status !== "created") throwShareLinkMutationError(result);
  return { collectionId, path: `/shared/${token}` };
}

export async function updateCollectionShareLink(ctx: RequestContext, rawInput: unknown): Promise<{ id: string; status: "updated" | "unchanged" }> {
  const ownerId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const id = readId(input, "shareLinkId", problems);
  const capabilities = readEnumList(input, "capabilities", problems, CAPABILITIES.filter((capability) => capability !== "manage"), { min: 1, max: CAPABILITIES.length - 1 });
  const expiresAt = readOptionalDate(input, "expiresAt", problems);
  problems.throwIfAny();
  const result = await ctx.repo.updateCollectionShareLink({ id, collectionId, ownerId, capabilities: [...new Set(capabilities)] as Capability[], expiresAt, now: ctx.now });
  if (result.status !== "updated" && result.status !== "unchanged") throwShareLinkMutationError(result);
  return { id, status: result.status };
}

export async function revokeCollectionShareLink(ctx: RequestContext, rawInput: unknown): Promise<{ id: string; status: "revoked" | "already_revoked" }> {
  const ownerId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const id = readId(input, "shareLinkId", problems);
  problems.throwIfAny();
  const status = await ctx.repo.revokeCollectionShareLink({ id, collectionId, ownerId, now: ctx.now });
  if (status === "not_found") throw notFound("Collection share link");
  return { id, status };
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

  const result = await ctx.repo.createOrUpdateCollectionGrant({ collectionId, actorId: userId, granteeId, capabilities, expiresAt, now: ctx.now });
  if (result.status !== "applied" && result.status !== "existing") throwGrantMutationError(result);
  return { granteeId, capabilities: result.grant.capabilities, expiresAt: result.grant.expiresAt?.toISOString() ?? null };
}

export async function revokeGrant(ctx: RequestContext, rawInput: unknown): Promise<{ granteeId: string; status: "revoked" }> {
  const userId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const granteeId = readId(input, "granteeId", problems);
  problems.throwIfAny();

  const result = await ctx.repo.revokeCollectionGrant({ collectionId, actorId: userId, granteeId, now: ctx.now });
  if (result.status !== "applied") throwGrantMutationError(result);
  return { granteeId, status: "revoked" };
}

export async function requestCollectionAccess(ctx: RequestContext, rawInput: unknown): Promise<{ requestId: string; status: "created" | "existing" }> {
  const requesterId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const capabilities = readEnumList(input, "requestedCapabilities", problems, CAPABILITIES.filter((capability) => capability !== "manage"), { min: 1, max: CAPABILITIES.length - 1 });
  problems.throwIfAny();
  const result = await ctx.repo.createCollectionAccessRequest({ id: ctx.newId(), collectionId, requesterId, requestedCapabilities: capabilities as Capability[], now: ctx.now });
  if (result.status === "not_found") throw notFound("Collection");
  if (result.status === "already_has_access") throw conflict("You already have access to this collection.");
  if (result.status === "invalid") throw validationFailed([result.reason ?? "The access request is invalid."]);
  if (result.status === "conflict") throw conflict("An access request changed while this request was being processed. Reload and try again.");
  if (result.status !== "created" && result.status !== "existing") throw conflict("The access request could not be saved. Reload and try again.");
  return { requestId: result.request.id, status: result.status };
}

export async function decideCollectionAccessRequest(ctx: RequestContext, rawInput: unknown): Promise<{ requestId: string; status: "approved" | "rejected" }> {
  const ownerId = requireUser(ctx);
  const problems = new Problems();
  const input = readObject(rawInput, problems);
  const collectionId = readId(input, "collectionId", problems);
  const requestId = readId(input, "requestId", problems);
  const decision = input["decision"];
  if (decision !== "approved" && decision !== "rejected") problems.add("decision must be approved or rejected.");
  problems.throwIfAny();
  const result = await ctx.repo.decideCollectionAccessRequest({ collectionId, requestId, ownerId, decision: decision as "approved" | "rejected", now: ctx.now });
  if (result.status === "not_found") throw notFound("Access request");
  if (result.status === "already_decided") throw conflict("This access request has already been decided.");
  if (result.status === "plan_limit") throw planLimit(result.reason ?? "The collection owner's plan does not allow this grant.");
  if (result.status === "invalid") throw validationFailed([result.reason ?? "The access request cannot be approved."]);
  if (result.status === "forbidden") throw forbidden(result.reason ?? "Only the collection owner can decide this request.");
  if (result.status === "conflict") throw conflict("This access request changed while being decided. Reload and try again.");
  return { requestId, status: decision as "approved" | "rejected" };
}

export { AppError };
