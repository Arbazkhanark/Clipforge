# External behaviour: what is verified, and what is not

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
