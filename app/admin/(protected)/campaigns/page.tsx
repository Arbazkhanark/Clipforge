import { renderAdminCampaignsPage } from "../../../../src/components/admin/AdminCampaignsPages.tsx";

export default function AdminCampaignsPage({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  return renderAdminCampaignsPage(searchParams);
}
