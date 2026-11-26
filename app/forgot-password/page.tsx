import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";

export const metadata = publicPageMetadata({ title: "Reset your password", description: "Request a password reset for your ClipForge account.", path: "/forgot-password", indexable: false });
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const runtime = getRuntime();
  return <AuthForm mode="forgot" demoMode={false} available={runtime.auth !== undefined} passwordAuthEnabled={runtime.passwordAuthEnabled === true} persistence={runtime.mode === "database" ? "database" : "memory"} emailDelivery={runtime.emailDelivery} flash={parseFlash(await props.searchParams)} />;
}
