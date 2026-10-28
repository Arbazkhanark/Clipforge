# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
**Exists and is tested here:** pure business rules; a server-side request layer (validation, ownership, plan limits, optimistic
concurrency) tested against an in-memory repository; a draft Prisma 7 schema; the FFmpeg rendering pipeline (really run); React
components and a small Next.js route skeleton (server-rendered in tests); Razorpay and Instagram **rules** checked against official docs
(see `docs/VERIFICATION.md`).
**Does NOT exist / never run:** Next.js itself, Prisma CLI/client, a running PostgreSQL, S3, sign-in, uploads, job queue/worker,
any real Razorpay or Instagram call, any deployment. **The app has never been started with `next dev` or built with `next build`,
and the Prisma schema has never been validated or migrated.** Everything below that needs the network is blocked, not done.

## Stages
| Stage | What | Status |
|---|---|---|
| Server request layer | validation, auth check, ownership, plan limits, concurrency | ✅ tested vs in-memory repository (`src/server/`): captions, covers, grants, revoke, create cycle, mix, unmix, start. **Not yet connected to Prisma, HTTP routes, or a session** |
| Authentication | Google + email/password, verification, reset, sessions | ⬜ blocked: packages + DB + email provider |
| Dashboard | real data | ⬜ placeholder empty state |
| Media library & collections | DB, S3, UI | 🟡 rules + schema + repository interface |
| Video upload | presigned/multipart S3 | ⬜ blocked |
| Editor & background rendering | FFmpeg pipeline | 🟡 pipeline really tested; no editor UI, no queue/worker |
| Sharing | rules, handlers | 🟡 grant/revoke handlers tested (plan caps, delegates, expiry); no pages/DB; access-request and import/deletion handlers not yet written |
| Publishing cycles & scheduling | rules, handlers | 🟡 start/mix/unmix handlers tested; no scheduler process, no pause/resume/stop handlers yet |
| Billing | catalog, signatures, webhook interpretation, trial rules | 🟡 logic verified against docs; no checkout/webhook HTTP endpoints, no Razorpay calls |
| Instagram integration | official API | 🟡 documented facts + quota + container rules coded; OAuth/publishing **not implemented** |

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
