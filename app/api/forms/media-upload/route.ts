import { uploadRoute } from "../../../../src/server/upload-route.ts";

// POST only. Development storage: private memory or local disk (never public, never cloud).
export const POST = uploadRoute();
