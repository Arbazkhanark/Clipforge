import { getPlan, isBillingInterval, isPlanId } from "../../lib/billing/catalog.ts";
import { checkSameOrigin } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "./razorpay-client.ts";
import { readSmallJson } from "./request-json.ts";

const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/;
const safeCheckoutUrl = (value: string | undefined): string | null => {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "rzp.io" || url.hostname.endsWith(".razorpay.com")) ? url.toString() : null; } catch { return null; }
};

export async function createSubscriptionCheckout(request: Request, runtime: Runtime, clientOverride?: RazorpayTestClient, configOverride = readRazorpayTestConfig()): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return json({ error: "cross_site_request" }, 403);
  if (runtime.mode !== "database") return json({ error: "durable_billing_store_required" }, 503);
  const userId = await runtime.currentUserId(request);
  if (!userId) return json({ error: "unauthenticated" }, 401);
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY.test(key)) return json({ error: "invalid_idempotency_key" }, 400);
  const parsed = await readSmallJson(request);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!body || typeof body !== "object") return json({ error: "invalid_request" }, 400);
  const planId = (body as Record<string, unknown>)["planId"];
  const interval = (body as Record<string, unknown>)["interval"];
  if (typeof planId !== "string" || typeof interval !== "string" || !isPlanId(planId) || planId === "free" || !isBillingInterval(interval)) return json({ error: "invalid_plan" }, 400);
  if ((body as Record<string, unknown>)["autoRenewConsent"] !== true) return json({ error: "auto_renew_consent_required" }, 400);
  const config = configOverride;
  const client = clientOverride ?? new RazorpayTestClient(config);
  const providerPlanId = config?.subscriptionPlanIds[planId]?.[interval];
  if (!config || !config.webhookSecret || !config.subscriptionTotalCount || !providerPlanId) return json({ error: "checkout_not_configured" }, 503);
  const amountPaise = getPlan(planId).pricePaise[interval];
  const consentAt = runtime.now();
  const reserved = await runtime.repo.reserveRazorpaySubscriptionIntent({ id: runtime.newId(), userId, idempotencyKey: key, autoRenewConsentAt: consentAt, autoRenewConsentVersion: "auto-renew-v1", providerPlanId, planId, interval, amountPaise, now: consentAt });
  if (reserved.status === "conflict" || !reserved.intent) return json({ error: "subscription_checkout_conflict" }, 409);
  const intent = reserved.intent;
  if (reserved.status === "existing") {
    if (intent.status === "created" && intent.checkoutUrl) return json({ intentId: intent.id, checkoutUrl: intent.checkoutUrl, status: intent.status });
    return json({ error: intent.status === "manual_review" ? "checkout_requires_review" : "checkout_in_progress" }, 409);
  }

  // Any lost/invalid provider response is ambiguous; persist manual review and never retry automatically.
  const result = await client.createSubscription({ ownerId: userId, planId, interval });
  const checkoutUrl = result.ok ? safeCheckoutUrl(result.value.short_url) : null;
  if (!result.ok || !checkoutUrl) {
    await runtime.repo.finishRazorpaySubscriptionIntent({ id: intent.id, userId, status: "manual_review", errorCategory: result.ok ? "invalid_provider_response" : "provider_outcome_uncertain", now: runtime.now() });
    return json({ error: "checkout_requires_review" }, 503);
  }
  const saved = await runtime.repo.finishRazorpaySubscriptionIntent({ id: intent.id, userId, status: "created", providerSubscriptionId: result.value.id, checkoutUrl, now: runtime.now() });
  if (!saved) return json({ error: "checkout_requires_review" }, 503);
  return json({ intentId: intent.id, checkoutUrl, status: "created" }, 201);
}
