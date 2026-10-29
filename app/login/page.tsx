import { AuthForm } from "../../src/components/AuthForm.tsx";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return <AuthForm mode="login" demoMode={getRuntime().mode === "demo"} />;
}
