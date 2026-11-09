import { renderAdminAnalyticsPage } from "../../../../src/components/admin/AdminAnalyticsPage.tsx";

type SearchParams = Record<string, string | string[] | undefined>;
export default function AdminAnalyticsPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<SearchParams> } = {}) {
  return renderAdminAnalyticsPage(searchParams);
}
