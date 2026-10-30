# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
**Exists and is tested here (all against in-memory sample data and private local/memory storage):** business rules; server request layer;
safe read queries; Web-standard JSON API routes; **plain HTML form routes** (no client JavaScript) that run the same tested handlers and
redirect with whitelisted flash messages; **a real upload workflow** (private local-disk or memory storage, file-signature sniffing, ffprobe
validation, plan storage quota, safe names, cleanup of failed uploads); Next.js App Router screens (dashboard, media library with upload,
collections with add-to-cycle form, publishing cycles with create/edit/start forms, login/register, pricing) rendered to HTML in tests;
FFmpeg rendering pipeline (really run); Razorpay/Instagram/Prisma-7 rules checked against official docs.
**Does NOT exist / never run:** Next.js itself (so no `next build`, no browser, no hydration), Prisma CLI/client, PostgreSQL, S3 (no AWS
resources exist), real sign-in, persistent records, job queue/worker, any real Razorpay or Instagram call, any deployment.
**Not runnable-verified, not deployed, not production-ready.**

## Modes and storage (kept visibly separate in the UI)
- default ("unconfigured"): nobody is signed in; data pages say "Sign in required"; APIs answer 401/503; **uploads unavailable**.
- `CLIPFORGE_DEMO_MODE=true`: sample data in memory; uploads go to **server memory** ("Demo storage", discarded on restart).
- demo + `CLIPFORGE_LOCAL_MEDIA_DIR=<folder>`: uploaded **files** are saved on disk in a private folder (mode 0700/0600, refused inside
  public/.next/app); the **list of files is still in memory** and is lost on restart until the database exists. Development only.
- S3: not connected; the UI says so. Nothing in the repo calls AWS.

## Stages
| Stage | What | Status |
|---|---|---|
| Storage + upload | `MediaStorage` interface, memory + local-disk adapters, upload handler, upload route/form | ✅ tested (incl. real ffprobe/ffmpeg files). **Limits:** whole file buffered in memory (200 MB default cap, `CLIPFORGE_MAX_UPLOAD_MB`); no download/preview route; records not persisted |
| Media validation | signature sniff + MIME agreement + ffprobe | ✅ when ffprobe exists; otherwise accepted by signature only and **marked "incomplete"** (never "verified") |
| Forms wired to API | upload, create cycle, start, bulk caption, bulk cover, remove (unmix), add videos (mix) | ✅ routes + rendered forms tested together (incl. an end-to-end read-form-fields-then-post test). **Not browser-tested** |
| Sharing UI | grants/revoke | ⬜ routes exist; no screen (no way to look up another user until accounts exist) |
| Remaining handlers (access requests, import, owner deletion, pause/resume/stop) | | ⬜ postponed |
| Login / register | | 🟡 forms with submit disabled (no authentication) |
| Auth, DB persistence, Prisma repository, S3 adapter, worker, editor UI, scheduling UI, checkout, Instagram | | ⬜ blocked/not started |

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
