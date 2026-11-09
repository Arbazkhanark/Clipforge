const ID = /^[A-Za-z0-9_-]{1,64}$/;
const LOCAL_ORIGIN = "https://clipforge-return.invalid";

/** Accept only internal customer routes; never turn a login form into an open redirect. */
export function safeCustomerReturnPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 1024 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return "/dashboard";
  try {
    const url = new URL(raw, LOCAL_ORIGIN);
    if (url.origin !== LOCAL_ORIGIN) return "/dashboard";
    const path = url.pathname;
    const allowed = path === "/dashboard" || path === "/media" || path === "/collections" || path === "/cycles" || path === "/instagram" || path === "/editor"
      || /^\/media\/[A-Za-z0-9_-]{1,64}$/.test(path)
      || /^\/collections\/[A-Za-z0-9_-]{1,64}$/.test(path)
      || /^\/cycles\/[A-Za-z0-9_-]{1,64}$/.test(path)
      || /^\/shared\/[A-Za-z0-9_-]{43}$/.test(path)
      || path === "/editor/bulk" || path === "/editor/batch";
    if (!allowed) return "/dashboard";
    if (path === "/editor") {
      const media = url.searchParams.get("media");
      if (media && !ID.test(media)) return "/editor";
      return media ? `/editor?media=${encodeURIComponent(media)}` : "/editor";
    }
    return path;
  } catch { return "/dashboard"; }
}
