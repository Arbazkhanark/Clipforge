# Instagram login and publishing

Read on 6 November 2026. Nothing in this file calls Meta. ClipForge does not create a Meta app, connect a real account, publish a Reel, or host a public media URL.

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

Publishing is for Instagram professional accounts. The publishing guide does not list the profile `account_type` strings. ClipForge still stores `BUSINESS`, `MEDIA_CREATOR`, and `PERSONAL` only when the profile response uses those words, and it refuses `PERSONAL`.

Business Login names these scopes: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_messages`, and `instagram_business_manage_comments`. ClipForge requests the first two. The Facebook Login path is a different permission set and is not used.

Content Publishing says accounts are limited to 100 API-published posts within a 24-hour moving period, enforced on `POST /<IG_ID>/media_publish`. Carousels count as one post. The same page's carousel section still says 50 published posts within a 24-hour period. Both sentences were present on the 20 October 2026 page. `GET /<IG_ID>/content_publishing_limit` is the live usage check. ClipForge does not call it. The app-side check uses 100 until that live value exists, and the screen says the carousel sentence still says 50.

The same guide says Meta fetches the media, so it must be on a public URL at publish time. Containers expire after 24 hours. The IG User Media page says an account can create 400 containers in a rolling 24 hours. Page Publishing Authorization can block a professional account until it is completed.

IG User Media, updated 28 September 2026, says a Reel is MOV or MP4, duration 3 seconds minimum and 15 minutes maximum, file size 300MB maximum. It does not define whether MB is 1000² or 1024². ClipForge compares against 300 × 1024 × 1024 bytes. A Reel cover is JPEG, 8MB maximum. Whether `cover_url` or `thumb_offset` wins when both are sent is unknown.

Graph API rate limiting is a separate call limit. Instagram Platform requests use Business Use Case limits. The page gives `Calls within 24 hours = 4800 * Number of Impressions`. That is not the publishing post quota.

## Unknown

Caption length, hashtag count, which Graph API version to pin, App Review requirements for non-test users, and whether resumable upload works for Instagram Login are not confirmed. The 300MB unit is not defined. The 100-versus-50 publishing sentences are both still on the page.

## Login security in this repo

The start route checks the session, then the server config. It sets an HttpOnly `state` cookie for 10 minutes. The callback compares that cookie with `timingSafeEqual`, then clears it on success, cancel, and error. `access_denied` becomes a fixed cancel message. Other provider errors become a fixed error. The redirect does not include the code, state, or token.

The redirect URI must be HTTPS, or HTTP on localhost or 127.0.0.1, and the path must end with `/api/instagram/callback`. The value sent to Meta is that configured URI.

The short-lived token is exchanged for a long-lived token. Expiry comes from `expires_in`. A personal account or a response missing the two publishing scopes is not stored. Tokens are AES-256-GCM ciphertext with a `v1` prefix. The key is `INSTAGRAM_TOKEN_KEY`. There is no second key. Replacing the key makes old ciphertext unreadable, and the account must be connected again. Tokens are not returned to the browser or written in audit metadata.

## Publishing rules already in the app

Scheduling order is per account: scheduled time, then position, then id. The idempotency key is `publish:<cycleId>:<itemId>`. A success, an ambiguous result, or an in-progress attempt does not start another upload. A definite failure can be tried again only after the item is claimable. Ambiguous results are not auto-retried.

The pause threshold is 3 definite failures in a row. That number is a ClipForge rule. The count is the trailing `definite_failure` outcomes on stored `PublishingJob` rows for that user's cycles on that account. In-progress rows are skipped. A success or an ambiguous result ends the streak. The cycle screen shows the count, the threshold, the account status, token expiry, missing scopes, and the pause reason.

Repeat mode is `never`, `ask`, or `automatic`. The default is `never`. Automatic is the only mode that may queue another round, and that round can include only items that are not published, publishing, or processing. Saving the mode does not send a Reel. A stopped or completed cycle cannot change the mode. The owner id comes from the session.

## Future publishing worker

This is a design only. Do not build it until a public media URL exists and a Meta app is configured outside this phase. Redis and BullMQ are not installed. The durable queue is the database: one `PublishingJob` row per attempt, claimed with the existing cycle-item lock.

- One account publishes one item at a time. A claim for an account waits while that account has an in-progress job.
- Do not create a container until the item is inside the documented container window. Containers expire after 24 hours.
- Create the container, poll `status_code` about once a minute, and stop after the documented 5 minutes.
- Call `media_publish` only after the container is `FINISHED`. Mark the item published only when the status is `PUBLISHED`.
- `ERROR` is a definite failure. `EXPIRED` can create a new container. Any other status needs review and must not be retried automatically.
- If the publish response is missing or unclear, store `ambiguous` and stop. Check the container or the published media before any new upload. Do not create a second container for that item while the result is ambiguous.
- Use the same idempotency key. A repeated claim returns the existing job.
- Before a claim, pause when the account is expired, revoked, or disconnected, or when the stored failure streak is 3 or more. Do not cancel an item that is already in progress. Recovery of a stale lock sends that item to review.
- Repeat only when the saved mode is automatic, and only with eligible unpublished items.
- Logs may include the cycle id, item id, job id, and status code. They must not include tokens, the encryption key, storage keys, or raw Meta bodies.

Live publishing stays off until that worker exists. The screens say so.
