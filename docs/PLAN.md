# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
**Exists and is tested here:** pure business rules, a draft database schema, the FFmpeg rendering pipeline (really run), React UI
components and a small Next.js route skeleton (server-rendered in tests).
**Does NOT exist / never run:** Next.js itself (not installed - no network), a running PostgreSQL, S3, sign-in, uploads,
workers/queues, Razorpay or Instagram calls, any deployment. **The app has never been started with `next dev` or built with `next build`.**

## Stages
| Stage | What | Status |
|---|---|---|
| Billing core | catalog, entitlements, Razorpay signatures, subscription state machine | ✅ logic tested (Razorpay formulas unverified vs live docs) |
| Authentication | Google + email/password, verification, reset, sessions | ⬜ blocked: needs packages + DB + email provider |
| Dashboard | real data | ⬜ `/dashboard` is an honest empty-state placeholder |
| Media library & collections | DB, S3, UI | 🟡 permission rules + schema draft only |
| Video upload | presigned/multipart S3 | ⬜ blocked: no S3, no network |
| Editor & background rendering | FFmpeg pipeline | 🟡 command builder, runner, validation, progress parsing **really tested with FFmpeg** (aspect ratios, solid/blur background, zoom/position, main-video border, logo, plan resolution cap). No editor UI (drag/resize), no job queue/worker process, no S3 I/O |
| Sharing | rules + UI | 🟡 rules (permissions, links, requests, advanced management, import, deletion) tested; `ImportWarning` component; no pages/DB |
| Publishing cycles | state machine, preflight, Mix/Unmix | 🟡 rules + `CycleItemsTable`, `PreflightPanel` components; no pages/DB/worker |
| Scheduling | slot calculator, ordering | ✅ pure logic tested (time zones/DST, windows, daily max, end date, seeded shuffle); `SchedulePreview` component; no scheduler process |
| Billing UI & Razorpay | | 🟡 `/pricing` page reads the catalog (no buy button until billing is real); no checkout/webhook endpoint |
| Instagram integration | official API | ⬜ docs not researched (no network) |

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

**Developer placeholders - please confirm or change (all in one place each)**
- Recipient caps per collection (owner's plan): Free 0, Creator 5, Pro 25, Agency 100 (`catalog.ts` -> `sharing`).
- Delegate limits (`sharing-management.ts`): may only grant permissions they hold, never `manage`; grants must expire and last at most 90 days (`DELEGATE_MAX_GRANT_DAYS`) and not outlast the delegate's own access; may revoke only grants they made; cannot change visibility.
- Plan downgrades never silently remove access: `findGrantsOutsidePolicy` reports what is outside the new plan.
- Storage "GB" = 1024^3 bytes. Agency has everything Pro has; team features not advertised.
- Failed/needs_review items cannot be bulk-edited until retried.
- Revoked permission during an import fails and cleans up the import.
- Trial (7 days) not implemented until Razorpay trial behavior is verified.

## Known verification gaps
- Razorpay signature formulas/event names were **not re-checked against live docs** (no network).
- Instagram API capabilities (covers, quotas) **not researched yet**.
- Caption limits in `caption-cover-updates.ts` (2,200 chars / 30 hashtags) come from memory, **unverified**.
- Whether Instagram accepts custom covers via the API is **unknown**; code treats it as `supported | unsupported | unknown` and never claims a cover was applied.
- Prisma schema never validated by the Prisma CLI; Prisma version-specific config (datasource url) unchecked.
- No schedule-slot calculator yet (interval/time-window/timezone/daily-max); Instagram posting quotas not researched.
- React UI was only server-rendered to HTML in tests; no browser, accessibility audit, responsive check or Next.js run has happened.
- `package.json` uses `latest` for dependencies because versions could not be looked up offline. Pin them after the first real `npm install`.
- Tailwind CSS and shadcn/ui are NOT set up (plain CSS in `app/globals.css`); their setup is version-specific.
- FFmpeg tests ran with this sandbox's FFmpeg 6.1; behaviour on the production worker image is unverified. Solid-background renders are output at 30 fps (the colour source rate).
