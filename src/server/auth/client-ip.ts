// The address used for login rate limiting.
// X-Forwarded-For is ignored unless CLIPFORGE_TRUSTED_PROXY_HOPS says how many proxies we operate.
// Those proxies must APPEND the peer address. The client is the entry immediately before them.
// A short or malformed header does not choose a bucket, so a caller cannot invent a fresh address.
import { isIP } from "node:net";

function normalizeIp(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 45 || value.includes("%") || value.startsWith("[")) return null;
  const mapped = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  if (isIP(mapped) === 4) return mapped;
  if (isIP(value) === 6) return value;
  return null;
}

/** Null when no trusted proxy count is configured, or the header cannot name the client safely. */
export function clientIpForRateLimit(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env["CLIPFORGE_TRUSTED_PROXY_HOPS"]?.trim() ?? "";
  if (!/^[1-9]\d{0,2}$/.test(raw)) return null;
  const header = request.headers.get("x-forwarded-for");
  if (!header || header.length > 2000) return null;
  const parts = header.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const client = parts[parts.length - Number(raw) - 1];
  return client === undefined ? null : normalizeIp(client);
}
