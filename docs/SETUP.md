# Setup

Requires Node >= 22.18.

    npm install      # first time (needs network); then pin the "latest" versions in package.json
    npm test         # all tests (rules, server layer, FFmpeg rendering, UI/page rendering, API routes)
    npm run typecheck
    npm run dev      # Next.js dev server (never run yet - see docs/PLAN.md)

Local demo (once Next.js is installed): set `CLIPFORGE_DEMO_MODE=true` in `.env` to browse built-in SAMPLE data. Without it the
app shows "sign in required" (there is no real authentication yet).

Rendering tests need `ffmpeg`/`ffprobe` on the PATH (skipped if ffmpeg is missing).
No AWS account, credentials or resources are needed or used: see docs/COST_GUARDRAILS.md.

Sandbox note: in the development sandbox React, react-dom, tsx were symlinked into `node_modules` from a global install because there
was no network. `node_modules` is git-ignored; a normal `npm install` replaces this.
