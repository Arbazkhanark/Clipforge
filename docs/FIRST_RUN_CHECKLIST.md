# First real run (to execute as soon as network access exists)
Order matters; report each result truthfully (pass/fail with output), do not skip failures.
1. `npm install`; replace `latest` with the resolved versions in package.json (keep Prisma on ^7); commit the lockfile.
2. `npm run typecheck` (first time the TSX/test files are type-checked).
3. `npm test`.
4. `npx prisma validate`, then `npx prisma generate`; fix any schema errors.
5. On a throwaway PostgreSQL, apply the existing migrations in order: `prisma/migrations/20261106135723_init`, then `prisma/migrations/20261106162016_integrity_constraints`. Do not execute `prisma/manual-constraints.sql` separately.
6. Run `tests/contracts/*.contract.ts` against `PrismaRepository` / `PrismaAuthRepository` over a REAL local PostgreSQL (replace the fake client): every failure is a bug in my unverified assumptions. Then write `src/server/db.ts` (Prisma 7 + `@prisma/adapter-pg`) and a `PrismaRepository`; run the existing server tests against it.
7. `npm run build`, then `npm run dev` with `CLIPFORGE_DEMO_MODE=true`; fetch `/`, `/login`, `/pricing`, `/dashboard`, `/media`, `/collections`, `/cycles`, POST `/api/cycles`; confirm the default (no demo flag) shows 'Sign in required'. Also: upload a small MP4 through /media in demo mode (memory, then with CLIPFORGE_LOCAL_MEDIA_DIR), submit each form once, confirm flash messages and that the default mode refuses uploads. Fix anything Next.js disagrees with (async `params`, route-group layout, `.ts` import extensions, CSS import).
8. Only then: authentication, uploads (S3), editor UI, worker, Razorpay test mode, Instagram OAuth with a test app.

Never during any of this: create AWS resources, install AWS tooling, or deploy (see docs/COST_GUARDRAILS.md).

Also verify under Next.js: `CLIPFORGE_LOCAL_AUTH=true` register -> /dev/outbox -> confirm -> sign in -> upload -> preview/download -> editor save; check the session cookie in the browser dev tools (HttpOnly, SameSite=Lax) and that pages see the user via `next/headers`.
