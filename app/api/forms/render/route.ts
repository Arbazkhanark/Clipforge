import { renderExportForm } from "../../../../src/server/form-handlers.ts";

// POST only. Queues a render and returns immediately. The original file is not changed.
export const POST = renderExportForm;
