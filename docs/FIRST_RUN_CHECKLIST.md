# First real run (to execute as soon as network access exists)
Order matters; report each result truthfully (pass/fail with output), do not skip failures.
1. `npm install`; replace `latest` with the resolved versions in package.json (keep Prisma on ^7); commit the lockfile.
2. `npm run typecheck` (first time the TSX/test files are type-checked).
3. `npm test`.
4. `npx prisma validate`, then `npx prisma generate`; fix any schema errors.
5. Start a throwaway PostgreSQL, run `npx prisma migrate dev --name init`, then apply `prisma/manual-constraints.sql` as a migration.
6. Write `src/server/db.ts` (Prisma 7 + `@prisma/adapter-pg`) and a `PrismaRepository`; run the existing server tests against it.
7. `npm run build`, then `npm run dev` with `CLIPFORGE_DEMO_MODE=true`; fetch `/`, `/login`, `/pricing`, `/dashboard`, `/media`, `/collections`, `/cycles`, POST `/api/cycles`; confirm the default (no demo flag) shows 'Sign in required'. Fix anything Next.js disagrees with (async `params`, route-group layout, `.ts` import extensions, CSS import).
8. Only then: authentication, uploads (S3), editor UI, worker, Razorpay test mode, Instagram OAuth with a test app.

Never during any of this: create AWS resources, install AWS tooling, or deploy (see docs/COST_GUARDRAILS.md).
