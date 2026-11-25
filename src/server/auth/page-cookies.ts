// Server-rendered PAGES have no Request object, so the session cookie is read from Next.js's request headers.
// Loaded dynamically so nothing needs Next.js until a server-rendered page asks for the cookie.
// Tests replace this with setPageCookieReaderForTests.
export type CookieHeaderReader = () => Promise<string | null>;

const defaultReader: CookieHeaderReader = async () => {
  const { headers } = await import("next/headers.js");
  return (await headers()).get("cookie"); // `await` works for both the older synchronous and the newer async API
};

let reader: CookieHeaderReader = defaultReader;
export const readPageCookieHeader: CookieHeaderReader = () => reader();
export function setPageCookieReaderForTests(replacement: CookieHeaderReader | null): void { reader = replacement ?? defaultReader; }
