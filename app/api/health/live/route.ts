export const dynamic = "force-dynamic";

/** Process liveness only; intentionally independent of databases and storage. */
export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
