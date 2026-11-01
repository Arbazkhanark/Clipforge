# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
**Exists and is tested here:** business rules; server request layer; safe read queries; JSON + HTML-form routes with CSRF checks;
upload workflow (private storage, real file-signature checks, ffprobe, quota, thumbnails); **owner-authorized media preview/download
(access re-checked on every request)**; **real authentication logic** (scrypt hashing, hashed session/email/reset tokens, secure cookies,
rate limiting, enumeration-safe flows) wired into a **local mode**; **PrismaRepository + PrismaAuthRepository** (logic tested through shared
contract suites over a FAKE Prisma client); **editor UI** (aspect ratio, background, zoom, position, border, logo) that saves settings as
templates separate from media, with layout geometry proven against real FFmpeg output; Next.js App Router screens rendered to HTML in tests.
**Does NOT exist / never run:** Next.js itself (no `next build`, no browser, no hydration), the Prisma CLI/client and any real
PostgreSQL (so the Prisma repositories have NEVER run against a database and `prisma validate`/migrations have never run), S3 (no AWS
resources exist), email delivery, Google sign-in, job queue/worker, video rendering from the editor, any real Razorpay or Instagram call.
**Not runnable-verified, not deployed, not production-ready.**

## Modes
| Mode | How | Auth | Data | Uploads |
|---|---|---|---|---|
| unconfigured (default) | nothing set | none: sign-in forms disabled, APIs answer 401/503 | none | unavailable |
| demo | `CLIPFORGE_DEMO_MODE=true` | fixed sample user, banner | sample data, memory | memory (or local disk) |
| local | `CLIPFORGE_LOCAL_AUTH=true` (refused when `NODE_ENV=production`) | REAL register/confirm/login/logout/reset; memory only | empty, memory | memory (or local disk) |
| database | **not built**: needs Prisma + PostgreSQL | | | |
In local mode the confirmation/reset "emails" are only visible on `/dev/outbox` (no email provider exists).

## Stages
| Stage | What | Status |
|---|---|---|
| Persistence | PrismaRepository, PrismaAuthRepository, mappers, contract suites | 🟡 written + logic-tested over a fake client; **never run on real Prisma/PostgreSQL**; no DB runtime mode, no `src/server/db.ts` wiring beyond an unverified `create-client.ts` |
| Authentication | password hashing, sessions, verification, reset, routes, pages | 🟡 logic and routes verified in local (memory) mode; pages read the cookie via `next/headers` (**unverified under Next.js**); Google sign-in and real email NOT built; rate limiting is per email, in memory |
| Media preview/download | `/api/media/file` (thumbnail, preview, download), ranges, headers | ✅ tested; originals only for the owner or someone given `download`; thumbnails for anyone who can see the item |
| Thumbnails & metadata | ffmpeg JPEG at upload, detail page | ✅ tested with real ffmpeg; not counted toward storage quota |
| Editor | settings, validation, sketch preview, templates (plan limit), save form | 🟡 UI + persistence tested; **no rendering from the editor**; logo drag is an unverified client enhancement (sliders work without JavaScript); templates cannot yet be applied to cycle items |
| Upload / forms / sharing / cycles | see earlier | ✅/🟡 as before (read-only sharing screens; no grants UI) |
| Remaining handlers (access requests, import, owner deletion, pause/resume/stop) | | ⬜ postponed |
| Worker/queue, S3 adapter, Razorpay checkout/webhook endpoints, Instagram OAuth/publishing | | ⬜ not started |

## Fixed prices (INR, stored as integer paise)
| Plan | Weekly | Monthly |
|---|---:|---:|
| Free | ₹0 | ₹0 |
| Creator | ₹499 | ₹1,999 |
| Pro | ₹999 | ₹3,999 |
| Agency | ₹1,499 | ₹5,999 |

## Requirements carried into later phases (from the master brief)
- **Captions:** individual, shared, all-upcoming, selected-upcoming; confirm before overwriting custom captions;
  revision history; partial-failure reporting; published items never modified; version check/lock vs. publishing worker.
- **Covers:** upload / library / video frame; bulk apply; "saved internally" ≠ "applied on Instagram"; capability checks.
- **Collections:** per client/brand; archive; delete with dependency checks; select many collections in a cycle; duplicate prevention.
- **Sharing:** Private / Link / Public-view (view ≠ use ≠ download); hashed unguessable tokens; revoke; access requests;
  permission levels; permissions rechecked on add, process, and publish.
