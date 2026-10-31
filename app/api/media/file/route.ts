import { mediaFileRoute } from "../../../../src/server/media-route.ts";

// GET only. Access is checked on every request; see src/server/handlers/media-serve.ts.
export const GET = mediaFileRoute();
