// REAL-BROWSER CHECK (Chromium via Playwright) against the verification harness - NOT Next.js. See scripts/verify-harness.ts.
// Usage: node scripts/browser-check.mjs      (needs ffmpeg, Playwright and a Chromium; prints PASS/FAIL per check, exit code 1 on any failure)
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium, request } = require(process.env.PLAYWRIGHT_MODULE ?? "/home/claude/.npm-global/lib/node_modules/playwright");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const results = []; const consoleErrors = []; const notes = []; const failedResponses = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([false, name, String(e.message ?? e).split("\n")[0]]); console.log(`FAIL  ${name}\n      ${String(e.message ?? e).split("\n").slice(0, 3).join("\n      ")}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg ?? "assertion failed"); };

// ---- fixtures (real media made by ffmpeg) ----
const dir = mkdtempSync(join(tmpdir(), "clipforge-browser-"));
const run = (args) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args]); if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr); };
run(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "a.mp4")]);
run(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libvorbis", "-shortest", join(dir, "b.webm")]);
run(["-f", "lavfi", "-i", "testsrc2=size=128x96", "-frames:v", "1", join(dir, "photo.png")]);
run(["-f", "lavfi", "-i", "color=c=0xffff00:s=100x50", "-frames:v", "1", join(dir, "logo.png")]);
writeFileSync(join(dir, "fake.mp4"), "this is plain text pretending to be a video file, not media at all");
const MP4 = readFileSync(join(dir, "a.mp4")); const PNG = readFileSync(join(dir, "photo.png")); const WEBM = readFileSync(join(dir, "b.webm"));

// ---- start the harness ----
const harness = spawn("node", ["--import", "tsx", "--import", "./tests/helpers/register-css.mjs", "scripts/verify-harness.ts"], { env: { ...process.env, CLIPFORGE_LOCAL_AUTH: "true", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
let harnessErrors = ""; harness.stderr.on("data", (d) => { harnessErrors += d.toString(); });
const port = await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("harness did not start")), 30000); harness.stdout.on("data", (d) => { const m = /LISTENING (\d+)/.exec(d.toString()); if (m) { clearTimeout(t); resolve(m[1]); } }); });
const BASE = `http://localhost:${port}`;
console.log(`Harness (NOT Next.js) listening at ${BASE}\n`);

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
const newContext = async (opts = {}) => { const ctx = await browser.newContext({ acceptDownloads: true, ...opts }); ctx.on("page", (p) => { p.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) consoleErrors.push(`${p.url()} :: ${m.text()}`); }); p.on("response", (r) => { if (r.status() >= 400) failedResponses.push([r.status(), r.url()]); }); p.on("pageerror", (e) => consoleErrors.push(`${p.url()} :: pageerror ${e.message}`)); }); return ctx; };
const PASSWORD = "correct horse battery";

