import { verifyManualPayment } from "../../../../../../src/server/billing/manual-payment.ts";
import { getRuntime } from "../../../../../../src/server/runtime.ts";

export const POST = (request: Request): Promise<Response> => verifyManualPayment(request, getRuntime());
