import { NextResponse, type NextRequest } from "next/server.js";
import { planLimitPreviewRequestHeaders } from "./src/lib/ui/plan-limit-preview.ts";

/** Sanitizes the private preview marker on every request before forwarding it to the application. */
export function proxy(request: NextRequest) {
  const requestHeaders = planLimitPreviewRequestHeaders(request.headers, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = { matcher: ["/:path*"] };
