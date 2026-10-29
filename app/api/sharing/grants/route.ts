import { jsonRoute } from "../../../../src/server/http.ts";
import { createGrant } from "../../../../src/server/handlers/sharing.ts";

// POST only: other methods get 405 from Next.js automatically.
export const POST = jsonRoute(createGrant);