async function signUp(ctx, email) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/register`);
  await page.fill("input[name=name]", "Test User"); await page.fill("input[name=email]", email); await page.fill("input[name=password]", PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click(); await page.waitForURL(/\/login\?notice=registered/);
  await page.goto(`${BASE}/dev/outbox`);
  const text = await page.locator("pre").first().innerText(); const token = /token=([A-Za-z0-9_-]+)/.exec(text)[1];
  await page.goto(`${BASE}/verify-email?token=${token}`);
  await page.getByRole("button", { name: "Confirm my email" }).click(); await page.waitForURL(/\/login\?notice=verified/);
  await page.fill("input[name=email]", email); await page.fill("input[name=password]", PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click(); await page.waitForURL(`${BASE}/dashboard`);
  return page;
}

const ctxA = await newContext(); let pageA; let mp4Id; let pngId; let webmId; let expectCsrfRefusals = false;

await check("anonymous visitor: data pages ask to sign in; login/register forms are enabled in local mode", async () => {
  const p = await (await newContext()).newPage();
  for (const path of ["/dashboard", "/media", "/collections", "/cycles", "/editor"]) { await p.goto(BASE + path); assert((await p.locator("main").innerText()).includes("Sign in required"), `${path} did not ask to sign in`); }
  await p.goto(`${BASE}/login`); assert(await p.getByRole("button", { name: "Sign in" }).isEnabled(), "sign-in button disabled");
  assert((await p.locator("main").innerText()).includes("disappear when the server restarts"), "local mode not labelled");
});

await check("register -> email link opens a confirm page (does not auto-confirm) -> confirm -> sign in -> dashboard", async () => {
  pageA = await signUp(ctxA, "ann@example.com");
  assert((await pageA.locator("main").innerText()).includes("Your plan:"), "dashboard missing plan");
  const text = await pageA.locator("main").innerText();
  assert(text.includes("Free"), "new users should be on the Free plan"); assert(text.includes("Usage resets on"), "reset date missing");
});

await check("session cookie in a real browser: HttpOnly, SameSite=Lax, not readable from JavaScript, not Secure on plain http", async () => {
  const c = (await ctxA.cookies()).find((x) => x.name === "clipforge_session");
  assert(c, "cookie missing"); assert(c.httpOnly === true, "not HttpOnly"); assert(c.sameSite === "Lax", `SameSite=${c.sameSite}`); assert(c.secure === false, "unexpected Secure on http"); assert(c.value.length >= 40, "token too short");
  assert(!(await pageA.evaluate(() => document.cookie)).includes("clipforge_session"), "cookie readable from JS");
});

await check("login with a wrong password shows the generic error and sets no cookie", async () => {
  const ctx = await newContext(); const p = await ctx.newPage(); await p.goto(`${BASE}/login`);
  await p.fill("input[name=email]", "ann@example.com"); await p.fill("input[name=password]", "wrong password here"); await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/error=invalid_credentials/); assert((await p.locator("main").innerText()).includes("Email or password is not correct."), "message missing");
  assert((await ctx.cookies()).every((x) => x.name !== "clipforge_session"), "cookie set on failure");
  await p.goto(`${BASE}/login`); await p.fill("input[name=email]", "nobody@example.com"); await p.fill("input[name=password]", "wrong password here"); await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/error=invalid_credentials/);
});

await check("upload an image and a video through the real form; both are verified; thumbnails load in the browser", async () => {
  await pageA.goto(`${BASE}/media`);
  assert((await pageA.locator("main").innerText()).includes("Demo storage (server memory)"), "storage mode not labelled");
  for (const file of ["photo.png", "a.mp4", "b.webm"]) {
    await pageA.setInputFiles("input[type=file]", join(dir, file)); await pageA.getByRole("button", { name: "Upload", exact: true }).click(); await pageA.waitForURL(/\/media\?notice=/);
    const text = await pageA.locator("main").innerText(); assert(text.includes("Upload complete. The file was checked and saved."), `${file}: ${text.slice(0, 200)}`);
  }
  await pageA.waitForFunction(() => { const imgs = [...document.querySelectorAll('img[src*="variant=thumbnail"]')]; return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0); }, null, { timeout: 15000 });
  const rows = await pageA.locator("tbody tr").count(); assert(rows === 3, `expected 3 rows, got ${rows}`);
  const links = await pageA.locator("tbody a").evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
  mp4Id = links.find((l) => l[0] === "a.mp4")[1].split("/").pop(); pngId = links.find((l) => l[0] === "photo.png")[1].split("/").pop(); webmId = links.find((l) => l[0] === "b.webm")[1].split("/").pop();
  assert((await pageA.locator("tbody").innerText()).includes("Yes"), "files not shown as checked");
});

await check("WebM detail page (a codec this Chromium can play): metadata is read, it plays, and seeking uses HTTP Range (206) responses", async () => {
  const statuses = []; pageA.on("response", (r) => { if (r.url().includes("variant=preview")) statuses.push([r.status(), r.headers()["content-range"] ?? null]); });
  await pageA.goto(`${BASE}/media/${webmId}`);
  await pageA.waitForFunction(() => document.querySelector("video")?.readyState >= 1, null, { timeout: 15000 });
  const dur = await pageA.evaluate(() => document.querySelector("video").duration); assert(dur > 1.5 && dur < 2.5, `duration ${dur}`);
  await pageA.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; v.currentTime = 1.2; await new Promise((r) => v.addEventListener("seeked", r, { once: true })); await v.play(); await new Promise((r) => setTimeout(r, 400)); });
  const t = await pageA.evaluate(() => document.querySelector("video").currentTime); assert(t > 1.2, `did not play (currentTime ${t})`);
  assert(statuses.some(([s, cr]) => s === 206 && cr?.startsWith("bytes ")), `no 206 range response seen: ${JSON.stringify(statuses)}`);
  const text = await pageA.locator("main").innerText(); for (const part of ["video/webm", "320 × 240", "0:02", "decoded"]) assert(text.includes(part), `detail missing "${part}"`);
});

await check("MP4 detail page: metadata is correct and the Range protocol works (playback itself is NOT testable: this Chromium has no H.264)", async () => {
  await pageA.goto(`${BASE}/media/${mp4Id}`);
  const text = await pageA.locator("main").innerText(); for (const part of ["video/mp4", "320 × 240", "0:02", "decoded", "Download the original"]) assert(text.includes(part), `detail missing "${part}"`);
  notes.push("MP4 in-browser playback not tested: Chromium build has no H.264 decoder (canPlayType returned an empty string).");
  const r = await pageA.evaluate(async (id) => { const res = await fetch(`/api/media/file?id=${id}&variant=preview`, { headers: { Range: "bytes=0-9" } }); return [res.status, res.headers.get("content-range"), res.headers.get("content-type"), (await res.arrayBuffer()).byteLength, res.headers.get("x-content-type-options"), res.headers.get("cache-control")]; }, mp4Id);
  assert(r[0] === 206 && r[1] === `bytes 0-9/${MP4.length}` && r[2] === "video/mp4" && r[3] === 10, `range response ${JSON.stringify(r)}`); assert(r[4] === "nosniff" && r[5] === "private, no-store", "security headers missing");
});

await check("image detail page shows the picture; download gives the EXACT original bytes with the right file name", async () => {
  await pageA.goto(`${BASE}/media/${pngId}`);
  await pageA.waitForFunction(() => { const i = document.querySelector('img[alt^="Preview of"]'); return i && i.complete && i.naturalWidth === 128; }, null, { timeout: 10000 });
  const [dl] = await Promise.all([pageA.waitForEvent("download"), pageA.click("a[download]")]);
  assert(dl.suggestedFilename() === "photo.png", `filename ${dl.suggestedFilename()}`); assert(sha(readFileSync(await dl.path())) === sha(PNG), "downloaded bytes differ from the uploaded original");
  await pageA.goto(`${BASE}/media/${mp4Id}`); const [dl2] = await Promise.all([pageA.waitForEvent("download"), pageA.click("a[download]")]);
  assert(sha(readFileSync(await dl2.path())) === sha(MP4), "video download differs from the original");
  await pageA.goto(`${BASE}/media/${webmId}`); const [dl3] = await Promise.all([pageA.waitForEvent("download"), pageA.click("a[download]")]);
  assert(sha(readFileSync(await dl3.path())) === sha(WEBM), "webm download differs from the original");
});

await check("another user cannot see, fetch, preview or download my files (indistinguishable from 'not found'); anonymous gets 401", async () => {
  const ctxB = await newContext(); const pageB = await signUp(ctxB, "bob@example.com");
  await pageB.goto(`${BASE}/media`); assert((await pageB.locator("main").innerText()).includes("Your library is empty"), "Bob sees Ann's files");
  for (const variant of ["thumbnail", "preview", "download"]) { const r = await ctxB.request.get(`${BASE}/api/media/file?id=${mp4Id}&variant=${variant}`); assert(r.status() === 404, `${variant} -> ${r.status()}`); }
  const missing = await ctxB.request.get(`${BASE}/api/media/file?id=doesnotexist&variant=preview`); const hidden = await ctxB.request.get(`${BASE}/api/media/file?id=${mp4Id}&variant=preview`);
  assert((await missing.text()) === (await hidden.text()), "denied differs from missing");
  await pageB.goto(`${BASE}/media/${mp4Id}`); assert((await pageB.locator("main").innerText()).includes("Not found"), "detail page leaked");
  await pageB.goto(`${BASE}/editor?media=${mp4Id}`); assert((await pageB.locator("main").innerText()).includes("Not found"), "editor leaked");
  const anon = await request.newContext(); assert((await anon.get(`${BASE}/api/media/file?id=${mp4Id}&variant=thumbnail`)).status() === 401, "anonymous not 401"); await anon.dispose();
});

await check("editor: sketch updates from the controls; border, colour, aspect and logo appear; template saves; original is unchanged", async () => {
  await pageA.goto(`${BASE}/editor`); await pageA.getByRole("link", { name: "a.mp4" }).click(); await pageA.waitForURL(/\/editor\?media=/);
  const viewBox = () => pageA.getAttribute("#editor-preview", "viewBox");
  assert((await viewBox()) === "0 0 720 1280", `default viewBox ${await viewBox()}`);
  await pageA.selectOption("select[name=aspect]", "1:1");
  await pageA.evaluate(() => { const set = (n, v) => { const e = document.querySelector(`[name=${n}]`); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); }; set("zoom", "1.5"); });
  await pageA.fill("input[name=borderPx]", "10"); await pageA.check("input[name=bg][value=solid]");
  await pageA.evaluate(() => { for (const [n, v] of [["bgColor", "#ff00ff"], ["borderColor", "#00ff00"]]) { const e = document.querySelector(`[name=${n}]`); e.value = v; } });
  await pageA.selectOption("select[name=logoMedia]", { label: "photo.png" });
  await pageA.getByRole("button", { name: "Update preview" }).click(); await pageA.waitForURL(/aspect=1%3A1/);
  assert((await viewBox()) === "0 0 720 720", `1:1 viewBox ${await viewBox()}`);
  assert((await pageA.locator("[data-border]").count()) === 1, "border not drawn"); assert((await pageA.locator("[data-logo-handle]").count()) === 1, "logo not drawn");
  assert((await pageA.getAttribute("[data-background]", "fill")) === "#ff00ff", "background colour not applied");
  assert((await pageA.inputValue("input[name=zoom]")) === "1.5", "zoom not kept after update"); assert((await pageA.inputValue("input[name=borderPx]")) === "10", "border not kept");
  assert((await pageA.locator("main").innerText()).includes("not a rendered video"), "sketch not labelled");
  assert(await pageA.getByRole("button", { name: /Render video/ }).isDisabled(), "render button should be disabled");
  await pageA.fill("input[name=name]", "My look"); await pageA.getByRole("button", { name: "Save as template" }).click(); await pageA.waitForURL(/notice=template_saved/);
  const text = await pageA.locator("main").innerText(); assert(text.includes("Template saved. Your original video was not changed."), "flash missing"); assert(text.includes("Your templates (1 of 3)") && text.includes("My look"), "template not listed");
  const r = await ctxA.request.get(`${BASE}/api/media/file?id=${mp4Id}&variant=download`); assert(sha(await r.body()) === sha(MP4), "original changed after saving a template");
});

await check("bad editor input is explained, never rendered as markup", async () => {
  await pageA.goto(`${BASE}/editor?media=${mp4Id}&zoom=abc&bg=solid&bgColor=${encodeURIComponent('#f00"><script>window.__xss=1</script>')}`);
  const text = await pageA.locator("main").innerText(); assert(text.includes("Zoom must be a number."), "problem not shown");
  assert((await pageA.evaluate(() => window.__xss)) === undefined, "injected script ran");
});

await check("collections, cycles, pricing and home pages load without errors in local mode", async () => {
  for (const [path, expect] of [["/collections", "Your collections"], ["/cycles", "Publishing cycles"], ["/pricing", "₹3,999"], ["/", "Prepare, organise"]]) { await pageA.goto(BASE + path); assert((await pageA.locator("main").innerText()).includes(expect), `${path} missing "${expect}"`); }
  await pageA.goto(`${BASE}/cycles`); assert((await pageA.locator("main").innerText()).includes("You need a connected account first"), "cycle creation should explain the missing account");
});

await check("a file that is not really media is refused with a clear message and nothing is stored; the dashboard storage meter reflects the real uploads", async () => {
  await pageA.goto(`${BASE}/media`); const before = await pageA.locator("tbody tr").count();
  await pageA.setInputFiles("input[type=file]", join(dir, "fake.mp4")); await pageA.getByRole("button", { name: "Upload", exact: true }).click(); await pageA.waitForURL(/error=unsupported_media_type/);
  assert((await pageA.locator("main").innerText()).includes("not a supported video or image"), "error message missing");
  assert((await pageA.locator("tbody tr").count()) === before, "a rejected file was stored");
  await pageA.goto(`${BASE}/dashboard`); const text = await pageA.locator("main").innerText();
  const m = /Storage\s*\n?\s*(\d+(?:\.\d+)? \w+) of 5 GB used/.exec(text); assert(m, `storage meter not found in: ${text.slice(0, 300)}`);
  assert(!m[1].startsWith("0 "), `storage meter shows nothing used: ${m[1]}`);
  assert(text.includes("3 media files"), "media count wrong");
});

await check("CSRF in a real browser: a form on ANOTHER origin cannot log the user out, create things, or upload", async () => {
  const evil = createServer((req, res) => { const target = new URL(req.url, "http://x").searchParams.get("t"); res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<form id=f method=post action="${BASE}${target}"><input name=name value=x><input name=socialAccountId value=y></form><script>document.getElementById('f').submit()</script>`); });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r)); const evilPort = evil.address().port;
  expectCsrfRefusals = true;
  try {
    for (const target of ["/api/auth/logout", "/api/forms/cycle-create", "/api/auth/login"]) {
      const p = await ctxA.newPage(); await p.goto(`http://localhost:${evilPort}/?t=${target}`); await p.waitForURL(`${BASE}${target}`, { timeout: 10000 });
      assert((await p.locator("body").innerText()).includes("Cross-site requests are not allowed."), `${target} was not refused`); await p.close();
    }
  } finally { evil.close(); expectCsrfRefusals = false; }
  await pageA.goto(`${BASE}/dashboard`); assert((await pageA.locator("main").innerText()).includes("Your plan:"), "the attack logged the user out");
});

