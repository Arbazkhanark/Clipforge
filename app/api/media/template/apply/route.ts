import { jsonRoute } from "../../../../../src/server/http.ts";
import { applyEditingTemplateToVideo } from "../../../../../src/server/handlers/editor.ts";

export const POST = jsonRoute(applyEditingTemplateToVideo);
