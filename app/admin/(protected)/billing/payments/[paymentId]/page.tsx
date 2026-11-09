import { renderAdminPaymentDetailsPage } from "../../../../../../src/components/admin/AdminBillingPages.tsx";

export default async function AdminPaymentDetailsPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  return renderAdminPaymentDetailsPage(paymentId);
}
