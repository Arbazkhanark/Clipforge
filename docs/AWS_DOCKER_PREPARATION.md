# ClipForge production container preparation

This is a local preparation plan. Six Linux ARM64 images were built locally; no AWS resources were created, no database was changed, and nothing was deployed. ECR/ECS names and sizing below are proposals, not provisioned resources or price estimates.

## Container layout

The root `Dockerfile` builds a Next.js standalone web image and five worker images from one locked source revision. All targets use Node `22.23.5-bookworm-slim`, run as the unprivileged `node` user, set `NODE_ENV=production`, select the production S3 configuration, and use `/tmp/clipforge` only for transient processing files. The Docker context excludes environment files, `.aws`, local media, generated host Prisma output, tests, and local build artifacts.

| Image target | Entrypoint | Media binaries | Starting task size for load testing |
| --- | --- | --- | --- |
| `web` | Next standalone `server.js` | `ffmpeg`, `ffprobe` for upload inspection and thumbnail creation | 1 vCPU / 2 GiB |
| `worker-media-verification` | `scripts/run-media-verification-worker.ts` | `ffprobe` (Debian's `ffmpeg` package also installs the ffmpeg binary) | 1 vCPU / 2 GiB |
| `worker-media-cleanup` | `scripts/run-media-cleanup-worker.ts` | None | 0.5 vCPU / 1 GiB |
| `worker-media-replacement` | `scripts/run-media-replacement-worker.ts` | `ffprobe` (package also includes ffmpeg) | 1 vCPU / 2 GiB |
| `worker-render` | `scripts/run-render-worker.ts` | `ffmpeg`, `ffprobe` | 2 vCPU / 4 GiB |
| `worker-instagram-publishing` | `scripts/run-publishing-worker.ts` | None | 0.5 vCPU / 1 GiB |

These are initial test sizes only. Video size, duration, concurrency and temporary storage use need workload measurements before production sizing. Rendering and S3 downloads use the container's ephemeral writable `/tmp`; configure enough task ephemeral storage for the largest supported input/output pair and concurrent jobs. No media object relies on the container filesystem surviving a restart.

`tsx` is a production dependency because all five existing worker entry points run TypeScript directly using `node --import tsx`. Prisma CLI remains a build/development dependency. The build invokes the existing `prisma:generate` script with its loopback placeholder URL; generation is local and does not connect to PostgreSQL. Prisma 7's generated client is copied from the builder, and runtime code uses `@prisma/adapter-pg` with `DATABASE_URL`.

## Local image commands

The six local ARM64 builds completed successfully in Phase 2.2A. These commands document how to reproduce them; this Phase 2.4 task did not rebuild images:

```sh
docker build --network=none --target web -t clipforge-web:local .
docker build --network=none --target worker-media-verification -t clipforge-media-verification-worker:local .
docker build --network=none --target worker-media-cleanup -t clipforge-media-cleanup-worker:local .
docker build --network=none --target worker-media-replacement -t clipforge-media-replacement-worker:local .
docker build --network=none --target worker-render -t clipforge-render-worker:local .
docker build --network=none --target worker-instagram-publishing -t clipforge-instagram-publishing-worker:local .
```

The build commands use `--network=none` once required base images and dependencies are cached. No Docker build was run during this staging-safety task.

## Runtime environment

Pass configuration through the orchestrator's task environment or secrets integration. Never pass credentials as Docker `ARG`, bake them into `ENV`, or add local env files to the build context. Names only:

**Web, all required for production database mode and private storage:**

- `DATABASE_URL`
- `CLIPFORGE_DEPLOYMENT_ENV`
- `CLIPFORGE_STORAGE_PROVIDER`
- `CLIPFORGE_S3_STAGING_BUCKET` or `CLIPFORGE_S3_PRODUCTION_BUCKET`, matching the task's explicit deployment environment
- `CLIPFORGE_EXPECTED_DATABASE_HOST`
- `CLIPFORGE_EXPECTED_DATABASE_PORT`
- `CLIPFORGE_EXPECTED_DATABASE_NAME`
- `CLIPFORGE_S3_REGION`
- `AWS_REGION` (standard SDK/task-role region)
- `CLIPFORGE_MAX_UPLOAD_MB` (optional; default is enforced by the application)
- `CLIPFORGE_S3_ACCESS_KEY_ID`, `CLIPFORGE_S3_SECRET_ACCESS_KEY`, `CLIPFORGE_S3_SESSION_TOKEN` (optional legacy static credential configuration; leave unset when using ECS task roles)

**All five continuous workers:**

- `DATABASE_URL`
- `CLIPFORGE_EXPECTED_DATABASE_HOST`
- `CLIPFORGE_EXPECTED_DATABASE_PORT`
- `CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST` (migration CLI only)
- `CLIPFORGE_EXPECTED_DATABASE_NAME`
- `CLIPFORGE_DEPLOYMENT_ENV`
- `CLIPFORGE_STORAGE_PROVIDER`
- `CLIPFORGE_S3_STAGING_BUCKET` or `CLIPFORGE_S3_PRODUCTION_BUCKET`, matching the task's explicit deployment environment
- `CLIPFORGE_S3_REGION`
- `AWS_REGION`

**Web and publishing worker for temporary publishing-media URLs; the worker also requires the explicit double opt-in flags:**

- `CLIPFORGE_PUBLISHING_ENABLED`
- `CLIPFORGE_PUBLISHING_LIVE_APPROVED`
- `INSTAGRAM_GRAPH_API_VERSION`
- `INSTAGRAM_TOKEN_KEY`
- `CLIPFORGE_PUBLIC_MEDIA_ORIGIN`
- `CLIPFORGE_TEMP_MEDIA_SIGNING_KEY`

The publishing worker exits without claiming jobs unless both opt-in flags are exactly `true`. It also requires the pinned Graph API version, token encryption key, HTTPS public media origin, and 32-byte temporary-media signing key. These sensitive values belong in the orchestrator secret store.

**Web-only features as enabled:**

- Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
- Instagram OAuth: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_OAUTH_REDIRECT_URI`, `INSTAGRAM_TOKEN_KEY`
- Razorpay: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_CREATOR_WEEKLY`, `RAZORPAY_PLAN_CREATOR_MONTHLY`, `RAZORPAY_PLAN_PRO_WEEKLY`, `RAZORPAY_PLAN_PRO_MONTHLY`, `RAZORPAY_PLAN_AGENCY_WEEKLY`, `RAZORPAY_PLAN_AGENCY_MONTHLY`, `RAZORPAY_SUBSCRIPTION_TOTAL_COUNT`, `RAZORPAY_CANCEL_AT_CYCLE_END`
- Email: `EMAIL_PROVIDER`, `EMAIL_FROM`; SES also needs `AWS_REGION` and uses the AWS SDK credential provider chain when a complete static key pair is absent. SMTP also needs `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.
- Public metadata: `NEXT_PUBLIC_SITE_URL`; trusted proxy configuration: `CLIPFORGE_TRUSTED_PROXY_HOPS` (set only to the actual proxy count after verifying deployment topology).

`DIRECT_URL` and `CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST` are for Prisma CLI migration workflows and are not needed by the running web or worker processes. Protected migration runs require the pooled and direct host pins, the database-name pin, and `CLIPFORGE_EXPECTED_DATABASE_PORT`; both URLs are checked for effective host/database/port and routing overrides. For local test migrations, set both `NODE_ENV=test` and `CLIPFORGE_DEPLOYMENT_ENV=test`; both URLs must target only `127.0.0.1:54836/clipforge_local_test`. This deliberately rejects PostgreSQL 16 on port 5432. Local development migrations remain explicitly configured by `DIRECT_URL`, have routing overrides rejected, and are not pinned to the test database. Do not run migrations from application startup. `REDIS_URL` is not used by the current job architecture; jobs and leases are PostgreSQL-backed. The app currently has no BullMQ/Redis dependency.

The web runtime invokes its fail-closed database identity guard before resolving runtime adapters. In staging and production, web and all five continuous workers require `CLIPFORGE_EXPECTED_DATABASE_HOST`, `CLIPFORGE_EXPECTED_DATABASE_PORT`, and `CLIPFORGE_EXPECTED_DATABASE_NAME`. PostgreSQL routing parameters are rejected and the URL's effective port must match the configured pin. Prisma migration commands additionally require `CLIPFORGE_EXPECTED_DIRECT_DATABASE_HOST` and independently validate `DIRECT_URL`; this check compares URL identity only and does not connect. Local development migration workflows remain unpinned unless production/staging mode is selected.

## Storage and IAM boundaries

S3 remains private through the existing `MediaStorage` abstraction. Development, staging, and production each use distinct variables: `CLIPFORGE_S3_DEVELOPMENT_BUCKET`, `CLIPFORGE_S3_STAGING_BUCKET`, and `CLIPFORGE_S3_PRODUCTION_BUCKET`. Staging requires `CLIPFORGE_DEPLOYMENT_ENV=staging` and fails closed if its own bucket is missing; it cannot fall back to development or production. Preview keeps the legacy development-bucket behavior. Production and staging require `NODE_ENV=production` and matching explicit deployment identity. The S3 client uses the AWS SDK credential provider chain when no ClipForge static key pair is configured, so ECS task roles are supported. Production/staging refuse the local-disk provider. `CLIPFORGE_LOCAL_MEDIA_DIR` is not a deployed media store. The Docker image defaults to production identity, so a staging task definition must explicitly override `CLIPFORGE_DEPLOYMENT_ENV=staging` and provide only the staging bucket and staging database pins.

Create separate least-privilege task roles. S3 object access should be restricted to the production bucket and required object prefixes (`media/*`, `thumb/*`, `staging/*`, `render/*`), with actions tailored per task. The current S3 adapter uses object `GetObject`, `PutObject`, `DeleteObject`, and `HeadObject` operations; avoid public access, ACL, bucket administration, and broad bucket listing. Do not grant KMS permissions unless the bucket's encryption design is explicitly changed and reviewed.

The web and worker temporary files are ephemeral and mode-restricted by existing storage code. Database rows, leases, retry state and S3 objects are durable; after task replacement, expired leases and idempotent job logic recover work. Do not mount `/tmp` as the permanent media volume.

## Health, logs, and shutdown

- Container liveness: `GET /api/health/live`; the Docker `HEALTHCHECK` polls it. The local ARM64 container smoke test returned HTTP 200 with a generic healthy status and did not contact dependencies.
- Load-balancer readiness: `GET /api/health/ready`; it returns generic `200`/`503` and checks database connectivity plus configured non-memory storage. The local smoke test without database configuration returned HTTP 503 with a generic not-ready status. Readiness does **not** perform an S3 object read or prove bucket IAM permissions, so separately exercise private storage in a controlled preproduction smoke test.
- Workers all use `runContinuousWorker`, stop claiming after `SIGTERM`/`SIGINT`, wait at most four minutes for the in-flight job, then dispose runtime storage and Prisma. If a job exceeds the bound, the process exits without disposal and relies on lease expiry/retry recovery.
- The orchestrator stop grace must be at least as long as the four-minute worker drain, or it may forcibly stop a task early. Verify the selected ECS launch type/platform supports the required grace interval before enabling worker services.
- Send stdout/stderr to CloudWatch Logs using a retention policy. Logs must not contain credentials or full database URLs. Alert on repeated worker failures, readiness failures, lease expirations, and jobs stuck beyond their retry windows.

## Proposed AWS resources (not created)

- ECR repositories: `clipforge-web`, `clipforge-media-verification-worker`, `clipforge-media-cleanup-worker`, `clipforge-media-replacement-worker`, `clipforge-render-worker`, `clipforge-instagram-publishing-worker`.
- ECS cluster: `clipforge-production`.
- ECS services: one web service and one independently deployable service for each continuous worker; start workers at one task each and scale only after PostgreSQL load and lease contention tests.
- Application Load Balancer with HTTPS listener, certificate, DNS record, and readiness target check on `/api/health/ready`.
- VPC, private application subnets, security groups, outbound connectivity endpoints/NAT as required, and a database connectivity path. Keep tasks non-public; scope ingress to the ALB and database access to the app/worker security group.
- CloudWatch log groups/retention and alarms; Secrets Manager or Parameter Store secure values; separate ECS task roles for web and workers.
- Production private S3 bucket (or an explicitly verified existing production bucket). The known bucket in the current setup is identified as a **development** bucket and must not be selected for production.
- If the database is also migrated off Neon, a separately planned PostgreSQL service (for example, RDS PostgreSQL), subnet groups, security policy, backups, and a verified data migration/cutover. No database destination is selected in this phase.

## Deployment prerequisites and rollback

1. Confirm the production database identity and production storage bucket independently; set the non-secret host/name pins for the web runtime and workers. Validate the runtime app and Prisma CLI URL purposes without displaying their values.
2. Review all pending schema migrations and production data risks. Apply reviewed migrations through a one-shot controlled migration job only after explicit approval; never run `db push` or migrations from web/worker entrypoints.
3. Build images in CI with a pinned base digest and lockfile; scan image contents and dependencies; publish to ECR; sign/record the exact digest. Keep secrets out of build context and build args.
4. Test each worker on a separate preproduction database and bucket containing synthetic media. Exercise SIGTERM during idle and during a leased job; confirm lease recovery after a forced task replacement.
5. Deploy the web service behind the ALB, verify liveness/readiness and private S3 operations, then enable workers individually. Keep Instagram publishing disabled until callback URLs, app approval, eligible account, quotas, and explicit live approval are confirmed.

Rollback should redeploy the previously recorded image digests and restore prior task definitions. Keep schema changes backward-compatible and use expand/contract sequencing; do not roll back by deleting data or reversing an applied migration blindly. If the database is moved, take and verify backups and rehearse point-in-time recovery and application cutback before production cutover.

## Current blockers and unverified items

- Six Linux ARM64 images (web plus five workers) were built locally, but this document does not independently attest to their current presence; image sizes, contents, and binary checks are recorded in the Phase 2.2A verification report.
- Liveness returned HTTP 200 and readiness returned HTTP 503 in the local no-database smoke test. Successful readiness, database reachability, S3 IAM permissions, and private object operations require staging verification.
- Next.js standalone behavior under the target orchestrator, task shutdown duration, ephemeral storage sizing, and application callback/webhook URLs require preproduction verification.
- Staging storage isolation and Prisma migration identity preflight are implemented locally but have not been exercised against any live staging resources. No AWS resources have been created.
- Instagram publishing must remain disabled by default in staging; only enable it after separate explicit approval and verified isolated callback/configuration setup.
- No AWS service prices, Free Plan eligibility, or current ECS limits are asserted here.
