# ClipForge — Project Plan (synced with actual state)

Legend: ✅ done & tested · 🟡 partial · ⬜ not started

## Current honest status
**Exists:** pure, tested business rules + a database schema draft. **Does NOT exist:** web app, running database,
S3, auth, UI, workers, any external integration. Nothing here has been run against PostgreSQL, S3, Razorpay or Instagram.

The first session's workspace (29 tests) was not available, so Phase 0 was rebuilt. Current test count: see `npm test`.

## Phases
| # | Phase | Status |
|---|-------|--------|
| 0 | Billing core: catalog, entitlements, Razorpay signatures, subscription state machine | ✅ offline logic, tested (Razorpay formulas unverified vs live docs) |
| 1 | Next.js foundation, design system, themes | ⬜ needs network (npm install) |
| 2 | Prisma schema, migrations, auth, authorization | 🟡 `prisma/schema.prisma` drafted + text-sanity-tested; NOT validated by Prisma, no migration run, no auth |
| 3 | Media library, private S3, storage accounting | ⬜ |
| 4 | Collections | 🟡 ownership/permission rules done (`sharing-permissions.ts`); no DB/UI |
| 5 | Sharing, direct use, import, owner-deletion workflow | 🟡 rules done (`sharing-permissions.ts`, `media-lifecycle.ts`); no jobs, S3 or notifications delivery |
| 6 | Editor, templates, FFmpeg rendering | ⬜ (FFmpeg 6.1 present in this sandbox) |
| 7 | Captions and covers | 🟡 bulk/single update rules done (`caption-cover-updates.ts`); no UI/DB; Instagram cover support UNKNOWN |
| 8 | Publishing cycles, Mix/Unmix | 🟡 state machine, locking, mix/unmix rules done (`cycle-state.ts`, `mix-unmix.ts`); no scheduler/worker, no schedule-slot calculator yet |
| 9 | Instagram official API | ⬜ docs not researched |
| 10 | Razorpay subscriptions, webhooks, trial, usage accounting | 🟡 signature + state logic only |
| 11 | Smart Publishing Assistant, admin, notifications, audit | 🟡 preflight rules done (`preflight.ts`); rest ⬜ |
| 12 | Performance, cost control, deployment | ⬜ |

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
**Decided by you:** Creator and above get basic sharing, direct use of shared videos in cycles, and Mix/Unmix. Pro/Agency add
*advanced* sharing management and higher limits. Free has no sharing. Prices unchanged.

**Still assumptions (change if wrong):**
1. Storage "GB" = 1024³ bytes.
2. Agency gets everything Pro has; "team features" are not advertised.
3. "Advanced sharing management" is only a flag (`collectionSharing: "advanced"`); what it unlocks (e.g. expiring grants, delegated `manage`, number of recipients) is **not defined yet** - please decide.
4. Grace period for owner deletion is chosen by the owner per deletion (whole days >= 1); no platform default or maximum yet.
5. If a recipient's permission is revoked while an import is copying, the import fails and cleans up (conservative).
6. Items that are `failed` cannot be bulk-edited until retried; `needs_review` likewise.
7. Trial (7 days) not implemented until Razorpay's subscription trial behavior is verified.

## Known verification gaps
- Razorpay signature formulas/event names were **not re-checked against live docs** (no network).
- Instagram API capabilities (covers, quotas) **not researched yet**.
- Caption limits in `caption-cover-updates.ts` (2,200 chars / 30 hashtags) come from memory, **unverified**.
- Whether Instagram accepts custom covers via the API is **unknown**; code treats it as `supported | unsupported | unknown` and never claims a cover was applied.
- Prisma schema never validated by the Prisma CLI; Prisma version-specific config (datasource url) unchecked.
- No schedule-slot calculator yet (interval/time-window/timezone/daily-max); Instagram posting quotas not researched.
