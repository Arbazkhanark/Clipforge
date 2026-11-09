import { handleRazorpayWebhook } from "../../../../../src/server/billing/razorpay-webhook-handler.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "../../../../../src/server/billing/razorpay-client.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";

export async function POST(request: Request): Promise<Response> {
  const config = readRazorpayTestConfig();
  if (!config?.webhookSecret) return Response.json({ error: "billing_not_configured" }, { status: 503 });
  const runtime = getRuntime();
  // The in-memory repository is not a durable webhook inbox. Refuse to acknowledge it.
  if (runtime.mode !== "database") return Response.json({ error: "durable_billing_store_required" }, { status: 503 });
  return handleRazorpayWebhook(request, { repo: runtime.repo, webhookSecret: config.webhookSecret, manualPaymentClient: new RazorpayTestClient(config), now: runtime.now });
}
