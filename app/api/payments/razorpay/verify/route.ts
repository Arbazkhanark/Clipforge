import { verifyOwnedSubscriptionPayment } from "../../../../../src/server/billing/subscription-payment-verification.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";

export const POST = (request: Request): Promise<Response> => verifyOwnedSubscriptionPayment(request, getRuntime());
