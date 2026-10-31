import { AuthForm } from "../../src/components/AuthForm.tsx";
import { parseFlash } from "../../src/server/flash.ts";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined> } = {}) {
  const runtime = getRuntime();
  return <AuthForm mode="register" demoMode={runtime.mode === "demo"} available={runtime.auth !== undefined} flash={parseFlash(await props.searchParams)} />;
}
