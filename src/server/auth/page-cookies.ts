// Server-rendered PAGES have no Request object, so the session cookie is read from Next.js's request headers.
// UNVERIFIED: `next/headers` is not installed here, so this has never run under Next.js. It is loaded dynamically, so
// nothing needs Next.js until a page really asks for the cookie. Tests replace it with setPageCookieReaderForTests.
export type CookieHeaderReader = () => Promise<string | null>;

const defaultReader: CookieHeaderReader = async () => {
  const { headers } = await import("next/headers");
  return (await headers()).get("cookie"); // `await` works for both the older synchronous and the newer async API
};

let reader: CookieHeaderReader = defaultReader;
export const readPageCookieHeader: CookieHeaderReader = () => reader();
export function setPageCookieReaderForTests(replacement: CookieHeaderReader | null): void { reader = replacement ?? defaultReader; }
