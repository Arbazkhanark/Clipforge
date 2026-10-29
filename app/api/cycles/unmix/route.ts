import { jsonRoute } from "../../../../src/server/http.ts";
import { unmixFromCycle } from "../../../../src/server/handlers/cycles.ts";

// POST only: other methods get 405 from Next.js automatically.
export const POST = jsonRoute(unmixFromCycle);
