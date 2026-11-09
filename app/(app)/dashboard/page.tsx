import { DashboardView } from "../../../src/components/DashboardView.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getDashboardData } from "../../../src/server/queries.ts";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic"; // per-user data: never pre-rendered or cached

type Search = { notice?: string; error?: string; status?: string };

export default async function DashboardPage(props: { searchParams?: Promise<Search> }) {
  await requireCustomerPage("/dashboard");
  const searchParams = await props.searchParams;
  const result = await loadPageData((ctx) => getDashboardData(ctx, "Asia/Kolkata", searchParams?.status));
  return <><FlashMessage flash={parseFlash(searchParams)} />{result.ok ? <DashboardView data={result.data} actionsEnabled={result.mode !== "demo"} /> : <ErrorState error={result.error} />}</>;
}
