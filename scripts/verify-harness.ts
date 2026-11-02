// VERIFICATION HARNESS - NOT PART OF THE APPLICATION AND NOT NEXT.JS.
// Next.js cannot be installed in the development sandbox (no network). To still exercise the app's REAL page and route modules in a
// REAL browser, this file serves them with the same file-based routing rules: app/**/page.tsx, app/**/route.ts, (route groups) and
// [dynamic] segments, nested layouts, Request/Response route handlers. It does NOT prove anything about Next.js itself (bundling,
// caching, RSC, `next/headers`, middleware, `next build`). Run:  CLIPFORGE_LOCAL_AUTH=true node --import tsx --import ./tests/helpers/register-css.mjs scripts/verify-harness.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setPageCookieReaderForTests } from "../src/server/auth/page-cookies.ts";

const root = path.resolve(import.meta.dirname, "..");
const appDir = path.join(root, "app");
const requestStore = new AsyncLocalStorage<{ cookie: string | null }>();
// Pages read the session cookie through this reader. In Next.js it is `next/headers`; here it is the current request's header.
setPageCookieReaderForTests(async () => requestStore.getStore()?.cookie ?? null);

interface Route { kind: "page" | "route"; file: string; segments: string[]; }
function discover(dir: string, segments: string[] = []): Route[] {
  const found: Route[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { const name = entry.name; found.push(...discover(path.join(dir, name), /^\(.*\)$/.test(name) ? segments : [...segments, name])); }
    else if (entry.name === "page.tsx") found.push({ kind: "page", file: path.join(dir, entry.name), segments });
    else if (entry.name === "route.ts") found.push({ kind: "route", file: path.join(dir, entry.name), segments });
  }
  return found;
}
const routes = discover(appDir);
const score = (r: Route) => r.segments.filter((s) => s.startsWith("[")).length; // static routes win over dynamic ones

function match(pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  const candidates = [...routes].sort((a, b) => score(a) - score(b));
  for (const route of candidates) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (route.segments.every((seg, i) => { const part = parts[i] as string; if (seg.startsWith("[")) { params[seg.slice(1, -1)] = decodeURIComponent(part); return true; } return seg === part; })) return { route, params };
  }
  return null;
}

async function renderPage(route: Route, params: Record<string, string>, url: URL): Promise<string> {
  const searchParams: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) { const all = url.searchParams.getAll(key); searchParams[key] = all.length > 1 ? all : (all[0] as string); }
  const mod = await import(route.file);
  let element = await mod.default({ params, searchParams });
  if (route.file.includes(`${path.sep}(app)${path.sep}`)) element = createElement((await import(path.join(appDir, "(app)", "layout.tsx"))).default, null, element);
  const rootLayout = await import(path.join(appDir, "layout.tsx"));
  const body = renderToStaticMarkup(createElement(rootLayout.default, null, element));
  const title = typeof mod.metadata?.title === "string" ? mod.metadata.title : "ClipForge";
  const head = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/[<>&]/g, "")}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/globals.css"></head>`;
  return "<!DOCTYPE html>" + body.replace(/<html lang="en">/, `<html lang="en">${head}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    if (url.pathname === "/icon.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end(readFileSync(path.join(appDir, "icon.svg"))); return; }
    if (url.pathname === "/globals.css") { res.writeHead(200, { "Content-Type": "text/css" }); res.end(readFileSync(path.join(appDir, "globals.css"))); return; }
    const found = match(url.pathname);
    if (!found) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found (harness)"); return; }
    await requestStore.run({ cookie: req.headers.cookie ?? null }, async () => {
      if (found.route.kind === "page") {
        if (method !== "GET") { res.writeHead(405); res.end(); return; }
        const html = await renderPage(found.route, found.params, url);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(html); return;
      }
      const mod = await import(found.route.file);
      const handler = mod[method];
      if (typeof handler !== "function") { res.writeHead(405, { Allow: Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k)).join(", ") }); res.end(); return; }
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(", "));
      const request = new Request(url.href, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req) as unknown as ReadableStream, duplex: "half" } as object) });
      const response: Response = await handler(request);
      const out: [string, string][] = [];
      response.headers.forEach((value, key) => { if (key !== "set-cookie") out.push([key, value]); });
      for (const cookie of response.headers.getSetCookie()) out.push(["set-cookie", cookie]);
      res.writeHead(response.status, out as unknown as string[]);
      if (response.body) Readable.fromWeb(response.body as never).pipe(res); else res.end();
    });
  } catch (error) {
    console.error("HARNESS ERROR", error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Harness error: " + (error instanceof Error ? error.message : String(error)));
  }
});

server.listen(Number(process.env["PORT"] ?? 0), "127.0.0.1", () => {
  const address = server.address();
  console.log(`LISTENING ${typeof address === "object" && address ? address.port : "?"} (routes: ${routes.length})`);
});