await check("mobile layout (375px wide): no horizontal scrolling on main screens; skip link and landmarks present", async () => {
  const ctx = await newContext({ viewport: { width: 375, height: 800 } });
  const p = await signUp(ctx, "mobile@example.com"); await p.setInputFiles("input[type=file]", join(dir, "a.mp4")).catch(() => {});
  await p.goto(`${BASE}/media`); await p.setInputFiles("input[type=file]", join(dir, "a.mp4")); await p.getByRole("button", { name: "Upload", exact: true }).click(); await p.waitForURL(/notice=/);
  const id = (await p.locator("tbody a").first().getAttribute("href")).split("/").pop();
  for (const path of ["/login", "/register", "/pricing", "/dashboard", "/media", `/media/${id}`, "/collections", "/cycles", `/editor?media=${id}`]) {
    await p.goto(BASE + path); const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); assert(overflow <= 1, `${path} overflows by ${overflow}px`);
  }
  assert((await p.locator("a[href='#main']").count()) === 1 && (await p.locator("main#main").count()) === 1, "skip link / main landmark missing");
});

await check("logout: the cookie is cleared, pages ask to sign in again, and the OLD cookie no longer works", async () => {
  const oldCookie = (await ctxA.cookies()).find((c) => c.name === "clipforge_session").value;
  await pageA.goto(`${BASE}/dashboard`); await pageA.getByRole("button", { name: "Sign out" }).click(); await pageA.waitForURL(/\/login\?notice=logged_out/);
  assert((await pageA.locator("main").innerText()).includes("You are signed out."), "message missing");
  assert((await ctxA.cookies()).every((c) => c.name !== "clipforge_session"), "cookie still present");
  await pageA.goto(`${BASE}/dashboard`); assert((await pageA.locator("main").innerText()).includes("Sign in required"), "still signed in");
  const replay = await request.newContext({ extraHTTPHeaders: { cookie: `clipforge_session=${oldCookie}` } });
  assert((await replay.get(`${BASE}/api/media/file?id=${mp4Id}&variant=download`)).status() === 401, "old session cookie still works"); await replay.dispose();
});

