import { redirect } from "next/navigation.js";
import { getRuntime } from "../runtime.ts";
import { safeCustomerReturnPath } from "./return-path.ts";

/** Server-page gate. Data queries and APIs still enforce their own owner/session checks. */
export async function requireCustomerPage(returnTo: string): Promise<void> {
  if (await getRuntime().currentUserId()) return;
  const safePath = safeCustomerReturnPath(returnTo);
  redirect(`/login?returnTo=${encodeURIComponent(safePath)}`);
}
