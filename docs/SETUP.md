# Setup

Requires Node.js 22, at least 22.12 and below 23. Prisma 7.10 rejects Node 23. This repo was checked on Node 22.23.4.

    npm ci           # install the exact versions in package-lock.json
    DATABASE_URL="postgresql://127.0.0.1:5432/clipforge" npx prisma generate
    npm test         # all tests (rules, server layer, FFmpeg rendering, UI/page rendering, API routes)
    npm run typecheck
    npm run build    # production build; verified on 2026-11-06
    npm run dev      # Next.js dev server (not exercised in that verification)

Local demo (once Next.js is installed): set `CLIPFORGE_DEMO_MODE=true` in `.env` to browse built-in SAMPLE data. Without it the
app shows "sign in required" (there is no real authentication yet).

Normal database-mode development and deployed environments require the private S3 provider. Configure `CLIPFORGE_STORAGE_PROVIDER=s3`, `CLIPFORGE_S3_REGION`, and exactly the bucket for the selected environment: `CLIPFORGE_S3_DEVELOPMENT_BUCKET` for development/legacy Vercel Preview, `CLIPFORGE_S3_STAGING_BUCKET` for staging, or `CLIPFORGE_S3_PRODUCTION_BUCKET` for production. Staging requires `CLIPFORGE_DEPLOYMENT_ENV=staging`, runs with `NODE_ENV=production`, and fails closed unless its dedicated bucket exists; it never falls back to development or production. Production processes reject development storage, and contradictory Vercel settings fail closed. When deployment identity is unset, the previous `VERCEL_ENV`/`NODE_ENV` selection remains as a backward-compatible fallback. Provide the server-only `CLIPFORGE_S3_ACCESS_KEY_ID` / `CLIPFORGE_S3_SECRET_ACCESS_KEY` pair for existing Vercel/local deployments. When that pair is absent, the AWS SDK standard credential provider chain is used, including an ECS task role and standard AWS environment credentials. A partial ClipForge-specific pair is rejected. Each environment must use a different private bucket and IAM identity. The app does not use browser-to-S3 uploads or public object URLs.

