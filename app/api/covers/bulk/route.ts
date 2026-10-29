import { jsonRoute } from "../../../../src/server/http.ts";
import { bulkUpdateCovers } from "../../../../src/server/handlers/captions-covers.ts";

// POST only: other methods get 405 from Next.js automatically.
export const POST = jsonRoute(bulkUpdateCovers);
