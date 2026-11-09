// Razorpay signature verification (HMAC-SHA256, hex).
// Subscription checkout signature follows Razorpay's official subscription checkout
// guidance: HMAC(payment_id|subscription_id), where the subscription ID is loaded
// from server-side storage rather than trusted from the browser.
import { createHmac, timingSafeEqual } from "node:crypto";

function hmacHex(message: string | Buffer, secret: string): string {
  if (!secret) throw new Error("Razorpay secret is not configured");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function safeEqualHex(expectedHex: string, receivedHex: string | undefined | null): boolean {
  if (!receivedHex || !/^[0-9a-f]+$/i.test(receivedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const received = Buffer.from(receivedHex, "hex");
  if (expected.length !== received.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(expected, received);
}

/** One-time order payment checkout: HMAC(order_id|payment_id). */
export function verifyOrderPaymentSignature(
  p: { orderId: string; paymentId: string; signature: string }, keySecret: string,
): boolean {
  return safeEqualHex(hmacHex(`${p.orderId}|${p.paymentId}`, keySecret), p.signature);
}

/** Subscription checkout: HMAC(payment_id|subscription_id). */
export function verifySubscriptionPaymentSignature(
  p: { paymentId: string; subscriptionId: string; signature: string }, keySecret: string,
): boolean {
  return safeEqualHex(hmacHex(`${p.paymentId}|${p.subscriptionId}`, keySecret), p.signature);
}

/**
 * Webhook: HMAC of the EXACT raw request body using the webhook secret,
 * compared to the X-Razorpay-Signature header. Do not JSON.parse and re-stringify first.
 */
export function verifyRazorpayWebhook(rawBody: string | Buffer, signatureHeader: string | null | undefined, webhookSecret: string): boolean {
  return safeEqualHex(hmacHex(rawBody, webhookSecret), signatureHeader);
}
