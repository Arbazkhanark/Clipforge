import type { ReactNode } from "react";

export type AdminPreviewSection = "overview" | "users" | "campaigns" | "plans" | "instagram" | "billing" | "analytics" | "reports" | "settings" | "audit";
export interface PreviewTable { title: string; columns: string[]; rows: string[][]; }
export interface PreviewPageData {
  section: AdminPreviewSection;
  title: string;
  description: string;
  summary?: Array<{ label: string; value: string; note: string }>;
  details?: Array<{ label: string; value: string }>;
  tables?: PreviewTable[];
  reportPlaceholder?: boolean;
}

const NAV: Array<{ id: AdminPreviewSection; label: string; href: string; group: string; icon: string }> = [
  { id: "overview", label: "Overview", href: "/", group: "Workspace", icon: "◫" },
  { id: "users", label: "Users", href: "/users", group: "Workspace", icon: "♙" },
  { id: "campaigns", label: "Campaigns", href: "/campaigns", group: "Workspace", icon: "▣" },
  { id: "plans", label: "Plans", href: "/plans", group: "Workspace", icon: "◇" },
  { id: "instagram", label: "Instagram", href: "/instagram", group: "Monitoring", icon: "◎" },
  { id: "billing", label: "Billing", href: "/billing", group: "Monitoring", icon: "◈" },
  { id: "analytics", label: "Analytics", href: "/analytics", group: "Monitoring", icon: "⌁" },
  { id: "reports", label: "Reports", href: "/reports", group: "Monitoring", icon: "▤" },
  { id: "settings", label: "Settings", href: "/settings", group: "Administration", icon: "⚙" },
  { id: "audit", label: "Audit Logs", href: "/audit", group: "Administration", icon: "◷" },
];

function Table({ table }: { table: PreviewTable }) {
  return <section className="admin-user-section admin-preview-table"><h2>{table.title}</h2><div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((value, cellIndex) => <td key={cellIndex}>{linkFor(value)}</td>)}</tr>)}</tbody></table></div></section>;
}

function linkFor(value: string): ReactNode {
  const detailLinks: Array<[string, string]> = [
    ["preview-user-001", "/users/preview-user-001"], ["preview-cycle-001", "/campaigns/preview-cycle-001"],
    ["preview-account-001", "/instagram/preview-account-001"], ["preview-payment-001", "/billing/preview-payment-001"], ["preview-audit-001", "/audit/preview-audit-001"],
  ];
  for (const [needle, href] of detailLinks) if (value.includes(needle)) return <a href={href}>{value}</a>;
  return value;
}

function PreviewContent({ data }: { data: PreviewPageData }) {
  return <>
    <div className="admin-preview-ribbon" role="status"><strong>SYNTHETIC PREVIEW DATA</strong><span>Illustrative records only · no database, Admin session, or provider is used.</span></div>
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN · PREVIEW</p><h1>{data.title}</h1><p>{data.description}</p></div><span className="admin-readonly-pill">Visual preview only</span></div>
    {data.reportPlaceholder ? <section className="admin-empty-state admin-preview-placeholder"><span className="admin-empty-icon" aria-hidden="true">▤</span><h2>Reports remains a placeholder</h2><p>Report data and populated report visuals have not been implemented. This preview intentionally shows the current placeholder state.</p></section> : null}
    {data.summary ? <div className="admin-summary-grid">{data.summary.map((item) => <article className="admin-summary-card" key={item.label}><div className="admin-summary-card-top"><span className="admin-summary-state">Synthetic sample</span></div><h2>{item.label}</h2><div className="admin-summary-placeholder">{item.value}</div><p>{item.note}</p></article>)}</div> : null}
    {data.details ? <section className="admin-user-profile admin-preview-details"><div><p className="admin-eyebrow">SAMPLE RECORD</p><h2>Details</h2><p>All values below are fabricated for visual review.</p></div><dl>{data.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl></section> : null}
    {data.tables?.map((table) => <Table key={table.title} table={table} />)}
  </>;
}

export function AdminPreviewPage({ pathname, data }: { pathname: string; data: PreviewPageData | null }) {
  if (!data) return <main className="admin-preview-not-found"><h1>Preview page not found</h1><p>No route or data exists for this path.</p><a href="/">Open Overview</a></main>;
  return <div className="admin-layout admin-preview-layout">
    <aside className="admin-sidebar" aria-label="Synthetic Admin preview navigation">
      <a className="admin-brand" href="/" aria-label="Synthetic Admin preview overview"><span className="admin-brand-mark" aria-hidden="true">C</span><span><strong>ClipForge</strong><small>ADMIN PREVIEW</small></span></a>
      <div className="admin-nav-groups">{["Workspace", "Monitoring", "Administration"].map((group) => <section className="admin-nav-group" key={group} aria-label={group}><p className="admin-nav-label">{group}</p><nav aria-label={`${group} preview navigation`}>{NAV.filter((item) => item.group === group).map((item) => <a key={item.id} className="admin-nav-link" href={item.href} aria-current={data.section === item.id ? "page" : undefined}><span className="admin-nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>{data.section === item.id && <span className="admin-nav-active-mark" aria-hidden="true" />}</a>)}</nav></section>)}</div>
      <div className="admin-sidebar-footer"><span className="admin-status-dot" aria-hidden="true" /><span><strong>Synthetic preview</strong><small>No live data source</small></span></div>
    </aside>
    <div className="admin-main-column"><header className="admin-topbar"><span className="admin-breadcrumb">Preview <span aria-hidden="true">/</span> {NAV.find((item) => item.id === data.section)?.label}</span><span className="admin-live-status"><span className="admin-status-dot" aria-hidden="true" />Synthetic preview data</span></header><main className="admin-main-content"><PreviewContent data={data} /></main><footer className="admin-footer"><span>ClipForge Admin Preview</span><span>Fabricated records · not connected to live services</span></footer></div>
  </div>;
}
