import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";
import { readGoogleOAuthConfig } from "../../src/server/auth/google-oauth.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";
import { safeCustomerReturnPath } from "../../src/server/auth/return-path.ts";

export const metadata = publicPageMetadata({ title: "Create your account", description: "Create a ClipForge account to organize your video workflow.", path: "/register", indexable: false });
export const dynamic = "force-dynamic";

export default async function RegisterPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const runtime = getRuntime();
  const search = await props.searchParams;
  return <AuthForm mode="register" demoMode={runtime.mode === "demo"} available={runtime.auth !== undefined} persistence={runtime.mode === "database" ? "database" : "memory"} emailDelivery={runtime.emailDelivery} googleConfigured={readGoogleOAuthConfig() !== null} returnTo={safeCustomerReturnPath(search?.returnTo)} flash={parseFlash(search)} />;
}
