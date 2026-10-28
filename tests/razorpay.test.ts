import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyOrderPaymentSignature, verifySubscriptionPaymentSignature, verifyRazorpayWebhook } from "../src/lib/billing/razorpay-signature.ts";

const sign = (msg: string | Buffer, secret: string) => createHmac("sha256", secret).update(msg).digest("hex");

test("order payment signature: valid, tampered, wrong secret", () => {
  const signature = sign("order_1|pay_1", "key");
  assert.equal(verifyOrderPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature }, "key"), true);
  assert.equal(verifyOrderPaymentSignature({ orderId: "order_1", paymentId: "pay_2", signature }, "key"), false);
  assert.equal(verifyOrderPaymentSignature({ orderId: "order_1", paymentId: "pay_1", signature }, "other"), false);
});

test("subscription signature uses payment_id|subscription_id order", () => {
  const signature = sign("pay_1|sub_1", "key");
  assert.equal(verifySubscriptionPaymentSignature({ paymentId: "pay_1", subscriptionId: "sub_1", signature }, "key"), true);
  const swapped = sign("sub_1|pay_1", "key");
  assert.equal(verifySubscriptionPaymentSignature({ paymentId: "pay_1", subscriptionId: "sub_1", signature: swapped }, "key"), false);
});

test("webhook verifies exact raw body", () => {
  const raw = '{"event":"subscription.activated",  "id":"x"}'; // odd spacing on purpose
  const signature = sign(raw, "whsec");
  assert.equal(verifyRazorpayWebhook(raw, signature, "whsec"), true);
  assert.equal(verifyRazorpayWebhook(Buffer.from(raw), signature, "whsec"), true);
  // Re-serialised JSON changes the bytes, so the signature must fail.
  assert.equal(verifyRazorpayWebhook(JSON.stringify(JSON.parse(raw)), signature, "whsec"), false);
});

test("malformed or missing signatures are rejected without throwing", () => {
  const raw = "{}";
  for (const bad of [undefined, null, "", "zzzz", "abcd", sign(raw, "whsec") + "00"]) {
    assert.equal(verifyRazorpayWebhook(raw, bad, "whsec"), false);
  }
});

test("missing secret throws instead of silently passing", () => {
  assert.throws(() => verifyRazorpayWebhook("{}", "abcd", ""));
});
