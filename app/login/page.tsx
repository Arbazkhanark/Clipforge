import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";
import { readGoogleOAuthConfig } from "../../src/server/auth/google-oauth.ts";
import { publicPageMetadata } from "../../src/lib/site-metadata.ts";
import { safeCustomerReturnPath } from "../../src/server/auth/return-path.ts";

export const metadata = publicPageMetadata({
  title: "Sign in",
  description: "Sign in to your ClipForge workspace.",
  path: "/login",
  indexable: false,
});
export const dynamic = "force-dynamic";

export default async function LoginPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const runtime = getRuntime();
  const search = await props.searchParams;
  return (
    <AuthForm
      mode="login"
      demoMode={runtime.mode === "demo"}
      available={runtime.auth !== undefined}
      persistence={runtime.mode === "database" ? "database" : "memory"}
      emailDelivery={runtime.emailDelivery}
      googleConfigured={readGoogleOAuthConfig() !== null}
      returnTo={safeCustomerReturnPath(search?.returnTo)}
      flash={parseFlash(search)}
    />
  );
}
