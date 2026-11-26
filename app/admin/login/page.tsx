import { AdminLoginForm } from "../../../src/components/admin/AdminLoginForm.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { getRuntime } from "../../../src/server/runtime.ts";

export const metadata = {
  title: "Super Admin sign in",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function AdminLoginPage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const runtime = getRuntime();
  return <AdminLoginForm available={runtime.auth !== undefined && runtime.passwordAuthEnabled === true} passwordAuthEnabled={runtime.passwordAuthEnabled === true} flash={parseFlash(await props.searchParams)} />;
}
