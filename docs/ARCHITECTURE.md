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
src/server/auth/              password.ts (scrypt), tokens.ts (hashed tokens, cookies), rate-limiter.ts, email.ts (interface + memory outbox), auth-service.ts, auth-repository.ts, memory-auth-repository.ts, auth-routes.ts, page-cookies.ts
src/server/prisma/            prisma-client-like.ts (narrow documented slice), mappers.ts, prisma-repository.ts, prisma-auth-repository.ts, create-client.ts (UNVERIFIED real client factory)
src/server/storage/            media-storage.ts (interface, key rules, descriptions), local-disk-storage.ts, memory-storage.ts, media-inspection.ts (signatures, filenames, ffprobe)
src/server/handlers/media-upload.ts   the upload workflow
src/server/handlers/media-serve.ts    thumbnail/preview/download serving; media-route.ts is the GET route
src/server/handlers/editor.ts         save editing templates; src/lib/domain/editing-settings.ts validates/shapes them
src/lib/domain/media-access.ts        who may fetch which form of a file
src/server/flash.ts, form-routes.ts, form-handlers.ts, upload-route.ts   HTML form posts -> handlers -> redirect with whitelisted messages
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

### Upload workflow
signed in -> input shape -> size cap -> real type from the file's first bytes (browser MIME must agree) -> early plan-quota check (no bytes
written if it cannot fit) -> **stage** under `staging/<id>` -> ffprobe (if installed; otherwise "incomplete") -> **commit** to
`media/<userId>/<mediaId>` (never overwrites) -> record created **atomically within the quota** (`addMediaIfStorageWithin`) -> audit.
Keys come only from validated ids; the user's file name becomes a sanitised display title and is never part of a path. Failures remove only
this upload's staged/just-committed file; **existing media is never touched** and nothing is deleted automatically.

### Forms
`<form method=post action=/api/forms/...>` -> `formRoute` (same-origin check, size cap) -> the tested handler -> `303` to a page with
`?notice=<code>` or `?error=<code>`. Codes map to fixed sentences (`flash.ts`); user text is never echoed. One form wraps the cycle items
table; buttons use `formAction` to choose caption / cover / remove. Hidden `version.<id>` fields carry the item versions the user saw.

### Media access (preview / download / thumbnail)
`GET /api/media/file?id=&variant=` -> signed in? -> load the media -> (non-owner) load every collection containing it + grants ->
`decideMediaAccess` -> a denial is the SAME 404 as a missing file -> storage key comes from the repository, never from the client ->
stream (ranges supported) with `nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: sandbox`, `CORP: same-origin`.
Nothing is cached "as allowed": revoking a grant, expiry, deletion and the end of a grace period take effect on the next request.
Owner: thumbnail, preview, download. Recipient: thumbnail with any valid grant; the ORIGINAL only with `download`.

### Editor
Settings (aspect, background, zoom, offsets, border, logo-by-media-id) are validated with the renderer's own rules and saved as an
`EditingTemplate` (JSON) - never inside a media record. `computeRenderLayout` is the single geometry function used by BOTH the real FFmpeg
command and the preview sketch; a test samples a real render's pixels at the sketch's predicted positions. The resolution cap comes from the plan.

### Persistence plan
`Repository` and `AuthRepository` are interfaces with two implementations each (memory, Prisma). `tests/contracts/*.contract.ts` run against
every implementation; when PostgreSQL is available the same suites will run against the real Prisma client (see FIRST_RUN_CHECKLIST).
