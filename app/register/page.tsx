import { AuthForm } from "../../src/components/AuthForm.tsx";
import { getRuntime } from "../../src/server/runtime.ts";

export const metadata = { title: "Create account" };

export default function RegisterPage() {
  return <AuthForm mode="register" demoMode={getRuntime().mode === "demo"} />;
}
