import { getRuntime } from "../../../../src/server/runtime.ts";

export const dynamic = "force-dynamic";

/** Generic dependency readiness; internal error details and infrastructure identity stay server-side. */
export async function GET(): Promise<Response> {
  const runtime = getRuntime();
  if (runtime.mode !== "database" || !runtime.checkReadiness) {
    return Response.json({ status: "not_ready" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    await runtime.checkReadiness();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "not_ready" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