- **Direct use:** shared videos referenced (no duplicate S3 object); recipient settings stored separately; source immutable.
- **Import:** separate "Import to My Library" action with mandatory warning; idempotent job; verify object before success.
- **Owner deletion:** dependency warning, notify recipients, grace period only if really implemented, tombstone + verified cleanup.
- **Mix/Unmix:** per-item source tracking; unmix releases only that cycle's reference; published history kept.
- **Cost/perf:** PostgreSQL = durable truth, Redis only for queues/cache; no FFmpeg in API requests; lifecycle rules; indexes.
- **Workflow:** one Git repo; **no ZIP until the user says “Create the final ZIP bundle now.”**

## Decisions and assumptions
**Decided by you**
1. Creator and above: basic sharing, direct use of shared videos, Mix/Unmix. Pro/Agency: advanced sharing = expiring grants, delegated managers (with limits), configurable recipient caps. Prices unchanged.
2. Failed renders charge nothing. A render counts only if it finished AND its output passed validation.
3. Usage resets on the 1st of each calendar month (UTC), independent of billing renewal; the UI shows the reset date/time in the user's zone.
4. Owner-deletion grace period: default 7 days, maximum 30. Immediate removal for valid privacy/legal requests needs a written justification (audit log). Source files are never deleted while jobs/valid references need them.

**Approved by you (2026-10-28):** recipient caps per collection - Free 0, Creator 5, Pro 25, Agency 100; delegated-manager grants last at most 90 days.

**Other developer placeholders - please confirm or change**
- Delegate limits (`sharing-management.ts`): may only grant permissions they hold, never `manage`; grants must expire and last at most 90 days (`DELEGATE_MAX_GRANT_DAYS`) and not outlast the delegate's own access; may revoke only grants they made; cannot change visibility.
- Plan downgrades never silently remove access: `findGrantsOutsidePolicy` reports what is outside the new plan.
- Storage "GB" = 1024^3 bytes. Agency has everything Pro has; team features not advertised.
- Failed/needs_review items cannot be bulk-edited until retried.
- Revoked permission during an import fails and cleans up the import.
- Trial: 7 days via a future `start_at` (verified). Trial users get their plan's features only after authorising payment and until the trial ends. Not connected to Razorpay yet.
- Instagram daily limit: code uses the documented 100 per rolling 24h but the docs also mention 50 in one place; it is overridable and should be replaced by the live `content_publishing_limit` value.

## Known verification gaps
- Razorpay signature formulas/event names were **not re-checked against live docs** (no network).
- Instagram API capabilities (covers, quotas) **not researched yet**.
- Caption limits in `caption-cover-updates.ts` (2,200 chars / 30 hashtags) come from memory, **unverified**.
- Instagram Reels covers: the API has `cover_url`/`thumb_offset` parameters (verified), but cover image requirements are unverified; a saved cover is never reported as applied until the publisher confirms it.
- Prisma schema was moved to the Prisma 7 layout after reading the official migration guide, but never validated by the CLI.
- No schedule-slot calculator yet (interval/time-window/timezone/daily-max); Instagram posting quotas not researched.
- React UI was only server-rendered to HTML in tests; no browser, accessibility audit, responsive check or Next.js run has happened.
- `package.json` uses `latest` for dependencies because versions could not be looked up offline. Pin them after the first real `npm install`.
- Tailwind CSS and shadcn/ui are NOT set up (plain CSS in `app/globals.css`); their setup is version-specific.
- FFmpeg tests ran with this sandbox's FFmpeg 6.1; behaviour on the production worker image is unverified. Solid-background renders are output at 30 fps (the colour source rate).
- Pages return HTTP 200 with a "Not found" message for missing/forbidden objects (proper 404 status needs `next/navigation`, to be added once Next.js is installed).
- `searchParams`/`params` are awaited so pages work on both older (plain object) and newer (Promise) Next.js, but no Next.js version has been tried.
- Navigation uses plain links (full page loads); `next/link` and client-side form handling come after Next.js is installed.
- Time zone for display is fixed to Asia/Kolkata until a user setting exists.
- Uploaded videos are not re-encoded or scanned for malware; ffprobe only confirms the file decodes as media. Instagram's own video requirements remain unverified.
- Form flows use full-page redirects (POST -> 303). No double-submit protection yet (a refresh after a redirect is safe; resubmitting a form twice creates two actions).
- Upload size is checked from the declared Content-Length before reading, and again on the bytes; a client that lies about length is still bounded by the multipart parser's buffering in Node (dev only).
- Password hashing: scrypt N=2^17, r=8, p=1 is from memory of OWASP guidance (unverified); Argon2id is generally preferred but needs a package.
- Rate limiting ignores IP addresses (X-Forwarded-For is spoofable without a trusted proxy) and resets on restart; a real deployment needs a shared store.
- New accounts must confirm their email before signing in; resend/forgot flows never reveal whether an email exists.
- Thumbnails are not counted toward the storage quota; originals are.
- Nothing has been verified under a real browser: forms, the editor, video playback, and the logo-drag enhancement are untested in one.
