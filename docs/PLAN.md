# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
Only **Phase 0 (billing core)** exists. There is **no web app, database, S3, auth, or UI yet**.
The previous session's workspace (29 tests, catalog.ts, etc.) was **not available** in this session,
so Phase 0 was rebuilt from scratch (20 tests, all passing).

## Phases
| # | Phase | Status |
|---|-------|--------|
| 0 | Billing core: catalog, entitlements, Razorpay signatures, subscription state machine | ✅ (offline logic only) |
| 1 | Next.js foundation, design system, themes | ⬜ needs network (npm install) |
| 2 | Prisma schema, auth, authorization | ⬜ |
| 3 | Media library, private S3, storage accounting | ⬜ |
| 4 | Collections (multi-collection selection for cycles) | ⬜ |
| 5 | Sharing: private/link/public, access requests, direct use, import w/ warning, owner-deletion workflow | ⬜ |
| 6 | Editor, templates, FFmpeg rendering, batch | ⬜ (FFmpeg 6.1 is present here) |
| 7 | Captions (single/bulk/upcoming) and covers (single/bulk/upcoming) | ⬜ |
| 8 | Publishing cycles: Mix/Unmix, ordering, schedule, pause/resume/stop, in-flight locking | ⬜ |
| 9 | Instagram official API (OAuth, publish, covers where documented) | ⬜ docs must be re-verified |
| 10 | Razorpay subscriptions, webhooks, trial, usage accounting | ⬜ (signature + state logic done) |
| 11 | Smart Publishing Assistant, admin, notifications, audit logs | ⬜ |
| 12 | Performance, cost control, S3 lifecycle, deployment docs | ⬜ |

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

## Assumptions needing your decision (not silently decided)
1. Storage "GB" = 1024³ bytes (GiB).
2. Creator plan sharing = `basic` (share/view); direct-use-in-cycles and Mix/Unmix start at Pro (the brief only lists them under Pro).
3. Agency gets everything Pro has; "team features" are not advertised.
4. Free plan: no collection sharing.
5. Trial (7 days) not implemented until Razorpay's subscription trial behavior is verified.

## Known verification gaps
- Razorpay signature formulas/event names were **not re-checked against live docs** (no network).
- Instagram API capabilities (covers, quotas) **not researched yet**.
