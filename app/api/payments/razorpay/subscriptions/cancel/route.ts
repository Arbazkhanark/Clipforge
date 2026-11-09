import { cancelOwnedSubscription } from "../../../../../../src/server/billing/subscription-cancellation.ts";
import { getRuntime } from "../../../../../../src/server/runtime.ts";

export const POST = (request: Request): Promise<Response> => cancelOwnedSubscription(request, getRuntime());
