export async function readSmallJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415; error: string }> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return { ok: false, status: 415, error: "unsupported_media_type" };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 8192) return { ok: false, status: 413, error: "payload_too_large" };
  let text: string; try { text = await request.text(); } catch { return { ok: false, status: 400, error: "invalid_request" }; }
  if (text.length > 8192) return { ok: false, status: 413, error: "payload_too_large" };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false, status: 400, error: "invalid_request" }; }
}
