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
  "subscription.activated": "active",
  "subscription.charged": "active", // a successful charge means the subscription is active
  "subscription.pending": "pending",
  "subscription.halted": "halted",
  "subscription.cancelled": "cancelled",
  "subscription.paused": "paused",       // provisional
  "subscription.resumed": "active",      // provisional
  "subscription.completed": "completed", // provisional
};

export type WebhookInterpretation =
  | { kind: "rejected"; reason: "bad_signature" | "missing_event_id" | "invalid_body" }
  /** Authentic but not a subscription event we act on (e.g. payment.captured). Record it and answer 200. */
  | { kind: "ignored"; eventId: string; event: string }
  | { kind: "subscription_event"; eventId: string; event: string; subscriptionId: string; newStatus: SubscriptionStatus; createdAt: number };

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
  const record = body as { event?: unknown; created_at?: unknown; payload?: { subscription?: { entity?: { id?: unknown } } } };
  if (typeof record.event !== "string") return { kind: "rejected", reason: "invalid_body" };

  const newStatus = Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_TO_STATUS, record.event) ? WEBHOOK_EVENT_TO_STATUS[record.event] : undefined;
  if (!newStatus) return { kind: "ignored", eventId, event: record.event };

  const subscriptionId = record.payload?.subscription?.entity?.id;
  if (typeof subscriptionId !== "string" || subscriptionId === "" || typeof record.created_at !== "number") return { kind: "rejected", reason: "invalid_body" };
  return { kind: "subscription_event", eventId, event: record.event, subscriptionId, newStatus, createdAt: record.created_at };
}