The runtime validates bucket syntax, region syntax, credentials configuration, and deployment environment, but it does not infer environment from the bucket name or verify live AWS permissions. The selected environment may only use its matching bucket variable. Keep each IAM identity scoped to its matching bucket. Object actions are limited to `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on `media/*`, `thumb/*`, `staging/*`, and `render/*`. Do not grant `s3:ListBucket`: the application never lists objects, and a prefix condition on that bucket-level permission cannot safely scope the `HeadObject` missing-key check. Without `s3:ListBucket`, AWS may return 403 instead of 404 for a missing object; the adapter treats that as a storage error and fails closed. Do not grant ACL, public access, bucket administration, or KMS permissions for the configured SSE-S3 default.

Staging and production web runtimes and continuous workers require `CLIPFORGE_EXPECTED_DATABASE_HOST` and `CLIPFORGE_EXPECTED_DATABASE_NAME` whenever `DATABASE_URL` is configured. The web runtime checks these non-secret pins before selecting any adapter; workers check before initialization. Vercel Preview keeps its existing preview behavior unless explicitly configured as staging/production. A mismatch fails closed without logging the URL. With no runtime `DATABASE_URL`, the web app retains its existing unconfigured behavior. Local development and test mode do not require the pins.

SES keeps the existing SigV4 adapter and resolves credentials lazily through the AWS SDK default credential provider chain when `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are both absent; this supports ECS task roles. A complete explicit pair remains supported for local/test compatibility, but partial key configuration is rejected. Temporary session credentials are signed with the session token. Configure `EMAIL_PROVIDER=ses`, `AWS_REGION`, and `EMAIL_FROM`; no credential resolution or SES request occurs during application setup.

Demo mode continues to keep its sample files in memory unless a local test path is explicitly configured. Local disk can also be explicitly selected with `CLIPFORGE_STORAGE_PROVIDER=local-disk` and `CLIPFORGE_LOCAL_MEDIA_DIR` for local development/test fallback only; production refuses it. Missing or invalid S3 settings disable media operations rather than selecting another provider. `CLIPFORGE_MAX_UPLOAD_MB` changes the per-upload technical cap (default 200).

Local accounts (real sign-up/sign-in, memory only): set `CLIPFORGE_LOCAL_AUTH=true` (and optionally `CLIPFORGE_BASE_URL`). Confirmation and reset links appear on `/dev/outbox`; no email is sent. This mode is refused when `NODE_ENV=production`.

Google sign-in uses the same session cookie as email/password. It stays off until you create an OAuth client yourself and replace the placeholders in `.env.local` (never commit them):

1. In Google Cloud Console, create an OAuth client of type Web application. Do not commit the client secret.
2. Add this authorised redirect URI exactly: `http://localhost:3000/api/auth/google/callback`.
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` to that client. `replace-me` is treated as not configured.
4. Apply `prisma/migrations/20261106163300_google_identity` on a database you choose. It is not applied to Neon from this repo.
5. Email/password register, login, logout, verification, and password reset stay as they are. A signed-in user connects Google from the app banner. A matching email is not linked automatically.

The buttons do not pretend a Google login happened when those variables are still placeholders.

Instagram uses Instagram Login and stays off until you create a Meta app yourself. This repo does not create that app, and it does not publish a Reel. Official page URLs and the publishing-worker design are in `docs/INSTAGRAM.md`:

1. In the Meta app, add this redirect URI exactly: `http://localhost:3000/api/instagram/callback`.
2. Set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_OAUTH_REDIRECT_URI`, and `INSTAGRAM_TOKEN_KEY`. `replace-me` is treated as not configured. The token key is 32 bytes encoded as base64url and never goes in the browser.
3. Apply `prisma/migrations/20261106174500_instagram_account_details` on a database you choose before database mode can store the account type and permission names. It is not applied to Neon from this repo. The encrypted token column already exists on the init migration.
4. Connect from the Instagram page while signed in. A personal account is refused. Disconnect asks for confirmation and removes the token without deleting videos.

The production Next.js health URLs are `/api/health/live` (process only) and `/api/health/ready` (database ping and configured persistent storage). Readiness returns only a generic status and does not test live AWS permissions.

Continuous production workers stop taking jobs on SIGINT/SIGTERM, allow up to four minutes for the active job to finish, and dispose of Prisma/S3 resources after a clean drain. A job that exceeds this bound exits and relies on its existing lease/retry recovery.

Rendering and synchronous upload checks need `ffmpeg`/`ffprobe` on the PATH (tests skip the real-binary cases if unavailable). Database-mode
uploads also create a durable verification job. Run `npm run worker:media-verification` as a separate process in the same environment as
the application, with private storage access and `ffprobe` installed; otherwise media stays in Processing/Incomplete until a worker can
verify it. Apply the forward-only `20261115120000_media_verification_jobs` migration before deploying this code. This repository change
does not apply the migration, connect to AWS, or create worker infrastructure.
No AWS account, credentials or resources are needed or used: see docs/COST_GUARDRAILS.md.

Sandbox note: in the development sandbox React, react-dom, tsx were symlinked into `node_modules` from a global install because there
was no network. `node_modules` is git-ignored; a normal `npm install` replaces this.

Verification helpers (not part of the app): `npm run verify:harness` serves the app's real pages/routes with Next-style routing (local-auth mode) and
`npm run verify:browser` drives Chromium through it (needs ffmpeg, Playwright and a Chromium; the paths default to the development sandbox and can be set
with PLAYWRIGHT_MODULE / CHROMIUM_PATH). After `npm install` the real checks are `npm run typecheck`, `npm test`, `npm run build`.
