// app/(app)/instagram
import { InstagramAccountsView } from "../../../src/components/InstagramAccounts.tsx";
import { ErrorState } from "../../../src/components/PageState.tsx";
import { FlashMessage } from "../../../src/components/FlashMessage.tsx";
import { parseFlash } from "../../../src/server/flash.ts";
import { readInstagramOAuthConfig } from "../../../src/server/instagram/instagram-oauth.ts";
import { loadPageData } from "../../../src/server/page-data.ts";
import { getInstagramAccounts } from "../../../src/server/queries.ts";
import { requireCustomerPage } from "../../../src/server/auth/customer-page.ts";
import { headers } from "next/headers.js";
import { readInstagramDiagnosticCookieFromRequest } from "../../../src/server/instagram/instagram-diagnostic.ts";

export const metadata = { title: "Instagram" };
export const dynamic = "force-dynamic";

type Search = { notice?: string; error?: string };

export default async function InstagramPage(props: { searchParams?: Promise<Search> }) {
  await requireCustomerPage("/instagram");
  const searchParams = await props.searchParams;
  const requestHeaders = await headers();
  const oauthConfig = readInstagramOAuthConfig();
  const diagnostic = oauthConfig
    ? readInstagramDiagnosticCookieFromRequest(requestHeaders.get("cookie"), oauthConfig.tokenKey, new Date())
    : null;
  const result = await loadPageData((ctx) => getInstagramAccounts(ctx));
  return (
    <>
      <FlashMessage flash={parseFlash(searchParams)} />
      {result.ok ? <InstagramAccountsView configured={oauthConfig !== null} accounts={result.data} diagnostic={diagnostic} /> : <ErrorState error={result.error} />}
    </>
  );
}
