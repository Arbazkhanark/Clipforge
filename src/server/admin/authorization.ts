import { notAuthenticated, forbidden } from "../errors.ts";
import { getRuntime, type Runtime } from "../runtime.ts";

/** Authorizes from a validated session and a fresh persisted user role, never request data. */
export async function requireAdmin(runtime: Runtime = getRuntime(), request?: Request): Promise<string> {
  const principal = await runtime.currentPrincipal?.(request);
  if (!principal) throw notAuthenticated();
  if (principal.role !== "admin") throw forbidden("Admin access is required.");
  return principal.userId;
}
