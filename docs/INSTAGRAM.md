# Instagram login and publishing

Reviewed 9 November 2026. Source code and mocked tests were inspected; no Meta account was connected and no live publishing or provider verification was performed. The worker is disabled unless the operator explicitly enables and approves it.

## Official pages

| Topic | URL | Page date |
| --- | --- | --- |
| Business Login for Instagram | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login | Updated Mar 13, 2026 |
| Oauth Authorize | https://developers.facebook.com/docs/instagram-platform/reference/oauth-authorize | Updated Jul 17, 2025 |
| Content Publishing | https://developers.facebook.com/docs/instagram-platform/content-publishing | Updated Oct 20, 2026 |
| IG User Media | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media | Updated Sep 28, 2026 |
| Graph API rate limiting | https://developers.facebook.com/docs/graph-api/overview/rate-limiting | No Updated date on the extracted page |

## What those pages confirm

Business Login for Instagram uses `https://www.instagram.com/oauth/authorize`, then `https://api.instagram.com/oauth/access_token` for a short-lived token, then `https://graph.instagram.com/access_token` with `grant_type=ig_exchange_token` for a long-lived token. The long-lived token is described as valid for 60 days, and a refresh endpoint can extend a valid long-lived token. The authorize parameters on that page are `client_id`, `redirect_uri`, `response_type=code`, `scope`, and optional `state`, plus `enable_fb_login` and `force_reauth`. The redirect URI must exactly match a URI saved in the app dashboard. `state` is documented as a CSRF value that Meta returns on the redirect.

The Oauth Authorize reference uses `https://api.instagram.com/oauth/authorize` and lists `client_id`, `redirect_uri`, `response_type`, `scope`, and optional `state`. It does not list PKCE. Business Login does not list PKCE either. ClipForge follows the Business Login host and does not send `code_challenge` or `code_verifier`.

A canceled login redirects with `error=access_denied`. Authorization codes are documented as valid for 1 hour and usable once.

Publishing is for Instagram professional accounts. The publishing guide does not list the profile `account_type` strings. ClipForge accepts only exact `BUSINESS` and `MEDIA_CREATOR` values and rejects personal, unknown, missing, malformed, and unsupported values.

Business Login names these scopes: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_messages`, and `instagram_business_manage_comments`. ClipForge requests the first two. The Facebook Login path is a different permission set and is not used.

Meta's maintained [Reels Publishing API sample](https://github.com/fbsamples/reels_publishing_apis/blob/main/insta_reels_publishing_api_sample/README.md) documents `GET /{ig-user-id}/content_publishing_limit` and recommends enforcing quota before publishing. That sample says 25 posts per rolling 24 hours; the current Content Publishing guide has also reported 100 and a carousel section has reported 50. These published numbers conflict. ClipForge therefore treats its 100-post value only as a non-blocking local schedule estimate. The real adapter queries the account-specific endpoint immediately before `media_publish`, uses the returned total/duration when the response has the expected shape, and blocks publishing if the result is full, malformed, denied, or unavailable. The endpoint's current permission requirements and response shape have not been verified against a live app; the adapter fails closed if its expected `data[0].quota_usage` and `data[0].config.{quota_total,quota_duration}` values are absent or invalid. The official Meta documentation page returned HTTP 429 during this review, so this response shape must be confirmed in a non-production app before live enablement.

The same guide says Meta fetches the media, so it must be on a public URL at publish time. Containers expire after 24 hours. The IG User Media page says an account can create 400 containers in a rolling 24 hours. Page Publishing Authorization can block a professional account until it is completed.

## Private storage and temporary access

Original uploads remain in private memory or local-disk storage and are served only through the existing authenticated, owner/collection-authorized routes. Temporary publishing access can be minted only for a server-authorized `MediaDerivative` render output whose owner, running cycle, due cycle item, source-media relationship, source permission, and stored byte size all match. Passing an original `MediaAsset` id is not sufficient. A selected Reel cover additionally must be an active JPEG owned by the cycle owner, be at most 8,000,000 bytes, and match private-storage metadata. It is exposed only through an expiring signed URL scoped to that owner, cycle, and cycle item; the route rechecks that the image is still selected and eligible before streaming it. Storage keys and paths are never returned to Meta or the browser.

The mock adapter uses `https://media-access.mock.invalid/` URLs and always reports `publiclyReachable: false`. Those URLs are not fetchable and must never satisfy Meta's public-media requirement. Publishing requires an explicitly selected rendered output; the worker never falls back to the original video.

A deployment must configure the public HTTPS media origin and signing key, verify that Meta can fetch both signed media routes through its public network path, and ensure the 5-minute signed URL lifetime is adequate for Meta's media fetch and processing. The repository hosts a signed route rather than configuring an external storage provider. No public reachability was tested from Meta's network.

