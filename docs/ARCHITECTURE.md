# ClipForge Architecture (current + intended)

## What exists today
```
src/lib/billing/
  catalog.ts              Plans, prices (paise), limits, feature flags. THE only place for these.
  entitlements.ts         checkLimit(): "can this user do N more of X?" (call server-side)
  razorpay-signature.ts   HMAC verification for checkout and webhooks (raw body!)
  subscription-state.ts   Pure state machine: duplicates, stale events, transitions
tests/                    node:test suites (run: npm test)
```
## Intended (not built yet)
- Next.js App Router web app; Prisma + PostgreSQL as the durable source of truth.
- Private S3 + presigned URLs; uploads go browser → S3 directly; API only records metadata.
- Workers (BullMQ/Redis optional) run FFmpeg and publishing jobs; DB rows hold job state.
- Shared media: `MediaAsset` (owner) is referenced by `CycleItem`; permissions rechecked at use time.
- Billing: webhook → verify raw-body signature → dedupe by event id → state machine → entitlements.
