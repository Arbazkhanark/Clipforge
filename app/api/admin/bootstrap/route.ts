/** First Admin provisioning is an operator-only CLI workflow, never a public API. */
export function POST(): Response {
  return Response.json(
    { error: "admin_bootstrap_disabled" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
