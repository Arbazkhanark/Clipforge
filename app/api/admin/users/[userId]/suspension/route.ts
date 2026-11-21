import { AppError } from "../../../../../../src/server/errors.ts";
import { getRuntime } from "../../../../../../src/server/runtime.ts";
import { adminApiRoute } from "../../../../../../src/server/admin/api-route.ts";
import { readSmallJson } from "../../../../../../src/server/billing/request-json.ts";

function userIdFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const encoded = segments.at(-2) ?? "";
  let userId: string;
  try { userId = decodeURIComponent(encoded); } catch { throw new AppError(400, "invalid_user_id", "Invalid user identifier."); }
  if (!userId || userId.length > 128 || userId.includes("/") || /[\u0000-\u001f\u007f]/.test(userId)) throw new AppError(400, "invalid_user_id", "Invalid user identifier.");
  return userId;
}

export const GET = adminApiRoute(async (request, adminId) => {
  if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "This endpoint is read-only.");
  const runtime = getRuntime();
  if (!runtime.auth || !(await runtime.auth.isEmailVerified(adminId))) throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (!runtime.adminData) throw new AppError(503, "admin_data_unavailable", "Admin data is not available in this runtime.");
  const data = await (await runtime.adminData()).getUserSuspension(userIdFromRequest(request));
  if (!data) throw new AppError(404, "not_found", "User was not found.");
  return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = adminApiRoute(async (request, adminId) => {
  const runtime = getRuntime();
  if (!runtime.auth || !(await runtime.auth.isEmailVerified(adminId))) throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (!runtime.adminData) throw new AppError(503, "admin_data_unavailable", "Admin data is not available in this runtime.");
  const parsed = await readSmallJson(request);
  if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "A valid JSON request is required.");
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) throw new AppError(400, "invalid_request", "A valid JSON request is required.");
  const body = parsed.value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["suspended", "reason"].includes(key)) || typeof body.suspended !== "boolean") throw new AppError(422, "invalid_suspension_request", "Choose whether the account should be suspended or reactivated.");
  const reason = body.reason === undefined || body.reason === null ? null : typeof body.reason === "string" ? body.reason.trim() : undefined;
  if (reason === undefined || (reason !== null && (reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)))) throw new AppError(422, "invalid_suspension_reason", "The reason must be 500 characters or fewer.");
  const result = await (await runtime.adminData()).setUserSuspension({ userId: userIdFromRequest(request), adminId, suspended: body.suspended, reason, now: runtime.now(), newId: runtime.newId });
  if (result === "forbidden") throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (result === "not_found") throw new AppError(404, "not_found", "User was not found.");
  return Response.json({ status: result }, { status: result === "suspended" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
});
