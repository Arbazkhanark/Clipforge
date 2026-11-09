/** Standalone synthetic-only visual preview. It is not an application route or an authorization bypass. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_PREVIEW_HOST, ADMIN_PREVIEW_PORT, assertAdminPreviewAllowed, renderAdminPreviewDocument } from "../src/server/admin/admin-preview-server.ts";

assertAdminPreviewAllowed(process.env["NODE_ENV"]);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${ADMIN_PREVIEW_HOST}`);
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
  if (url.pathname === "/globals.css" || url.pathname === "/preview.css") {
    const file = url.pathname === "/globals.css" ? path.join(projectRoot, "app", "globals.css") : path.join(projectRoot, "src", "components", "admin", "admin-preview.css");
    try {
      const css = await readFile(file, "utf8");
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : css);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Preview stylesheet unavailable.");
    }
    return;
  }
  const html = renderAdminPreviewDocument(url.pathname);
  if (!html) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Synthetic preview page not found."); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  response.end(request.method === "HEAD" ? undefined : html);
});

server.on("error", () => { console.error("Admin preview could not start on its loopback address and reserved port."); process.exitCode = 1; });
server.listen(ADMIN_PREVIEW_PORT, ADMIN_PREVIEW_HOST, () => {
  console.log(`Synthetic Admin Preview is ready: http://${ADMIN_PREVIEW_HOST}:${ADMIN_PREVIEW_PORT}/`);
  console.log("It serves synthetic display data only; no Admin session, API, database, or external service is used.");
  console.log("Press Ctrl+C to stop the preview.");
});
