import { editorSaveForm } from "../../../../src/server/form-handlers.ts";

// POST only. Saves editing settings as a template; the original media is never changed.
export const POST = editorSaveForm;
