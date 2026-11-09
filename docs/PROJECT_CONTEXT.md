# ClipForge project context

Updated 2026-11-08 from the current source tree. The latest known commit is `562c63c` on `main`, with extensive existing uncommitted changes. Do not treat a clean checkout as equivalent to this working tree.

## Product and stack

ClipForge is an early creator-video product for private media, editing/rendering, collections, and planned Instagram publishing cycles. It uses Next.js App Router 16.4.5, TypeScript 7.0.2, React 19.3.1, Prisma 7.10.1, PostgreSQL adapters, and local FFmpeg/ffprobe when available. Styling is project CSS; Tailwind and shadcn/ui are not configured.

## Runtime modes

- **Unconfigured:** default; no signed-in user, database repository calls fail closed.
- **Demo:** `CLIPFORGE_DEMO_MODE=true`; sample user/data in memory.
- **Local auth:** `CLIPFORGE_LOCAL_AUTH=true` outside production; real in-memory accounts/sessions and an in-memory email outbox. No email is sent and data disappears on restart.
- **Database:** selected when `DATABASE_URL` is set and local-auth mode is not selected. Uses Prisma repositories and requires a private local media directory for media bytes. This path has not been verified against PostgreSQL in this sprint.

For a database-free local account flow, use Node 22 and start Next.js with `CLIPFORGE_LOCAL_AUTH=true`, `DATABASE_URL`/`DIRECT_URL` unset, and no environment file loaded.

## Implemented paths

- Authentication includes registration, one-use email confirmation/reset tokens, login/logout, session cookies, rate limits, and CSRF checks.
- Media uploads use private memory/local-disk storage, file inspection, quota checks, thumbnails, and owner/collection authorization.
- The editor stores settings separately from originals. FFmpeg output is validated and stored as a separate render derivative. Local render scheduling is in-process.
- Cycles support video assignment, explicit selection of an owned render derivative, schedule preview/save, bulk captions/covers, preflight and status transitions.
- Instagram OAuth uses one-use hashed state storage (memory locally; `AuthToken` in database mode) and a server-only token access/refresh boundary. The OAuth-state enum migration is present; its database application status is unknown. No external flow has been verified.
- Publishing has durable attempt claims, a real Instagram API adapter, selected-render enforcement, signed app-hosted media access and manual review for ambiguous outcomes. It is a standalone opt-in worker; Meta calls and public media reachability are unverified.
- Plan rules remain authoritative. Razorpay recurring subscriptions require explicit opt-in to auto-renew, with consent timestamp/version persisted in the checkout intent. Pay-once checkout uses owner-bound Payment Link intents, verifies a full captured payment and stores exact weekly 7-day or calendar-month access periods. Period grants expire without a renewal; the two modes cannot overlap, and switching waits until the current paid access ends. Pricing has separate mode choices; checkout stays disabled without test credentials plus webhook configuration.
- Subscription continuation uses Razorpay's documented `PATCH remaining_count` operation on the existing provider subscription; it never creates a second subscription. A durable cycle-scoped attempt is reserved near the finite-count limit. Cancellation intent is persisted before calling Razorpay and blocks continuation. Uncertain updates go to manual review without retry. The opt-in one-shot command is `npm run worker:subscription-continuation`; it requires an external scheduler and is not started by Next.js. Razorpay documents a maximum subscription duration of 100 years, so hitting that ceiling becomes manual review. No unlimited-renewal claim is made.
- Prepared billing migrations include `20261107080000_recurring_razorpay_subscription_intents`, `20261107090000_manual_payment_access`, `20261107091000_recurring_auto_renew_consent`, and `20261107092000_subscription_continuation`. Earlier project documentation described them as unapplied, but their actual status has not been checked in any target database. No real DB/provider checkout is verified.

## Persistence and safety state

Prisma repositories are present and fake-Prisma tests cover repository logic. Eight newer migrations are in the working tree for render queue/outbox, durable publishing attempts, selected render outputs, OAuth state, recurring Razorpay subscription intents, manual payment access grants, recurring consent evidence, and subscription continuation. Their application status is unknown until `_prisma_migrations` is checked on each explicitly selected database. No real database concurrency or persistence is claimed.

Original uploads remain separate from render outputs. Mock temporary media uses `.invalid`; provider mode is an app-hosted signed HTTPS endpoint and needs deployment and reachability checks. No S3/R2 provider or production email provider is configured. The publishing worker does not start automatically.

## External integrations

No real Google/Meta/Razorpay credentials or external email integration were used. Meta and Razorpay transports have injected fake-fetch tests only. Razorpay rejects live key IDs in this client; no payment call was made. No database, migration, cloud resource, real post or payment was exercised.

## Current verification

- `npm test` under Node 22: 607 total, 600 passed, 7 skipped, 0 failed.
- Typecheck, Prisma schema validation (using a non-routable placeholder URL only for schema parsing), diff check and isolated temporary-copy production build passed after the continuation changes.
- Razorpay subscription creation, update (`remaining_count`), cancellation, and Payment Link inputs were checked against the [official Razorpay API docs](https://razorpay.com/docs/api/payments/subscriptions/create-subscription/), [Update Subscription](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/) and [Cancel Subscription](https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/). Database migration execution, Prisma client regeneration after migration, sandbox checkout, provider webhook delivery, and cancellation/continuation behavior remain unverified against a real provider/database.

## Project audit classification

Full feature-by-feature A/B/C/D classification and evidence are maintained in `docs/FEATURE_STATUS.md`. High-level: local auth and private local media workflows are locally verified; Google, Instagram and Razorpay providers are mock-only; database-backed work, rendering recovery, cycles and publishing are partial pending migrations/real infrastructure; deployment, public media hosting and a configured production worker scheduler are missing. No production readiness is claimed.
