import { resetPasswordRoute } from "../../../../src/server/auth/auth-routes.ts";

// POST only. Real authentication runs only when the runtime provides it (see src/server/runtime.ts).
export const POST = resetPasswordRoute();
