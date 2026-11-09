import { notFound, redirect } from "next/navigation.js";
import { AppError } from "../errors.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { requireAdmin } from "./authorization.ts";

/** Server Component guard: unauthenticated visitors use the private admin login; ordinary users get a concealed 404. */
export async function requireAdminPage(runtime: Runtime = getRuntime()): Promise<string> {
  try {
    return await requireAdmin(runtime);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/admin/login");
    if (error instanceof AppError && error.status === 403) notFound();
    throw error;
  }
}
