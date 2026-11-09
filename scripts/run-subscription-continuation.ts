import { getRuntime } from "../src/server/runtime.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "../src/server/billing/razorpay-client.ts";
import { runSubscriptionContinuations } from "../src/server/billing/subscription-continuation.ts";

if (process.env["CLIPFORGE_SUBSCRIPTION_CONTINUATION_ENABLED"] !== "true") {
  process.stdout.write("Subscription continuation disabled; explicit opt-in is required.\n");
  process.exit(0);
}
if (!process.env["DATABASE_URL"]) throw new Error("Subscription continuation requires database mode.");
const config = readRazorpayTestConfig();
if (!config || !config.webhookSecret) throw new Error("Sandbox Razorpay credentials and webhook configuration are required.");
const runtime = getRuntime();
if (runtime.mode !== "database") throw new Error("Subscription continuation refuses non-database runtime modes.");
const result = await runSubscriptionContinuations(runtime.repo, new RazorpayTestClient(config), runtime.now());
process.stdout.write(`Subscription continuation run completed: ${JSON.stringify(result)}\n`);
