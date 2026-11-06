# Feature status

Checked on 2026-11-06 against commit `bcb4bb3`. Test command: `npm test` on Node 22.23.4. Result: 395 passed, 1 skipped, 0 failed. That suite does not start Next.js or PostgreSQL.

Labels used here:

- **Complete and verified** — the intended behaviour is in the product path and was exercised successfully.
- **Implemented but not verified** — code exists for the real dependency, and this audit did not run that dependency.
- **Partially implemented** — a real slice exists and its unit tests passed, and the user-facing or production path is still incomplete.
- **Not implemented** — no working path in the app.
- **Blocked** — a required check failed, or the work needs an owner decision before it can continue.

## Product areas

| Area | Status | What exists | What is still missing |
|---|---|---|---|
| Accounts and security | Partially implemented | Register, confirm, login, logout, forgot-password, reset. Scrypt hashes, hashed session and email tokens, HttpOnly cookies, rate limit, enumeration-safe errors. Pages and `/api/auth/*`. Memory repository. Tests passed. | Production mode, PostgreSQL sessions, real email, Auth.js/Supabase (not chosen). `next dev` was not run, so `next/headers` is unverified. Local mode is refused in production on purpose. |
| Ownership and private media | Partially implemented | Handlers return 404 for someone else's objects. Media routes re-check grants, support ranges, and set nosniff, CSP sandbox, and CORP. Tests passed, including the older Chromium harness recorded in `docs/VERIFICATION.md`. | Not re-run in Next.js. Not backed by PostgreSQL. |
| Media library | Partially implemented | Upload with signature sniffing, ffprobe, quota, thumbnails, memory and local-disk storage. Library and detail pages. Collections are readable. | Files and rows disappear on restart unless a local folder is set, and even then the file list is memory-only. No S3. No malware scan. |
| Video editor | Partially implemented | Aspect ratios 9:16, 4:5, 1:1, 16:9, original. Solid, sampled, and blurred backgrounds. Zoom, position, border, logo. Templates saved apart from the media file. FFmpeg command builder and a worker-style runner. Geometry tests compared a real render with the preview. | The editor page does not call the renderer. Templates are not applied to a whole cycle. Logo dragging was not bundled by the old harness. No job queue. |
| Publishing cycles | Partially implemented | Create cycle, mix, unmix, bulk captions, bulk covers, start with preflight. Upcoming items only. Version checks. Schedule calculator and queue ordering. Tests passed. | Pause, resume, and stop exist as pure functions only. No worker publishes anything. No duplicate-publish guard has run against Instagram. |
| Sharing | Partially implemented | Permission rules, share-link hashing, grant create/revoke API, recipient caps, 90-day delegate limit, import and deletion rules, usage rules. Collection screens are read-only. | No access-request approve/reject UI. No import or owner-deletion workflow in the app. No public share page. Permissions are not re-checked by a publisher because publishing does not run. |
| Smart Publishing Assistant | Partially implemented | `runPreflight` returns Ready, Recommendation, Action Required, and Blocked. Panel component and the start-cycle handler call it. Tests passed. | Checks use local records only. No live Instagram eligibility, no real token, no previous platform errors from a real publish. |
| Billing | Partially implemented | Catalog, entitlements, Razorpay HMAC helpers, idempotent webhook interpretation, subscription states. Unit tests passed. | No checkout, no subscription API call, no webhook HTTP route, no test-mode payment. Razorpay docs were read on 2026-10-28 and were not called. |
| Instagram | Not implemented | A facts module records official limits and container states. The schema has `SocialAccount`. | No OAuth, no token storage implementation, no container create, no publish call. Some Reels requirements are still listed as unverified inside `instagram-capabilities.ts`. |
| Background jobs | Not implemented | Domain functions describe claim, stale-lock recovery, and render usage. | No BullMQ, no worker process, no durable job row written by a running worker. |
| Object storage (S3) | Blocked | The storage type allows the label `s3` and describes it as not connected. | Building or creating a bucket needs explicit approval. Keep using memory or `.local-media/` until then. |
| Database persistence | Implemented but not verified | Prisma 7.10.1 schema validates. Mappers, `PrismaRepository`, and `PrismaAuthRepository` exist. Contract tests pass against a fake client. `prisma generate` writes a gitignored client. | No migration and no connection from the app. Local PostgreSQL asked for a password; none was supplied and no database was created. |

## Checks that are not features

| Check | Status |
|---|---|
| Automated unit and route tests (`npm test`) | Complete and verified on 2026-11-06 after the stability fixes: 395 passed, 1 skipped, 0 failed. |
| Full `tsc --noEmit` | Complete and verified. Exit 0 on Node 22.23.4 after `prisma generate`. |
| Next.js production build | Complete and verified. `npm run build` (Next.js 16.4.5) finished, including static page generation. |
| Prisma validate / migrate | Validate passed on Prisma 7.10.1. Migrate was not started. |
| Dependency lockfile | Pinned in `package.json` and matched by `package-lock.json`. `npm ci` succeeded. The lockfile is not committed yet. |
| Secret scan of all 19 commits | Complete and verified as a scan: no cloud keys, private keys, or live payment keys. Matches were placeholders in `.env.example`, test fixtures, and message labels. Values were not copied into this doc. |
| End-to-end tests on Next.js plus PostgreSQL | Not implemented. |

## Older browser report

Commit `bcb4bb3` includes a report of 18/18 Chromium checks against `scripts/verify-harness.ts`. That harness is not Next.js. This audit did not re-run `npm run verify:browser`. Treat that report as historical until it is repeated.
