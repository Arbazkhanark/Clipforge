import { renderAdminCampaignDetailsPage } from "../../../../../src/components/admin/AdminCampaignsPages.tsx";

export default async function AdminCampaignDetailsPage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await params;
  return renderAdminCampaignDetailsPage(cycleId);
}