The Meta-maintained Reels sample documents the `cover_url` and `thumb_offset` parameters. It says a custom `cover_url` must be publicly fetchable, and when both parameters are sent, `cover_url` takes precedence and the offset is ignored. ClipForge sends the saved JPEG cover through `cover_url`. There is no persisted `thumb_offset` field or user control, so ClipForge does not currently send that parameter. If a trusted caller supplies an offset to the adapter, it is range-validated and sent, but both parameters together mean Meta uses the cover URL. Actual cover display has not been live-tested.

Graph API rate limiting is a separate call limit. Instagram Platform requests use Business Use Case limits. The page gives `Calls within 24 hours = 4800 * Number of Impressions`. That is not the publishing post quota.

## Unknown

Caption length, hashtag count, App Review requirements for non-test users, and whether resumable upload works for Instagram Login remain unverified. The 300MB unit is not defined. Published quota numbers differ; use the live endpoint result, not the local estimate. The current Graph API version is operator-pinned and must be validated against the app's access and Meta's current version support.

## Login security in this repo

The start route checks the session, then the server config. It sets an HttpOnly `state` cookie for 10 minutes and records the state with the initiating user in a process-local one-use registry. The callback requires the cookie and query state to match with `timingSafeEqual`, consumes the state before processing a provider error or code, and verifies the same user session is still active. It clears the cookie on success and failure. `access_denied` becomes a fixed cancel message. Other provider errors become a fixed error. The redirect does not include the code, state, or token. Replay protection is process-local; a multi-process deployment needs a shared atomic state store before OAuth is enabled there.

The redirect URI must be HTTPS, or HTTP on localhost or 127.0.0.1, and the path must end with `/api/instagram/callback`. The value sent to Meta is that configured URI.

The short-lived token is exchanged for a long-lived token. Expiry comes from `expires_in`. Only explicit supported professional account types and required scopes are accepted. Tokens are AES-256-GCM ciphertext with a `v1` prefix and a validated 32-byte key. The key is `INSTAGRAM_TOKEN_KEY`; replacing it makes old ciphertext unreadable. Tokens are not returned to the browser or written in audit metadata. Publishing obtains a token through a server-only owner/account-scoped access function. Token refresh is not automatically performed by the publishing worker; expired or unreadable credentials block publishing and require reconnection.

## Publishing rules already in the app

Scheduling order is per account: scheduled time, then position, then id. The idempotency key is `publish:<cycleId>:<itemId>`. A success, an ambiguous result, or an in-progress attempt does not start another upload. A definite failure can be tried again only after the item is claimable. Ambiguous results are not auto-retried.

The pause threshold is 3 definite failures in a row. That number is a ClipForge rule. The count is the trailing `definite_failure` outcomes on stored `PublishingJob` rows for that user's cycles on that account. In-progress rows are skipped. A success or an ambiguous result ends the streak. The cycle screen shows the count, the threshold, the account status, token expiry, missing scopes, and the pause reason.

Repeat mode is `never`, `ask`, or `automatic`. The default is `never`. Automatic is the only mode that may queue another round, and that round can include only items that are not published, publishing, or processing. Saving the mode does not send a Reel. A stopped or completed cycle cannot change the mode. The owner id comes from the session.

## Current adapter and worker

The real adapter in `src/server/publishing/instagram-publishing-adapter.ts` implements these calls against the operator-pinned `https://graph.instagram.com/{version}` origin:

- `POST /{ig-user-id}/media` with `media_type=REELS`, the selected rendered `video_url`, caption, and (when selected) the signed public `cover_url`.
- `GET /{container-id}?fields=status_code,status` to poll processing.
- `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` before every publish. Unknown response shape, API denial, network errors, or full quota prevent `media_publish`.
- `POST /{ig-user-id}/media_publish` only after a finished container and a verified available quota.

`thumb_offset` is supported by the adapter interface but not stored by the current cycle-item model or UI. Saved covers use `cover_url`; if both are ever passed, Meta's maintained sample says the URL takes precedence.

The durable worker is started separately with `npm run worker:publishing` under the repository's pinned Node 22. It runs continuously until SIGINT/SIGTERM. It requires database mode, private media storage, a pinned `INSTAGRAM_GRAPH_API_VERSION`, token encryption setup, public-media origin/signing configuration, and both `CLIPFORGE_PUBLISHING_ENABLED=true` and `CLIPFORGE_PUBLISHING_LIVE_APPROVED=true`. Those flags are explicit operational gates, not evidence that provider access is approved. The worker must be supervised as its own process; the Next.js server does not start it automatically.

Publishing attempts are durable and leased. Container creation is not repeated after an ambiguous response. Publish success is persisted only when the provider returns a media id. Ambiguous publishing outcomes are not retried: the adapter's current verification method returns `unknown`, so those attempts remain in manual review. There is no automatic authoritative reconciliation/recovery for them. Do not treat worker mocks, fake-Prisma tests, or successful local HTTP handling as proof of Meta permissions, quota response compatibility, public media fetchability, or live publishing.
