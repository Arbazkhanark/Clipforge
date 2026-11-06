# External behaviour: what is verified, and what is not

## Stability pass — 2026-11-06, after the audit

Node v22.23.4. Commands and results:

| Command | Result |
|---|---|
| `npm ci` | Exit 0. 184 packages from `package-lock.json`. |
| `npm test` | Exit 0. 395 passed, 1 skipped, 0 failed. |
| `npm run typecheck` | Exit 0. Requires `prisma generate` first because `src/generated/prisma` is gitignored. |
| `DATABASE_URL=postgresql://127.0.0.1:5432/clipforge npx prisma validate` | Exit 0. Schema valid. This URL was not used to connect or migrate. |
| `npm run build` | Exit 0. Next.js 16.4.5 compiled, typechecked, and generated 28 static pages. A second build also exited 0. |

`package.json` no longer uses `latest`. Pinned versions: Next 16.4.5, React 19.3.1, React DOM 19.3.1, TypeScript 7.0.2, tsx 4.23.15, Prisma 7.10.1, `@prisma/client` 7.10.1, `@prisma/adapter-pg` 7.10.1, `pg` 8.23.1, `@types/node` 26.6.6, `@types/react` 19.3.0, `@types/react-dom` 19.3.0, `@types/pg` 8.23.1. Engines: `>=22.12.0 <23`.

## Repository audit — 2026-11-06 (commit `bcb4bb3`)

This section is the latest local run. Older sections below remain as historical notes from the sandbox that had no network. Where they say a command was never run, this section replaces that claim.