await check("no JavaScript errors, and no failed HTTP requests except the expected ones (deliberate CSRF refusals; favicon lookups on plain-text pages)", async () => {
  const CSRF_TARGETS = ["/api/auth/logout", "/api/forms/cycle-create", "/api/auth/login"];
  const unexpected = failedResponses.filter(([status, url]) => !(url.endsWith("/favicon.ico") && status === 404) && !(status === 403 && CSRF_TARGETS.some((t) => url.endsWith(t))));
  assert(consoleErrors.length === 0, `${consoleErrors.length} JS error(s):\n${consoleErrors.slice(0, 5).join("\n")}`);
  assert(unexpected.length === 0, `unexpected failed requests: ${JSON.stringify(unexpected.slice(0, 5))}`);
  assert(failedResponses.filter(([s]) => s === 403).length === 3, `expected exactly 3 CSRF refusals, saw ${failedResponses.filter(([s]) => s === 403).length}`);
});
await check("the harness itself logged no server errors", async () => { assert(!/HARNESS ERROR/.test(harnessErrors), harnessErrors.slice(0, 400)); });

await browser.close(); harness.kill(); rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r[0]);
for (const n of notes) console.log(`NOTE  ${n}`);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed (against the harness, NOT Next.js)`);
process.exit(failed.length === 0 ? 0 : 1);
