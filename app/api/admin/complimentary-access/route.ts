import { createHash } from "node:crypto";
import { AppError } from "../../../../src/server/errors.ts";
import { adminApiRoute } from "../../../../src/server/admin/api-route.ts";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { readSmallJson } from "../../../../src/server/billing/request-json.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
async function ensureVerifiedAdmin(adminId: string): Promise<void> {
  const runtime = getRuntime();
  if (!runtime.auth || !(await runtime.auth.isEmailVerified(adminId))) throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
}
function parseObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_access_request", "Access details are invalid.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new AppError(400, "invalid_access_request", "Access details contain unsupported fields.");
  return body;
}
function parseNote(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 500) throw new AppError(400, "invalid_access_request", "Reason must be 500 characters or fewer.");
  return value.trim() || null;
}

export const GET = adminApiRoute(async (request, adminId) => {
  await ensureVerifiedAdmin(adminId);
  const userId = new URL(request.url).searchParams.get("userId") ?? "";
  if (!ID.test(userId)) throw new AppError(400, "invalid_user", "Choose a valid user ID.");
  return json(await getRuntime().repo.listComplimentaryAccessForUser(userId));
});

export const POST = adminApiRoute(async (request, adminId) => {
  await ensureVerifiedAdmin(adminId);
  const parsed = await readSmallJson(request);
  if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "Access details are invalid.");
  const body = parseObject(parsed.value, ["userId", "planId", "note"]);
  if (typeof body.userId !== "string" || !ID.test(body.userId) || !["creator", "pro", "agency"].includes(String(body.planId))) throw new AppError(400, "invalid_access_request", "User and plan are required.");
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) throw new AppError(400, "idempotency_key_required", "A valid idempotency key is required.");
  const id = `ca_${createHash("sha256").update(`${adminId}:${idempotencyKey}`).digest("hex").slice(0, 48)}`;
  const result = await getRuntime().repo.grantComplimentaryAccess({ id, userId: body.userId, planId: body.planId as "creator" | "pro" | "agency", adminId, note: parseNote(body.note), now: getRuntime().now() });
  if (result.status === "forbidden") throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (result.status === "missing_user") throw new AppError(404, "user_not_found", "The selected user was not found.");
  if (result.status === "already_granted") throw new AppError(409, "access_already_granted", "This user already has an active complimentary grant.");
  if (result.status === "conflict") throw new AppError(409, "grant_conflict", "The grant request conflicts with an existing record.");
  return json({ status: result.status, grant: result.grant }, result.status === "created" ? 201 : 200);
});

export const PATCH = adminApiRoute(async (request, adminId) => {
  await ensureVerifiedAdmin(adminId);
  const parsed = await readSmallJson(request);
  if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "Access transition details are invalid.");
  const body = parseObject(parsed.value, ["userId", "grantId", "action", "note"]);
  if (typeof body.userId !== "string" || !ID.test(body.userId) || typeof body.grantId !== "string" || !ID.test(body.grantId) || !["HOLD", "RESUME", "REVOKE"].includes(String(body.action))) throw new AppError(400, "invalid_access_request", "Access transition details are invalid.");
  const result = await getRuntime().repo.transitionComplimentaryAccess({ userId: body.userId, grantId: body.grantId, adminId, action: body.action as "HOLD" | "RESUME" | "REVOKE", note: parseNote(body.note), now: getRuntime().now() });
  if (result === "forbidden") throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (result === "missing") throw new AppError(404, "grant_not_found", "The grant was not found.");
  if (result === "invalid_transition") throw new AppError(409, "invalid_access_transition", "This access state cannot make that transition.");
  return json({ status: result });
});
