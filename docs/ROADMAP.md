# Roadmap

Audit date: 2026-11-06. Commit: `bcb4bb3`. Do not start Instagram, Razorpay checkout, S3, or a worker until the steps below are green. Each step should stay small enough to review on its own.

## Done in the stability pass (2026-11-06)

Dependencies are exact versions. Node 22 (`>=22.12.0 <23`) is the supported runtime. Prisma schema validates. `npm test`, `npm run typecheck`, and `npm run build` passed. Migrations were not run.

## Safest next task

**Exercise the existing app under `next dev` with `CLIPFORGE_LOCAL_AUTH=true`.**

Register, open `/dev/outbox`, confirm the email, sign in, upload a small file, preview it, and save an editor template. This uses the memory runtime that already exists. It does not need a database password, S3, Razorpay, or Instagram.

## After that, in order

1. **Local PostgreSQL only.** Needs a `DATABASE_URL` from the owner, kept out of git. Then `prisma migrate` and `prisma/manual-constraints.sql`. Point the contract tests at the real client and add a runtime mode that uses `PrismaRepository`. Still no AWS.
2. **Sharing workflows that already have rules.** Access-request decisions, import, and owner deletion as server handlers and simple pages. Re-check permissions in those handlers. Keep published cycle history when a video leaves a cycle.
3. **Wire the editor to the existing FFmpeg runner** as a local process, one video, with the usage rules that charge only a validated output. Add a queue only when a single local run is reliable.
4. **Razorpay test mode.** Checkout and the signed webhook route, idempotent on the event id. No second payment gateway.
5. **Instagram official OAuth and publishing** with a Meta test app. Store tokens encrypted. Never store Instagram passwords. Enforce the live publishing limit. Pause, resume, and stop must call the cycle-state functions that already exist.

## Explicitly waiting on the owner

- Approval before any AWS resource, S3 bucket, deploy, or paid plan.
- A local `DATABASE_URL` that is not committed.
- The GitHub push. Do not force-push. Nothing has been pushed.

## Already strong enough to build on

Pure rules and their tests: plans, sharing, mix/unmix, captions and covers, cycle state, schedule, preflight, upload, media serving, and the FFmpeg command builder. Extend these. Do not rewrite them.