Machine: macOS, system Node v23.6.0 (Prisma 7.10.1 refuses it), Homebrew Node v20.18.0 also present (below Prisma's Node 20.19 minimum). Commands below used a downloaded Node v22.23.4 kept in gitignored `.local-node/`. FFmpeg 9.0.2 and ffprobe 9.0.2 were on `PATH`. `pg_isready` reported localhost:5432 accepting connections. `redis-cli ping` returned `PONG`. No `DATABASE_URL` is configured in the repo. `psql` asked for a password for the local user and this audit did not supply one, did not create a database, and did not run migrations.

| Check | Result |
|---|---|
| `npm install` on system Node 23.6.0 | Failed. Prisma 7.10.1 preinstall rejects Node 23. |
| `npm install` on Node 22.23.4 | Succeeded. 183 packages. Created an uncommitted `package-lock.json`. `package.json` still says `latest` for most packages. Resolved today: Next 16.4.5, React 19.3.1, React DOM 19.3.1, TypeScript 7.0.2, tsx 4.23.15, Prisma and `@prisma/client` and `@prisma/adapter-pg` 7.10.1, `pg` 8.23.1. |
| `npm test` | **395 passed, 1 skipped, 0 failed** (396 tests). The skip is `tests/typecheck.test.ts`, which steps aside once real `@types` are installed and tells you to run `npm run typecheck`. |
| `npm run typecheck` (`tsc --noEmit`) | **Failed. 15 errors in 4 files:** `src/server/prisma/create-client.ts` (generated client missing), `tests/auth-routes.test.tsx`, `tests/forms.test.tsx`, `tests/storage.test.ts`. |
| `npm run build` (Next.js 16.4.5) | Compile step succeeded. TypeScript step failed with the same 15 errors. Build did not finish. Next rewrote `tsconfig.json` and added `next-env.d.ts`; both automatic edits were removed so this audit did not keep an unreviewed compiler config. |
| `npx prisma validate` | **Failed. 103 errors** on Prisma 7.10.1. The first errors say one-line enums such as `enum UserRole { user admin }` are not valid enum-value definitions, so the parser never closes those enums. Later "unknown type" and "index refers to relation fields" errors follow from that. `prisma generate` and `prisma migrate` were not run. |
| Real PostgreSQL repository tests | Not run. No app database was created. |
| Next.js dev server, browser against `next dev` | Not run. |
| S3, Razorpay live/test API, Instagram API, email delivery, Redis/BullMQ inside the app | Not run. Redis the process is installed; the app has no Redis client. |

`npm test` uses Node's test runner and imports the app modules directly. A passing test here still does not mean `next dev`, PostgreSQL, or a production session works.

## Historical notes (2026-10-28 and 2026-11-03)

Verified by reading OFFICIAL documentation via web search/fetch on **2026-10-28**. The development sandbox has no network, so
nothing here has been exercised against a live service. Re-check before launch; these APIs change.

## Razorpay (official docs: razorpay.com/docs)
| Fact | Status | Where used |
|---|---|---|
| Webhook signature = HMAC-SHA256 of the **raw body** with the webhook secret, hex, header `X-Razorpay-Signature` | ✅ verified | `razorpay-signature.ts` |
| Duplicate webhooks are detected with the `x-razorpay-event-id` header | ✅ verified | `razorpay-webhook.ts` (header required) |
| Subscription checkout signature = HMAC-SHA256(`payment_id|subscription_id`) with the **API key secret**; order payments use `order_id|payment_id` | ✅ verified | `razorpay-signature.ts` |
| Subscription statuses: created, authenticated, active, pending, halted, cancelled, completed, expired (+ paused) | ✅ verified | `subscription-state.ts` |
| Subscription webhook events: authenticated, activated, charged, pending, halted, cancelled | ✅ verified | `razorpay-webhook.ts` |
| Events `subscription.paused`, `.resumed`, `.completed` | 🟡 seen only in a third-party plugin's list; kept as provisional | `razorpay-webhook.ts` |
| Free trial = subscription with a **future `start_at`**; an authentication transaction (documented as ₹5, auto-refunded) happens at sign-up | ✅ verified | `trialStartAtUnix`, `TRIAL_DISCLOSURE` |
| Exactly which status a trial subscription shows before `start_at` | 🟡 assumed `authenticated`; entitlement also requires our own `trialEndsAt` | `hasPaidEntitlements` |
| Real Razorpay API calls, checkout, test mode, webhook delivery | ❌ **never run** (no credentials, no network) | - |

## Instagram (official docs: developers.facebook.com/docs/instagram-platform)
| Fact | Status |
|---|---|
| Publishing = create container (`/{ig-id}/media`) -> check `status_code` -> `/{ig-id}/media_publish` | ✅ verified |
| Professional accounts only; OAuth only (we never handle passwords) | ✅ verified |
| Two login paths with different permissions (`instagram_business_content_publish` vs `instagram_content_publish`) | ✅ verified |
| 100 API-published posts per rolling 24h, enforced at publish; **the same guide also mentions 50 in a carousel section** | ✅ verified, with a documented conflict; use `content_publishing_limit` at runtime |
| Meta recommends apps enforce the limit themselves | ✅ verified -> `findPublishQuotaViolations`, preflight |
| Containers expire after 24h; 400 containers per 24h | ✅ verified -> containers are created shortly before publishing |
| Poll status about once a minute, at most 5 minutes; statuses EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED | ✅ verified -> `nextActionForContainerStatus`; PUBLISHED resolves an ambiguous publish |
| Media must be on a **publicly reachable URL at the time of the attempt** (private S3 needs short-lived presigned URLs) | ✅ verified |
| Photo posts: JPEG only | ✅ verified |
| Reels containers accept `cover_url` and `thumb_offset` | ✅ verified (parameters exist) |
| Reels video specs, caption max length, cover image requirements, `cover_url` vs `thumb_offset` precedence, Creator-account eligibility, App Review needs, Graph API version | ❌ **not verified** (listed in `INSTAGRAM_UNVERIFIED`) |
| OAuth, token storage, container creation, publishing | ❌ **not implemented, never run** |

## Prisma
| Fact | Status |
|---|---|
| Prisma 7: connection URL is not allowed in `schema.prisma`; it goes in `prisma.config.ts` | ✅ verified (docs.prisma.io migration guide) -> schema fixed |
| Generator `prisma-client` with required `output`; client needs a driver adapter (`@prisma/adapter-pg`) | ✅ verified -> schema + package.json |
| `prisma validate`, migrations, generated client behaviour | ❌ **never run** (CLI not installed) |
| Exact installable versions | ❌ unknown offline; Prisma pinned to `^7`, others `latest` |

## Authentication and persistence (this project's own code; nothing external was called)
| Claim | Status |
|---|---|
| Password hashing/verification, token hashing, session expiry (idle 7d, absolute 30d), single-use 24h/1h tokens, reset ends all sessions, rate limit, identical answers for unknown/wrong accounts | ✅ tested (real `node:crypto` scrypt) |
| scrypt cost parameters match current OWASP guidance | ❌ from memory, not re-checked (no network) |
| Cookie flags (HttpOnly, SameSite=Lax, Secure + `__Host-` on https) | ✅ asserted in tests; ❌ never seen by a real browser |
| PrismaRepository / PrismaAuthRepository correctness | 🟡 logic verified against a FAKE client that models documented Prisma behaviour (`updateMany` count, `P2002`, `$transaction`); **real Prisma + PostgreSQL never run** (row locks, JSON/BigInt columns, enum casts, constraint names are unproven) |
| Prisma schema validity | ❌ `prisma validate` never run (only a text sanity test) |
| `next/headers` cookie reading in pages | ❌ never run under Next.js |

## Verification status - run on 2026-11-03 (commit after 6895b2e)
Environment: the sandbox's network access is DISABLED by configuration (DNS cannot resolve `registry.npmjs.org`; no proxy; every external host
unreachable). No PostgreSQL server, Docker or Podman exists, nothing listens on port 5432, and `next`, `prisma`, `@prisma/*`, `@types/*` are not installed.

