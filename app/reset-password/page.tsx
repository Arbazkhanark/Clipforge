import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = { title: "Choose a new password" };
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The link in the email opens THIS page; it only shows a button. Nothing happens until the form is posted,
// so email scanners that open links cannot use up the token.
export default async function ResetPasswordPage(props: { searchParams?: Promise<Search> | Search } = {}) {
  const search = await props.searchParams;
  const token = typeof search?.["token"] === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(search["token"]) ? search["token"] : null;
  const runtime = getRuntime();
  return <AuthForm mode="reset" demoMode={false} available={runtime.auth !== undefined && token !== null} persistence={runtime.mode === "database" ? "database" : "memory"} token={token} flash={parseFlash(search)} />;
}
