import { interpretRazorpayWebhook } from "../../lib/billing/razorpay-webhook.ts";
import type { Repository } from "../repository.ts";
import type { RazorpayTestClient } from "./razorpay-client.ts";

const MAX_WEBHOOK_BYTES = 128 * 1024;

/** Verifies the raw bytes before parsing and records the event before returning success. */
export async function handleRazorpayWebhook(request: Request, args: { repo: Repository; webhookSecret: string; manualPaymentClient?: RazorpayTestClient; now?: () => Date }): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });
  let rawBody: Buffer;
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.byteLength > MAX_WEBHOOK_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });
    rawBody = bytes;
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const event = interpretRazorpayWebhook({
    rawBody,
    signatureHeader: request.headers.get("x-razorpay-signature"),
    eventIdHeader: request.headers.get("x-razorpay-event-id"),
    webhookSecret: args.webhookSecret,
  });
  if (event.kind === "rejected") {
    const status = event.reason === "bad_signature" ? 401 : 400;
    return Response.json({ error: event.reason }, { status });
  }
  if (event.kind === "manual_payment_event") {
    try {
      if (!args.manualPaymentClient) return Response.json({ error: "payment_verifier_not_configured" }, { status: 503 });
      const intent = await args.repo.getManualPaymentIntentForWebhook(event.intentId);
      if (!intent) return Response.json({ error: "payment_intent_not_found" }, { status: 503 });
      if (intent.providerPaymentLinkId !== event.paymentLinkId || intent.amountPaise !== event.amount) return Response.json({ error: "payment_not_verified" }, { status: 409 });
      const verified = await args.manualPaymentClient.verifyManualPaymentLink({ intentId: intent.id, paymentLinkId: event.paymentLinkId, amountPaise: intent.amountPaise });
      if (!verified) return Response.json({ error: "payment_not_verified" }, { status: 503 });
      const outcome = await args.repo.settleManualPayment({ userId: intent.userId, intentId: intent.id, providerPaymentLinkId: verified.paymentLinkId, providerPaymentId: verified.paymentId, amountPaise: verified.amount, currency: verified.currency, status: verified.status, paidAt: verified.paidAt, now: (args.now ?? (() => new Date()))() });
      if (outcome === "invalid") return Response.json({ error: "payment_not_verified" }, { status: 409 });
      if (outcome === "conflict") return Response.json({ error: "billing_conflict" }, { status: 409 });
      return Response.json({ received: true, outcome }, { status: 200 });
    } catch { return Response.json({ error: "event_not_persisted" }, { status: 503 }); }
  }
  const input = event.kind === "subscription_event"
    ? { providerEventId: event.eventId, eventType: event.event, subscriptionId: event.subscriptionId, newStatus: event.newStatus, createdAt: event.createdAt, ...(event.currentPeriodEnd === undefined ? {} : { currentPeriodEnd: event.currentPeriodEnd }), ...(event.payment ? { payment: event.payment } : {}) }
    : { providerEventId: event.eventId, eventType: event.event };
  let outcome: Awaited<ReturnType<Repository["processRazorpaySubscriptionEvent"]>>;
  try { outcome = await args.repo.processRazorpaySubscriptionEvent(input); }
  catch { return Response.json({ error: "event_not_persisted" }, { status: 503 }); }
  if (outcome === "unknown_subscription") return Response.json({ error: "subscription_not_found" }, { status: 503 });
  if (outcome === "invalid_transition") return Response.json({ error: "invalid_subscription_transition" }, { status: 409 });
  return Response.json({ received: true, outcome }, { status: 200 });
}
