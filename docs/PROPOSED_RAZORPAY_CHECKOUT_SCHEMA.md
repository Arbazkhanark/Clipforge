# Razorpay recurring and manual checkout schema

This document describes the additive schema in `prisma/schema.prisma` and SQL in migrations `20261107080000_recurring_razorpay_subscription_intents`, `20261107090000_manual_payment_access`, `20261107091000_recurring_auto_renew_consent`, and `20261107092000_subscription_continuation`. Earlier project documentation described these migrations as unapplied, but their actual status has not been checked in any target database. Creator is ₹499 weekly/₹1,999 monthly, Pro ₹999/₹3,999, Agency ₹1,499/₹5,999. Free is ₹0 permanently.

## Durable ownership and idempotency

`RazorpaySubscriptionIntent` records the authenticated user, catalog plan, interval, exact amount in paise, configured Razorpay plan ID, idempotency key, provider subscription ID, and affirmative auto-renew consent timestamp/version. A composite FK from `PaymentRecord(subscriptionIntentId,userId)` to the intent prevents a payment belonging to one user from being attached to another user's plan intent. The migration also checks that the persisted price matches the approved catalog. Provider IDs are unique; `(userId,idempotencyKey)` is unique.

The intent statuses are `creating`, `created`, `active`, `failed`, `manual_review`, `cancelled`, and `expired`. A request that finds an existing `creating` intent must not call the provider again: the previous request might have succeeded remotely while its response was lost. Such intents require provider reconciliation and otherwise stay in manual review. Never retry ambiguous subscription creation automatically.

## Manual one-time access

Manual renewal is represented separately by `ManualPaymentIntent` and `ManualPlanAccess`; it does not use a recurring `Subscription` row. Intent uniqueness is `(userId,idempotencyKey)` and provider Payment Link IDs are unique. The payment record carries an owner-bound FK to either the recurring intent or the manual intent; database CHECK constraints enforce that at most one of those links is present. `ManualPlanAccess` has a unique intent and provider payment ID, exact `startsAt`/`expiresAt`, and an owner-bound composite FK to its intent. A verified captured payment creates the payment record, period grant and `paid` intent in one transaction. Replays cannot extend or duplicate the grant.

Weekly manual access ends exactly seven days after the provider payment timestamp. Monthly access adds one calendar month and clamps to the month's final day (including leap years). Entitlement queries check the half-open period `[startsAt, expiresAt)`. Conflicting active paid access and unresolved checkout intents block a new billing mode. An active recurring subscription is not cancelled automatically to permit manual checkout, and a manual payment cannot replace it before its paid period ends.

Manual checkout uses a standard one-time Razorpay Payment Link with partial payment disabled. Server verification retrieves both the link and payment from Razorpay's authenticated API and checks the local intent reference, captured full amount, currency and payment ID. The signed `payment_link.paid` webhook can also create the same grant idempotently. Checkout remains disabled unless sandbox API credentials and a webhook secret are configured.

`Subscription` remains the single current entitlement record per user. Its composite foreign key `(razorpaySubscriptionId,userId,planId,interval)` points to the matching intent, so a provider subscription cannot be bound to a different owner or plan. `PaymentRecord` links each charge to an intent with the same owner; the intent identifies the exact provider subscription and product. No access credentials belong in these records. The added `cancelAtPeriodEnd` records cancellation policy; entitlement ends only when Razorpay confirms the effective cancellation/period boundary.

## Migration prerequisites and rollback

Prerequisites before a separately approved rollout:

1. Back up the database and confirm the deployed Prisma schema/migration history matches the parent migration.
2. Generate and review the Prisma client from this schema; run schema/migration validation against a disposable database first.
3. Configure Razorpay **test-mode** plan IDs for each paid plan/interval. Verify each provider plan's frequency and amount against the catalog. Do not configure live keys for these routes.
4. Deploy code that can tolerate existing subscriptions with null linkage; existing rows remain unchanged.

The migrations are additive. The recurring migration adds the subscription intent/status enum, cancellation flag and owner-bound payment relation, plus `manual_review` linkage rows for historical subscriptions. The manual migration adds the manual intent/status enum, period-grant table and nullable manual intent FK on `PaymentRecord`. The consent migration adds nullable timestamp/version columns so existing intents remain valid. Existing user, subscription, payment and webhook rows are preserved; legacy payments remain unlinked until reconciled. The migrations must run in timestamp order. Rollback is not a blind down migration: disable checkout/webhook writes, preserve intent/payment/grant records for reconciliation, and review whether code can roll back while leaving additive schema in place. Dropping these tables or columns would destroy payment audit and idempotency history and is not recommended.

The continuation migration adds a nullable cancellation-request timestamp and an append-only-per-period continuation attempt table. It preserves existing provider subscription IDs and payment rows. The worker changes the existing provider subscription's documented `remaining_count`; it does not create a second subscription. A unique `(subscriptionId, cycleEnd)` constraint prevents concurrent duplicate attempts for one billing period. A failed or uncertain update is left in `manual_review` and must not be retried automatically. Cancellation intent is stored before the provider cancellation request so continuation claims fail closed.

## Activation and event policy

A browser redirect or callback is not evidence of payment. Only a valid raw-body signed webhook (or an independently fetched and verified provider state) may activate/update entitlements. Every payment is checked against the persisted provider subscription ID, provider plan ID, catalog amount, user-bound intent and local subscription before recording it. Events are deduplicated by Razorpay event ID and older events do not overwrite newer state.

Paid entitlements apply while the provider status is active or pending only under the documented grace policy. Payment failure moves the subscription to pending during that policy; halted/cancelled/completed/expired remove paid access. Cancellation-at-period-end retains access only through the provider-confirmed current period end. Period end must come from verified provider data, not local arithmetic. Configure Razorpay cancellation semantics explicitly and test them in sandbox.

## Runtime and remaining constraints

The server now has test-key-only create, verify, cancel and webhook paths, plus owner-bound intent/payment repository operations. All create requests read amount from the plan catalog, fetch the configured provider plan and verify its amount/cadence before creating a subscription. A browser verification response only reports `awaiting_webhook`; it does not grant entitlements. Network/invalid provider outcomes become `manual_review` and are never automatically retried.

The API requires a finite `total_count` or `end_at`. Current configuration uses `RAZORPAY_SUBSCRIPTION_TOTAL_COUNT`, so each provider subscription will eventually complete at that configured count. For the intended cancel-until-ended product behavior, choose a sufficiently high count and design/test a renewal/extension workflow before it approaches completion. This is a production blocker; do not imply unlimited renewal. Sandbox plan frequency/amount, cancellation timing, webhook payload variants, SQL migration/FK behavior and payment lifecycle remain unverified against a real sandbox account/database. No one-time order checkout may grant a recurring plan.

The continuation runner reads authoritative `total_count`, `paid_count`, `remaining_count`, status and period end from Razorpay. At ten or fewer remaining cycles, it reserves one local attempt for the period and updates the existing subscription's `remaining_count` to the documented 100-year ceiling. This keeps one provider subscription ID and does not create overlapping subscriptions. If the update times out, returns inconsistent state, or has already reached the 100-year maximum, the record requires manual review. Razorpay documents that subscription updates are not supported for some payment modes, including UPI; those cases must remain in manual review. The one-shot command is disabled unless `CLIPFORGE_SUBSCRIPTION_CONTINUATION_ENABLED=true` and requires external scheduling. Since Razorpay's published maximum is 100 years, this cannot guarantee literally unbounded continuation after that point. The API/database operation has only fake-provider/fake-Prisma verification so far.
