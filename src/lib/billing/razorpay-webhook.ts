// Turns a raw Razorpay webhook request into something the subscription state machine can use.
// VERIFIED against Razorpay's official docs (2026-10-28):
//   - signature = HMAC-SHA256(raw body, webhook secret), hex, in the X-Razorpay-Signature header
//   - duplicates are detected with the x-razorpay-event-id header
//   - subscription events: authenticated, activated, charged, pending, halted, cancelled
// NOT verified on the official events page we read (named only in a third-party plugin's list):
//   subscription.paused, subscription.resumed, subscription.completed - kept, but treat as provisional.
import { verifyRazorpayWebhook } from "./razorpay-signature.ts";
import type { SubscriptionStatus } from "./subscription-state.ts";

export const WEBHOOK_EVENT_TO_STATUS: Record<string, SubscriptionStatus> = {
  "subscription.authenticated": "authenticated",
  // Activation/authentication alone is not a captured charge; paid access waits for subscription.charged.
  "subscription.activated": "authenticated",
  "subscription.charged": "active", // a successful charge means the subscription is active
  "subscription.pending": "pending",
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.paused": "paused",       // provisional
  "subscription.resumed": "active",      // provisional
  "subscription.completed": "completed", // provisional
  "subscription.expired": "expired",
  "payment.failed": "pending",
};

export type WebhookInterpretation =
  | { kind: "rejected"; reason: "bad_signature" | "missing_event_id" | "invalid_body" }
  /** Authentic but not a subscription event we act on (e.g. payment.captured). Record it and answer 200. */
  | { kind: "ignored"; eventId: string; event: string }
  | { kind: "subscription_event"; eventId: string; event: string; subscriptionId: string; newStatus: SubscriptionStatus; createdAt: number; currentPeriodEnd?: number; payment?: { id: string; amount: number; currency: string; status: string } }
  | { kind: "manual_payment_event"; eventId: string; intentId: string; paymentLinkId: string; amount: number; currency: "INR"; };

export function interpretRazorpayWebhook(args: {
  rawBody: string | Buffer; signatureHeader: string | null | undefined; eventIdHeader: string | null | undefined; webhookSecret: string;
}): WebhookInterpretation {
  // 1. Signature FIRST, on the exact raw bytes. Nothing in the body is trusted before this passes.
  if (!verifyRazorpayWebhook(args.rawBody, args.signatureHeader, args.webhookSecret)) return { kind: "rejected", reason: "bad_signature" };
  const eventId = (args.eventIdHeader ?? "").trim();
  if (eventId === "") return { kind: "rejected", reason: "missing_event_id" };

  let body: unknown;
  try { body = JSON.parse(args.rawBody.toString()); } catch { return { kind: "rejected", reason: "invalid_body" }; }
  if (typeof body !== "object" || body === null) return { kind: "rejected", reason: "invalid_body" };
  const record = body as { event?: unknown; created_at?: unknown; payload?: { subscription?: { entity?: { id?: unknown; current_end?: unknown } }; payment?: { entity?: { id?: unknown; amount?: unknown; currency?: unknown; status?: unknown; subscription_id?: unknown } }; payment_link?: { entity?: { id?: unknown; reference_id?: unknown; status?: unknown; amount?: unknown; amount_paid?: unknown; currency?: unknown; paid_at?: unknown; payments?: { payment_id?: unknown; amount?: unknown; status?: unknown; created_at?: unknown }[] } } } };
  if (typeof record.event !== "string") return { kind: "rejected", reason: "invalid_body" };

  if (record.event === "payment_link.paid") {
    const link = record.payload?.payment_link?.entity;
    if (!link || typeof link.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(link.id) || typeof link.reference_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(link.reference_id) || link.status !== "paid" || typeof link.amount !== "number" || !Number.isSafeInteger(link.amount) || link.amount_paid !== link.amount || link.currency !== "INR") return { kind: "rejected", reason: "invalid_body" };
    return { kind: "manual_payment_event", eventId, intentId: link.reference_id, paymentLinkId: link.id, amount: link.amount, currency: "INR" };
  }

  const newStatus = Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_TO_STATUS, record.event) ? WEBHOOK_EVENT_TO_STATUS[record.event] : undefined;
  if (!newStatus) return { kind: "ignored", eventId, event: record.event };

  const subscriptionId = record.payload?.subscription?.entity?.id ?? record.payload?.payment?.entity?.subscription_id;
  if (typeof subscriptionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(subscriptionId) || typeof record.created_at !== "number" || !Number.isSafeInteger(record.created_at) || record.created_at < 0) return { kind: "rejected", reason: "invalid_body" };
  const paymentRow = record.payload?.payment?.entity;
  let payment: { id: string; amount: number; currency: string; status: string } | undefined;
  if (paymentRow) {
    if (typeof paymentRow.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(paymentRow.id) || typeof paymentRow.amount !== "number" || !Number.isSafeInteger(paymentRow.amount) || typeof paymentRow.currency !== "string" || typeof paymentRow.status !== "string" || (typeof paymentRow.subscription_id === "string" && paymentRow.subscription_id !== subscriptionId)) return { kind: "rejected", reason: "invalid_body" };
    payment = { id: paymentRow.id, amount: paymentRow.amount, currency: paymentRow.currency, status: paymentRow.status };
  }
  const currentEnd = record.payload?.subscription?.entity?.current_end;
  if (currentEnd !== undefined && (typeof currentEnd !== "number" || !Number.isSafeInteger(currentEnd) || currentEnd <= 0)) return { kind: "rejected", reason: "invalid_body" };
  return { kind: "subscription_event", eventId, event: record.event, subscriptionId, newStatus, createdAt: record.created_at, ...(typeof currentEnd === "number" ? { currentPeriodEnd: currentEnd } : {}), ...(payment ? { payment } : {}) };
}
