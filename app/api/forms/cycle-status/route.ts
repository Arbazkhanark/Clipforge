import { cycleStatusForm } from "../../../../src/server/form-handlers.ts";

// POST only: all authorization and transition checks live in the shared handler.
export const POST = cycleStatusForm;