| Step | Status | Detail |
|---|---|---|
| Install pinned dependencies | ⛔ BLOCKED | no network; `package.json` still uses `latest` for non-Prisma packages (cannot look up versions) |
| `prisma validate` | ⛔ NOT RUN | Prisma CLI not installed |
| Migrations on real PostgreSQL | ⛔ NOT RUN | no PostgreSQL; `prisma/manual-constraints.sql` never applied |
| Repository contract tests on real PostgreSQL | ⛔ NOT RUN | pass only against `MemoryRepository` and `PrismaRepository` over a FAKE client |
| Full TypeScript check incl. TSX | 🟡 PARTIAL | `npm run typecheck` (real types) NOT RUN. A stub-based strict check of ALL of `src/` and `app/` (every `.tsx` included) passes and runs as a test (`tests/typecheck.test.ts`); it excludes `create-client.ts` and `prisma.config.ts` (need uninstalled packages) and does not cover `tests/` or `scripts/`. It found and fixed one real bug (LogoDragger). HTML attribute names are not checked by the stubs |
| Next.js production build | ⛔ NOT RUN | Next.js not installed |
| App running under Next.js (`next dev`) | ⛔ NOT RUN | |
| Real-browser test | 🟡 PARTIAL | 18/18 checks pass in real Chromium 141 against a **verification harness that is NOT Next.js** (`npm run verify:browser`, see below) |

### What the browser harness proves - and does not
`scripts/verify-harness.ts` serves the app's REAL `app/**/page.tsx` and `route.ts` modules with Next-style file routing (route groups, `[params]`,
nested layouts, Request/Response handlers) in local-auth mode; `scripts/browser-check.mjs` drives Chromium through it.
**Proved in a real browser:** register -> email link shows a confirm page (no auto-confirm) -> confirm -> sign in -> dashboard; session cookie is
HttpOnly + SameSite=Lax and unreadable from JavaScript; wrong-password and unknown-account errors are identical and set no cookie; image, MP4 and WebM
uploads through the real form (verified by ffprobe); thumbnails load; WebM plays and seeks using HTTP 206 Range responses; MP4 metadata and Range
responses are correct; downloads are byte-identical to the uploads with the right file name; another user gets 404 for every variant of my files
(identical to a missing file) and anonymous gets 401; the editor sketch updates (aspect, zoom, border, colour, logo), saves a template, and the original
file stays byte-identical; hostile editor input is explained and never executes; a fake `.mp4` is refused with a clear message and not stored; the dashboard
storage meter reflects real uploads; cross-origin forms cannot log out, create or sign in (403); no horizontal scrolling at 375px on 9 screens;
logout clears the cookie and the old cookie stops working; no JavaScript errors and no unexpected failed requests.
**NOT proved:** anything about Next.js itself (bundling, RSC, caching, `next/headers`, `next/link`, metadata/icon conventions, `next build`);
MP4/H.264 PLAYBACK (this Chromium build has no H.264 decoder - WebM was used for playback); the logo-drag enhancement (client JavaScript is not
bundled by the harness); `Secure`/`__Host-` cookies over https; Firefox/WebKit; automated accessibility audits; real PostgreSQL behaviour.
Bugs found by the browser run: a missing favicon (added `app/icon.svg`, regression test `tests/app-icon.test.ts`).

### To unblock (needs the owner)
Enable network access for the sandbox (the sandbox setting `Network: disabled` is a configuration choice). Then: install + pin dependencies; get a real
PostgreSQL (system package, or an npm-installable one such as `embedded-postgres` - an untested suggestion); run `prisma validate`, migrate, the contract
suites against it, the real typecheck, `next build`, and re-run `npm run verify:browser` pointed at `next start`.
