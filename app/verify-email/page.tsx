import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Confirm your email", description: "Confirm the email address for your ClipForge account.", path: "/verify-email", indexable: false });
export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// The link in the email opens THIS page; it only shows a button. Nothing happens until the form is posted,
// so email scanners that open links cannot use up the token.
export default async function VerifyEmailPage(props: { searchParams?: Promise<Search> }) {
  const search = await props.searchParams;
  const token = typeof search?.["token"] === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(search["token"]) ? search["token"] : null;
  const runtime = getRuntime();
  return <AuthForm mode="verify" demoMode={false} available={runtime.auth !== undefined && token !== null} passwordAuthEnabled={runtime.passwordAuthEnabled === true} persistence={runtime.mode === "database" ? "database" : "memory"} emailDelivery={runtime.emailDelivery} token={token} flash={parseFlash(search)} />;
}
