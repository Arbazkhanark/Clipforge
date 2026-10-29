# ClipForge Architecture (current + intended)

## What exists today
```
prisma/schema.prisma          Database design (draft, not validated by Prisma, not migrated)
prisma/manual-constraints.sql Extra DB constraints Prisma cannot express (not applied)
src/lib/billing/              Plans/prices (paise), limits, Razorpay signatures, subscription state machine
src/lib/domain/               PURE business rules (no DB, no network, no Redis):
  types.ts                    Shared data shapes + status lists (checked against the Prisma enums by a test)
  sharing-permissions.ts      Who may view/use/import/download; share links (hashed tokens); access requests; grant revocation
  mix-unmix.ts                Add owned+shared videos to a cycle; reorder upcoming; unmix (cancel the item, never delete media)
  caption-cover-updates.ts    Single/bulk caption + cover changes for UPCOMING items only; version checks; honest per-item reports
  cycle-state.ts              Cycle + item status machines; claiming an item (lock); outcomes; restart recovery
  media-lifecycle.ts          Import (warning, idempotent, verified, charged only on success); owner deletion, grace period, safe S3 delete gate
  preflight.ts                Smart Publishing Assistant: Ready / Recommendation / Action Required / Blocked
  usage-accounting.ts         Idempotent usage records; shared references add no source storage; failed renders charge nothing (assumption)
  sharing-management.ts       Who may create/revoke grants; expiring grants; delegated managers (limits); recipient caps
  schedule.ts                 Publish-time slots from interval/days/window/timezone/daily max/end date; attach slots to items
  ordering.ts                 Queue order modes; persisted seeded shuffle
src/server/                   runtime.ts (modes + adapters), queries.ts (safe view models), http.ts (Request->Response, CSRF), page-data.ts, demo-data.ts, preflight-service.ts; request layer: errors.ts, validation.ts, repository.ts (interface), memory-repository.ts (tests), context.ts, handlers/ (captions-covers, sharing, cycles)
src/lib/integrations/         instagram-capabilities.ts: verified Instagram facts, quota + container rules (no network calls)
src/lib/render/               ffmpeg-command.ts (pure command + validation), render-runner.ts (runs ffmpeg/ffprobe in a WORKER)
src/components/               React components with no client-only code (pricing, usage meter, cycle table, preflight, schedule preview, import warning)
app/                          Next.js App Router: (app)/ signed-in screens, login, register, pricing, api/ route handlers (never run under Next here)
tests/                        node:test suites (+ UI tests via react-dom/server). Run: npm test
```

## How the pieces will fit together (later phases)
Server code loads rows from PostgreSQL -> calls a pure rule -> saves the result with a compare-and-set
(`UPDATE ... WHERE id = ? AND version = ?`). Because the rules are pure, they are testable without a database.

### Shared collections and permissions
A collection has an owner and a visibility (private / link / public_view). Other people get a `CollectionPermission` row with
capabilities (`view`, `use_in_cycle`, `import_copy`, `download`, `manage`). Public view only ever gives `view`.
Permission is **re-checked** when adding to a cycle, before rendering, before publishing, and before import completes.

### Using a shared video without copying it
A `CycleItem` points at the owner's `MediaAsset` (`sourceKind = shared_reference`). No second S3 object exists.
Recipient edit settings live on the `CycleItem`; the source is never modified. Revoked permission => item goes to `needs_review`.

### Importing
`planImport` (warning acknowledged, permission, storage space, no duplicate job) -> copy -> verify (exists, size, checksum) ->
`completeImport` re-checks permission. Storage is charged only on success; failures return an object key to clean up.

### Owner deletes a shared video
`findMediaDependencies` -> `planOwnerDeletion` -> owner chooses (cancel / grace period) -> `scheduleDeletionWithGracePeriod`
(real `deleteAfter`, one notification per affected user) -> after the date `blockItemsForRemovedSource` -> the cleanup job may
delete the S3 object ONLY if `canPhysicallyDeleteMedia` says nothing in flight needs it. Database FKs to media use `Restrict`.

### Captions, covers and running cycles
Only `upcoming`/`scheduled` items change. Every change carries the item's `version`; a worker claiming an item bumps the version,
so a late edit becomes a reported *conflict* instead of racing the publish. Covers become `saved_internally`; only the publisher
may ever set `applied_on_instagram`.

### Publishing safety
Pause stops new claims. Ambiguous publish results go to `needs_review` and are never auto-retried. After a crash, stale
`publishing` items go to `needs_review`; stale `processing` items are redone.

### Rendering
A worker (never a web request) loads the source, calls `buildRenderArgs` (all settings validated; colours must be `#RRGGBB`;
no shell is used), runs FFmpeg with `-progress`, then `validateRenderOutput` (codec, size, duration). Only a validated output
counts as success; `buildRenderUsage` then records usage. The main-video border is padded onto the video itself before it is
placed on the canvas, so it never surrounds the whole canvas (verified by sampling real pixels).

### Server request layer
Every handler runs the same steps: signed-in user (from the session, never the body) -> validate input (all problems at once) ->
load -> **ownership** (someone else's object looks like a missing one: 404) -> **plan limits** (sharing uses the *collection owner's*
plan) -> business rule -> **version-checked save** (like `UPDATE ... WHERE version = ?`; a lost race is reported as a conflict,
never overwritten) -> audit log -> a per-item report. Starting a cycle uses a status compare-and-set so two requests cannot both win.

### Screens -> data (layering)
`app/**/page.tsx` (server components) -> `loadPageData` -> `queries.ts` (permission checks, whitelisted view models) -> `Repository`
interface -> adapter chosen by `runtime.ts` (today: in-memory demo data, or a repository that refuses every call). Components in
`src/components` only receive view models; they never see storage keys, URLs or other users' ids. Mutations go through
`app/api/**/route.ts` -> `jsonRoute` -> the tested handlers.
