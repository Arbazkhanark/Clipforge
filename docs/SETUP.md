# Setup

Requires Node >= 22.18.

    npm install      # first time (needs network); then pin the "latest" versions in package.json
    npm test         # all tests (pure rules, FFmpeg rendering, UI rendering)
    npm run typecheck
    npm run dev      # Next.js dev server (never run yet - see docs/PLAN.md)

Rendering tests need `ffmpeg` and `ffprobe` on the PATH (they are skipped if ffmpeg is missing).
Copy `.env.example` to `.env` and fill real values later. Never commit `.env`.

Sandbox note: in the development sandbox React, react-dom, tsx were symlinked into `node_modules` from a global install because
there was no network. `node_modules` is git-ignored; a normal `npm install` replaces this.
