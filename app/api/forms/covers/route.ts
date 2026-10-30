import { coversForm } from "../../../../src/server/form-handlers.ts";

// POST only: other methods get 405 from Next.js automatically.
export const POST = coversForm;
