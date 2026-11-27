import { jsonRoute } from "../../../../src/server/http.ts";
import { deletePublishingCycle } from "../../../../src/server/handlers/cycles.ts";

// Auth, ownership, confirmation and lease checks live in the shared handler.
export const POST = jsonRoute(deletePublishingCycle);
