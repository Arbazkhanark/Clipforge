import { renderFileRoute } from "../../../../src/server/render-route.ts";

// GET only. The export is sent only to the person who rendered it, and only after the stored size matches.
export const GET = renderFileRoute();
