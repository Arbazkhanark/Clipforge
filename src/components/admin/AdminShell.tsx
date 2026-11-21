import type { ReactNode } from "react";

export const ADMIN_SECTIONS = [
  { id: "overview", label: "Overview", href: "/admin", icon: "◫", group: "Workspace" },
  { id: "users", label: "Users", href: "/admin/users", icon: "♙", group: "Workspace" },
  { id: "campaigns", label: "Campaigns", href: "/admin/campaigns", icon: "▣", group: "Workspace" },
  { id: "plans", label: "Plans", href: "/admin/plans", icon: "◇", group: "Workspace" },
  { id: "complimentary-access", label: "Complimentary access", href: "/admin/complimentary-access", icon: "✦", group: "Workspace" },
  { id: "offers", label: "Offers", href: "/admin/offers", icon: "%", group: "Workspace" },
  { id: "instagram", label: "Instagram", href: "/admin/instagram", icon: "◎", group: "Monitoring" },
  { id: "billing", label: "Billing", href: "/admin/billing", icon: "◈", group: "Monitoring" },
  { id: "analytics", label: "Analytics", href: "/admin/analytics", icon: "⌁", group: "Monitoring" },
  { id: "reports", label: "Reports", href: "/admin/reports", icon: "▤", group: "Monitoring" },
  { id: "settings", label: "Settings", href: "/admin/settings", icon: "⚙", group: "Administration" },
  { id: "audit", label: "Audit Logs", href: "/admin/audit", icon: "◷", group: "Administration" },
] as const;

export type AdminSectionId = (typeof ADMIN_SECTIONS)[number]["id"];

export function AdminShell({ children, activeSection, dataStatus = "unavailable" }: { children: ReactNode; activeSection: AdminSectionId; dataStatus?: "available" | "unavailable" }) {
  return (
    <div className="admin-layout">
      <aside className="admin-sidebar" aria-label="Admin workspace">
        <a className="admin-brand" href="/admin" aria-label="ClipForge Admin overview">
          <span className="admin-brand-mark" aria-hidden="true">C</span>
          <span><strong>ClipForge</strong><small>ADMIN CONSOLE</small></span>
        </a>

        <div className="admin-nav-groups">
          {["Workspace", "Monitoring", "Administration"].map((group) => (
            <section className="admin-nav-group" key={group} aria-label={group}>
              <p className="admin-nav-label">{group}</p>
              <nav aria-label={`${group} navigation`}>
                {ADMIN_SECTIONS.filter((section) => section.group === group).map((section) => (
                  <a
                    key={section.id}
                    className="admin-nav-link"
                    href={section.href}
                    aria-current={activeSection === section.id ? "page" : undefined}
                  >
                    <span className="admin-nav-icon" aria-hidden="true">{section.icon}</span>
                    <span>{section.label}</span>
                    {activeSection === section.id && <span className="admin-nav-active-mark" aria-hidden="true" />}
                  </a>
                ))}
              </nav>
            </section>
          ))}
        </div>

        <div className="admin-sidebar-footer">
          <span className="admin-status-dot" aria-hidden="true" />
          <span><strong>Admin control center</strong><small>{dataStatus === "available" ? "Stored records available" : "Live data not connected"}</small></span>
        </div>
      </aside>

      <div className="admin-main-column">
        <header className="admin-topbar">
          <span className="admin-breadcrumb">Administration <span aria-hidden="true">/</span> {ADMIN_SECTIONS.find((section) => section.id === activeSection)?.label}</span>
          <span className="admin-live-status"><span className="admin-status-dot" aria-hidden="true" />{dataStatus === "available" ? "Stored records available" : "Live data not connected"}</span>
        </header>
        <main className="admin-main-content">{children}</main>
        <footer className="admin-footer"><span>ClipForge Admin</span><span>Private workspace · actions appear only where a protected operation is supported</span></footer>
      </div>
    </div>
  );
}
