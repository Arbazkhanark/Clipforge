/** Synthetic-only records for the loopback Admin UI preview. Never loaded from repositories. */
import type { PreviewPageData } from "../../components/admin/AdminPreviewPage.tsx";

export const ADMIN_PREVIEW_PAGES: Record<string, PreviewPageData> = {
  "/": {
    section: "overview", title: "Platform overview", description: "A synthetic walkthrough of the ClipForge Admin workspace.",
    summary: [
      { label: "Users", value: "128", note: "Synthetic sample" },
      { label: "Campaigns", value: "42", note: "Synthetic sample" },
      { label: "Recorded posts", value: "316", note: "Not live verified" },
      { label: "Billing records", value: "84", note: "Synthetic sample" },
    ],
    tables: [{ title: "Recent platform activity", columns: ["Time", "Actor", "Activity", "State"], rows: [["Today, 10:30", "Asha Sample", "Created a cycle", "Recorded"], ["Yesterday, 16:05", "Demo Operator", "Reviewed a publishing attempt", "Needs review"], ["Nov 05, 12:20", "System sample", "Payment event received", "Synthetic"]] }],
  },
  "/users": {
    section: "users", title: "Users", description: "Synthetic account rows for previewing search and table layout.",
    tables: [{ title: "User directory", columns: ["User", "Plan", "Account", "Created"], rows: [["Asha Sample · preview-user-001", "Creator · manual sample", "Verified · ordinary user", "Nov 01, 2026"], ["Kabir Example · preview-user-002", "Free · sample", "Unverified · ordinary user", "Oct 27, 2026"]] }],
  },
  "/users/preview-user-001": {
    section: "users", title: "User profile · synthetic", description: "Profile and history preview. No real user record is loaded.",
    details: [{ label: "Name", value: "Asha Sample" }, { label: "Email", value: "asha@example.test" }, { label: "Role", value: "user · synthetic" }, { label: "Email status", value: "Verified · synthetic" }, { label: "Current access", value: "Creator · manual sample, not payment proof" }],
    tables: [
      { title: "Subscription and payment history", columns: ["Record", "State", "Amount", "Date"], rows: [["Manual access sample", "Active until sample date", "₹499 · sample only", "Nov 01, 2026"], ["Payment sample", "Captured · synthetic", "₹499 · sample only", "Nov 01, 2026"]] },
      { title: "Connected account and activity", columns: ["Record", "Status", "Information"], rows: [["Instagram · @asha.sample", "Stored as connected", "No live Meta verification"], ["Spring launch · preview-cycle-001", "Paused · synthetic", "2 sample Reels"]] },
    ],
  },
  "/campaigns": {
    section: "campaigns", title: "Campaigns", description: "Synthetic cycle and publishing states for visual review.",
    tables: [{ title: "Publishing cycles", columns: ["Cycle", "Owner", "Status", "Progress", "Next planned item"], rows: [["Spring launch · preview-cycle-001", "Asha Sample", "Running · sample", "2 / 4", "Nov 09, 2026 · planned"], ["Studio clips · preview-cycle-002", "Kabir Example", "Paused · sample", "1 / 3", "Not scheduled"]] }],
  },
  "/campaigns/preview-cycle-001": {
    section: "campaigns", title: "Spring launch · cycle detail", description: "Synthetic configuration and item history. Planned times are not publishing confirmations.",
    details: [{ label: "Owner", value: "Asha Sample · preview-user-001" }, { label: "Status", value: "Running · synthetic" }, { label: "Timezone", value: "Asia/Kolkata · sample" }, { label: "Schedule", value: "Tue / Thu · 10:30 · synthetic" }],
    tables: [
      { title: "Reels / cycle items", columns: ["Sequence", "Source", "Schedule", "Stored state"], rows: [["1", "sample-source-one.mp4", "Nov 07 · planned", "Published (recorded sample)"], ["2", "sample-source-two.mp4", "Nov 09 · planned", "Queued · sample"], ["3", "sample-source-three.mp4", "No time assigned", "Not scheduled"]] },
      { title: "Publishing attempt history", columns: ["Attempt", "Stage", "Outcome", "Error"], rows: [["#1", "Ready to publish", "Needs manual review · sample", "Ambiguous provider result · synthetic"]] },
    ],
  },
  "/instagram": {
    section: "instagram", title: "Instagram accounts", description: "Synthetic stored account summaries; no Meta API is contacted.",
    tables: [{ title: "Connected account summaries", columns: ["Account", "Owner", "Stored state", "Token status"], rows: [["@asha.sample · preview-account-001", "Asha Sample", "Connected · synthetic", "Expiry sample · not live verified"], ["@kabir.sample · preview-account-002", "Kabir Example", "Incomplete · synthetic", "Unavailable"]] }],
  },
  "/instagram/preview-account-001": {
    section: "instagram", title: "@asha.sample · account detail", description: "Synthetic stored account information only. No token values are shown.",
    details: [{ label: "Owner", value: "Asha Sample · preview-user-001" }, { label: "Account type", value: "BUSINESS · sample" }, { label: "Stored connection", value: "Connected · synthetic" }, { label: "Permission status", value: "Present in sample record · not Meta verified" }, { label: "Token expiry", value: "Nov 30, 2026 · sample only" }],
    tables: [{ title: "Related campaigns and publishing activity", columns: ["Campaign", "Attempt", "Recorded outcome", "Error"], rows: [["Spring launch", "#1", "Needs review · synthetic", "Ambiguous result · sample"]] }],
  },
  "/billing": {
    section: "billing", title: "Billing & payments", description: "Synthetic payment and subscription records; amounts are examples, not financial reporting.",
    tables: [
      { title: "Payments", columns: ["Payment", "User", "Plan", "Status", "Gross amount"], rows: [["preview-payment-001", "Asha Sample", "Creator weekly", "Captured · sample", "₹499 · synthetic"], ["preview-payment-002", "Kabir Example", "Pro monthly", "Failed · sample", "₹3,999 · synthetic"]] },
      { title: "Subscriptions", columns: ["User", "Plan", "Stored state", "Period end"], rows: [["Asha Sample", "Creator weekly", "Active · sample", "Nov 14, 2026 · sample"]] },
    ],
  },
  "/billing/preview-payment-001": {
    section: "billing", title: "Payment detail · preview-payment-001", description: "Synthetic payment detail. This is not a provider transaction.",
    details: [{ label: "User", value: "Asha Sample · preview-user-001" }, { label: "Plan", value: "Creator · weekly · sample" }, { label: "Status", value: "Captured · synthetic" }, { label: "Amount", value: "₹499 · sample only" }, { label: "Provider reference", value: "preview-reference-001 · fake" }, { label: "Gateway fee / refund", value: "Unavailable · no authoritative sample value" }],
  },
  "/plans": {
    section: "plans", title: "Plans & entitlements", description: "Synthetic catalog and sample entitlement records for layout preview.",
    tables: [{ title: "Configured plan examples", columns: ["Plan", "Weekly", "Monthly", "Sample access rows"], rows: [["Free", "₹0", "₹0", "2 · synthetic"], ["Creator", "₹499 · sample", "₹1,999 · sample", "1 · synthetic"], ["Pro", "₹999 · sample", "₹3,999 · sample", "0 · synthetic"], ["Agency", "₹1,499 · sample", "₹5,999 · sample", "0 · synthetic"]] }],
  },
  "/analytics": {
    section: "analytics", title: "Analytics", description: "Synthetic trend preview. No historical metrics are represented as real data.",
    summary: [{ label: "Registrations", value: "18", note: "Synthetic period" }, { label: "Recorded publishes", value: "27", note: "Not live verified" }, { label: "Payments", value: "12", note: "Synthetic records" }],
    tables: [{ title: "Synthetic daily series", columns: ["Date", "New users", "Cycles created", "Recorded publish outcomes"], rows: [["Nov 06", "4", "3", "5"], ["Nov 07", "7", "2", "8"], ["Nov 08", "7", "4", "14"]] }],
  },
  "/reports": {
    section: "reports", title: "Reports", description: "Report section preview.", reportPlaceholder: true,
  },
  "/settings": {
    section: "settings", title: "Platform settings", description: "Synthetic configuration-status layout. No environment values or credentials are read.",
    tables: [{ title: "Configuration status examples", columns: ["Area", "Preview state", "Verification"], rows: [["Application mode", "Development · sample", "Preview only"], ["Meta integration", "Not live verified", "No credentials inspected"], ["Razorpay", "Not live verified", "No provider contacted"], ["Media processing", "Status unavailable", "Synthetic preview"]] }],
  },
  "/audit": {
    section: "audit", title: "Audit Logs", description: "Synthetic event rows. Raw metadata and payloads are omitted.",
    tables: [{ title: "Audit events", columns: ["Time", "Actor", "Action", "Target", "Outcome"], rows: [["Nov 08, 10:30", "Admin sample", "cycle.reviewed", "preview-cycle-001", "Recorded · sample"], ["Nov 07, 16:05", "System sample", "publish.needs_review", "preview-attempt-001", "Synthetic"]] }],
  },
  "/audit/preview-audit-001": {
    section: "audit", title: "Audit event · preview-audit-001", description: "Synthetic audit detail with approved display fields only.",
    details: [{ label: "Actor", value: "Admin sample · synthetic" }, { label: "Action", value: "cycle.reviewed · sample" }, { label: "Target type", value: "PublishingCycle · synthetic" }, { label: "Target ID", value: "preview-cycle-001" }, { label: "Outcome", value: "Not stored in sample" }, { label: "Timestamp", value: "Nov 08, 2026 · sample" }],
  },
};
