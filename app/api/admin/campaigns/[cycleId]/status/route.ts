import { AppError } from "../../../../../../src/server/errors.ts";
import { getRuntime } from "../../../../../../src/server/runtime.ts";
import { adminApiRoute } from "../../../../../../src/server/admin/api-route.ts";
import { readSmallJson } from "../../../../../../src/server/billing/request-json.ts";

function cycleIdFromRequest(request: Request): string {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const encoded = segments.at(-2) ?? "";
  let cycleId: string;
  try { cycleId = decodeURIComponent(encoded); } catch { throw new AppError(400, "invalid_cycle_id", "Invalid cycle identifier."); }
  if (!cycleId || cycleId.length > 128 || cycleId.includes("/") || /[\u0000-\u001f\u007f]/.test(cycleId)) throw new AppError(400, "invalid_cycle_id", "Invalid cycle identifier.");
  return cycleId;
}

export const POST = adminApiRoute(async (request, adminId) => {
  const runtime = getRuntime();
  if (!runtime.auth || !(await runtime.auth.isEmailVerified(adminId))) throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (!runtime.adminData) throw new AppError(503, "admin_data_unavailable", "Admin data is not available in this runtime.");
  const parsed = await readSmallJson(request);
  if (!parsed.ok) throw new AppError(parsed.status, parsed.error, "A valid JSON request is required.");
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) throw new AppError(400, "invalid_request", "A valid JSON request is required.");
  const body = parsed.value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["action", "reason"].includes(key)) || (body.action !== "pause" && body.action !== "resume")) throw new AppError(422, "invalid_cycle_action", "Only pause or resume is supported.");
  const reason = body.reason === undefined || body.reason === null ? null : typeof body.reason === "string" ? body.reason.trim() : undefined;
  if (reason === undefined || (reason !== null && (reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)))) throw new AppError(422, "invalid_cycle_reason", "The reason must be 500 characters or fewer.");
  const result = await (await runtime.adminData()).setCyclePauseState({ cycleId: cycleIdFromRequest(request), adminId, action: body.action, reason, now: runtime.now(), newId: runtime.newId });
  if (result.status === "forbidden") throw new AppError(403, "verified_admin_required", "Verified admin access is required.");
  if (result.status === "not_found") throw new AppError(404, "not_found", "Cycle was not found.");
  if (result.status === "invalid_transition") throw new AppError(409, "cycle_transition_unavailable", "This cycle cannot be paused or resumed from its current state.");
  return Response.json({ status: result.status, inFlightItemCount: result.inFlightItemCount }, { headers: { "Cache-Control": "no-store" } });
});
