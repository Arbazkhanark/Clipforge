// Runs a read query for a page and turns failures into a result the page can show, instead of crashing.
import { buildContext, getRuntime, type RuntimeMode } from "./runtime.ts";
import type { RequestContext } from "./context.ts";
import { AppError } from "./errors.ts";

export type PageResult<T> = { ok: true; data: T; mode: RuntimeMode } | { ok: false; error: AppError; mode: RuntimeMode };

export async function loadPageData<T>(query: (ctx: RequestContext) => Promise<T>): Promise<PageResult<T>> {
  const runtime = getRuntime();
  try { return { ok: true, data: await query(await buildContext(runtime)), mode: runtime.mode }; }
  catch (error) {
    if (error instanceof AppError) return { ok: false, error, mode: runtime.mode };
    throw error; // unexpected errors are real bugs: let Next.js show its error page
  }
}
