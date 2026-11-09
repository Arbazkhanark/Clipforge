import { createSubscriptionCheckout } from "../../../../../src/server/billing/subscription-checkout.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";

export const POST = (request: Request): Promise<Response> => createSubscriptionCheckout(request, getRuntime());
