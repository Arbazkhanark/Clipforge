# Setup

Requires Node.js 22, at least 22.12 and below 23. Prisma 7.10 rejects Node 23. This repo was checked on Node 22.23.4.

    npm ci           # install the exact versions in package-lock.json
    DATABASE_URL="postgresql://127.0.0.1:5432/clipforge" npx prisma generate
    npm test         # all tests (rules, server layer, FFmpeg rendering, UI/page rendering, API routes)
    npm run typecheck
    npm run build    # production build; verified on 2026-11-06
    npm run dev      # Next.js dev server (not exercised in that verification)

Local demo (once Next.js is installed): set `CLIPFORGE_DEMO_MODE=true` in `.env` to browse built-in SAMPLE data. Without it the
app shows "sign in required" (there is no real authentication yet).

Uploads in demo mode: files go to server memory by default. To keep the FILES on disk set `CLIPFORGE_LOCAL_MEDIA_DIR=.local-media` (a private folder, gitignored; the file LIST is still memory-only). `CLIPFORGE_MAX_UPLOAD_MB` changes the per-upload cap (default 200).

Local accounts (real sign-up/sign-in, memory only): set `CLIPFORGE_LOCAL_AUTH=true` (and optionally `CLIPFORGE_BASE_URL`). Confirmation and reset links appear on `/dev/outbox`; no email is sent. This mode is refused when `NODE_ENV=production`.

Rendering and upload tests need `ffmpeg`/`ffprobe` on the PATH (skipped if ffmpeg is missing).
No AWS account, credentials or resources are needed or used: see docs/COST_GUARDRAILS.md.

Sandbox note: in the development sandbox React, react-dom, tsx were symlinked into `node_modules` from a global install because there
was no network. `node_modules` is git-ignored; a normal `npm install` replaces this.

Verification helpers (not part of the app): `npm run verify:harness` serves the app's real pages/routes with Next-style routing (local-auth mode) and
`npm run verify:browser` drives Chromium through it (needs ffmpeg, Playwright and a Chromium; the paths default to the development sandbox and can be set
with PLAYWRIGHT_MODULE / CHROMIUM_PATH). After `npm install` the real checks are `npm run typecheck`, `npm test`, `npm run build`.
