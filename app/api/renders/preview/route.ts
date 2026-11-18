import { renderPreviewRoute } from "../../../../src/server/render-route.ts";

// Inline playback of a completed private render; the serving handler checks ownership on every request.
export const GET = renderPreviewRoute();
