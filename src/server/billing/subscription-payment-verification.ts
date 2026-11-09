import { checkSameOrigin } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "./razorpay-client.ts";
import { readSmallJson } from "./request-json.ts";

export async function verifyOwnedSubscriptionPayment(request: Request, runtime: Runtime, clientOverride?: RazorpayTestClient, config = readRazorpayTestConfig()): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return json({ error: "cross_site_request" }, 403);
  if (runtime.mode !== "database") return json({ error: "durable_billing_store_required" }, 503);
  const userId = await runtime.currentUserId(request);
  if (!userId) return json({ error: "unauthenticated" }, 401);
  const parsed = await readSmallJson(request); if (!parsed.ok) return json({ error: parsed.error }, parsed.status); const body = parsed.value;
  const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const subscriptionId = fields["razorpay_subscription_id"];
  const paymentId = fields["razorpay_payment_id"];
  const signature = fields["razorpay_signature"];
  if (typeof subscriptionId !== "string" || typeof paymentId !== "string" || typeof signature !== "string") return json({ error: "invalid_request" }, 400);
  const intent = await runtime.repo.getRazorpaySubscriptionIntentByProviderId(userId, subscriptionId);
  if (!intent) return json({ error: "subscription_not_found" }, 404);
  const client = clientOverride ?? new RazorpayTestClient(config);
  const verified = await client.verifySubscriptionPayment({ paymentId, subscriptionId, signature, amountPaise: intent.amountPaise });
  if (!verified) return json({ error: "payment_not_verified" }, 400);
  // Verification is useful for the redirect UX, but the signed webhook remains the entitlement write path.
  return json({ verified: true, entitlementUpdated: false, status: "awaiting_webhook" });
}
