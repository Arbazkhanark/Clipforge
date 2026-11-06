import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined> } = {}) {
  const runtime = getRuntime();
  return <AuthForm mode="login" demoMode={runtime.mode === "demo"} available={runtime.auth !== undefined} persistence={runtime.mode === "database" ? "database" : "memory"} flash={parseFlash(await props.searchParams)} />;
}
