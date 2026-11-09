import { adminLoginRoute } from "../../../../src/server/auth/auth-routes.ts";

// This is the only intentionally unauthenticated /api/admin endpoint; it authenticates before issuing any session cookie.
export const POST = adminLoginRoute();
