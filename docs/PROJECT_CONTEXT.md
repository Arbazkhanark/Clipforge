# ClipForge project context

Audit date: 2026-11-06. Git commit: `bcb4bb34acef998772e71abd6c2075106c065a9e` (`bcb4bb3`). Branch: `main`. 19 commits. Working tree at the start of this audit matched that commit.

This file describes the repository that exists. It is not a claim that the product is launch-ready.

## Product

ClipForge is a SaaS for video creators and clippers. The intended product lets a person upload and organise videos, apply simple reusable edit styles, build a publishing cycle, schedule Instagram Reels through official APIs, share collections with explicit permissions, and pay through Razorpay.

Prices in code (`src/lib/billing/catalog.ts`), in integer paise:

| Plan | Weekly | Monthly | Recipients per collection |
|---|---:|---:|---:|
| Free | ₹0 | ₹0 | 0 |
| Creator | ₹499 | ₹1,999 | 5 |
| Pro | ₹999 | ₹3,999 | 25 |
| Agency | ₹1,499 | ₹5,999 | 100 |

Creator includes basic sharing and Mix/Unmix. Expiring grants and delegated managers are Pro and Agency. Delegated grants are capped at 90 days in `DELEGATE_MAX_GRANT_DAYS`. Do not change prices or these policies without approval.

## Stack that is actually in the repo

| Intended | What is in this checkout |
|---|---|
| Next.js App Router, TypeScript | Next.js 16.4.5 and TypeScript 7.0.2 are pinned. `npm run typecheck` and `npm run build` passed on 2026-11-06. `next dev` has not been exercised. |
| Tailwind CSS and shadcn/ui | Not set up. Styling is `app/globals.css`. |
| PostgreSQL and Prisma | `prisma validate` passes on Prisma 7.10.1. No migrations and no database runtime mode. The generated client is gitignored; run `prisma generate` before typecheck on a fresh tree. |
| Auth.js or Supabase Auth | Neither. Custom scrypt sessions in `src/server/auth/`. Keep this until a replacement is approved. |
| Private S3 | No S3 adapter and no AWS SDK. Memory and local-disk adapters only. |
| FFmpeg | `src/lib/render/` builds and runs FFmpeg. Tests passed on this machine with FFmpeg 9.0.2. The editor does not enqueue that render. |
| Redis and BullMQ | Not dependencies. A local Redis answered `PONG`; the app does not call it. |
| Transactional email | Interface plus an in-memory outbox at `/dev/outbox`. No provider. |
| Razorpay only | Signature and subscription-state code plus unit tests. No checkout route and no webhook route. |

## How the code is shaped

Business rules live in `src/lib/domain/` and `src/lib/billing/`. They do not open the database or the network. Server handlers in `src/server/handlers/` check the session, validate input, check ownership, apply plan limits, then save. `Repository` and `AuthRepository` have memory implementations and Prisma implementations. The Prisma implementations are tested with a fake client, not PostgreSQL.

`src/server/runtime.ts` has three modes:

- **unconfigured** (default): APIs answer 401/503. Pages say sign-in is required.
- **demo** (`CLIPFORGE_DEMO_MODE=true`): one sample user and sample rows in memory.
- **local** (`CLIPFORGE_LOCAL_AUTH=true`): real register, confirm, login, logout, and reset, stored in memory. Refused when `NODE_ENV=production`.

There is no fourth mode that opens PostgreSQL.

## Safety rules already in force

- Official platform APIs only. No Instagram password collection exists in this code.
- S3, AWS CLI, deploy, and any paid cloud resource need explicit approval first. See `docs/COST_GUARDRAILS.md`.
- `.env`, tokens, and credentials stay out of git. `.env.example` is placeholders only.
- Razorpay is the only payment gateway.
- Do not create a ZIP unless the owner asks.

## GitHub

`origin` is `https://github.com/Arbazkhanark/Clipforge.git`. The local restore bundle remains as `restore-bundle`. History has not been rewritten. Nothing has been pushed from this audit.
