# Roadmap

Updated 2026-11-07 to match the current working tree. Do not assume its uncommitted changes are present on another checkout.

## Current local MVP

Local auth and outbox flow work in the Next.js app without a database or email provider. Media, editing/rendering, collections, cycles, schedule setup, render-output selection, preflight, Instagram OAuth handling, and mock publishing foundations are implemented to varying levels. Automated tests and typecheck pass; a clean temporary production build passes. Browser automation is currently unavailable because the configured Playwright module path is missing.

## Priority order

0. **Permanent complimentary access controls.** Keep grants separate from paid subscriptions; allow verified admins to grant, hold, resume, and revoke with append-only audit history. The current implementation is pending migration and verification; do not enable before migration review and local testing.

1. **Verify migration history, then review persistence on the isolated PostgreSQL test database.** The render-queue/outbox, publishing-attempt, and render-output-selection migrations are present in the working tree. Earlier project docs described them as unapplied, but actual database history is unknown. A read-only history check is blocked until an administrator provides a verified read-only role and protected credential source. After history is verified, review schema/SQL and retained test-data implications; obtain separate explicit approval before any migration or database test. Never point local testing at Neon.
2. **Finish storage and durable worker deployment design.** Current render queue and publishing worker are not automatically triggered; local render jobs are process-memory-backed. A real hosted worker and persistent media storage need separate design and approval.
3. **Only then enable real Instagram publishing.** Requires approved Meta app credentials, permission/app-review readiness, externally fetchable object-scoped media URLs, real PostgreSQL verification, and an operator-reviewed retry/recovery policy. Ambiguous outcomes must stay in manual review.
4. **Complete remaining sharing workflows.** Add access-request decisions, imports, and owner-deletion workflows only with ownership and permission rechecks.
5. **Payment integration remains separate.** Build Razorpay checkout/webhook flow only after explicit approval and test credentials. Never grant paid entitlements from mock results.

## Not production-ready

No migrations were run during this sprint. Real PostgreSQL repository concurrency, Meta OAuth/publishing, public media delivery, production email, payment calls, automatic workers, and browser automation remain unverified or unavailable. No deployment or cloud resource is configured.
