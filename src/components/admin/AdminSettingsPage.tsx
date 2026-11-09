import { AdminShell } from "./AdminShell.tsx";
import { requireAdminPage } from "../../server/admin/page-authorization.ts";
import { buildAdminPlatformSettings, type PlatformSetting } from "../../server/admin/platform-settings.ts";

const STATE_LABEL: Record<PlatformSetting["state"], string> = {
  configured: "Configured",
  incomplete: "Incomplete",
  missing: "Missing",
  application_default: "Application default",
  not_implemented: "Unavailable",
};

export async function renderAdminSettingsPage() {
  await requireAdminPage();
  return <AdminSettingsPage />;
}

export function AdminSettingsPage() {
  const settings = buildAdminPlatformSettings();
  return <AdminShell activeSection="settings">
    <div className="admin-page-heading"><div><p className="admin-eyebrow">CLIPFORGE ADMIN</p><h1>Platform settings</h1><p>Read-only configuration status from application defaults and server environment.</p></div><span className="admin-readonly-pill">◉ Read-only</span></div>
    <section className="admin-settings-notice" role="status"><strong>Configuration is not a connection check</strong><span>Secret values are never displayed. “Configured” means local configuration checks passed or a setting is present. No external service is contacted, and no service is marked live-verified.</span><span className="admin-settings-environment">Environment: <b>{settings.environment}</b><i>{settings.runtimeMode}</i></span></section>
    <div className="admin-settings-grid">
      {settings.groups.map((group) => <section className="admin-settings-card" key={group.title}>
        <div className="admin-settings-card-heading"><h2>{group.title}</h2><span>Read-only</span></div>
        <div className="admin-settings-list">{group.items.map((entry) => <article className="admin-settings-item" key={entry.label}>
          <div className="admin-settings-item-title"><h3>{entry.label}</h3><span className={`admin-setting-state admin-setting-state-${entry.state}`}>{STATE_LABEL[entry.state]}</span></div>
          <p>{entry.summary}</p>
          {entry.details.map((detail) => <small key={detail}>{detail}</small>)}
          <small className="admin-settings-verification">Live verification: Not performed</small>
        </article>)}</div>
      </section>)}
    </div>
    <section className="admin-settings-card admin-settings-plans"><div className="admin-settings-card-heading"><div><h2>Current plan catalog</h2><p>Application constants used by the existing plan and checkout code.</p></div><span>Source: code catalog</span></div>
      <div className="admin-user-table-wrap"><table className="admin-user-table"><thead><tr><th>Plan</th><th>Weekly</th><th>Monthly</th><th>Connected accounts</th><th>Storage</th><th>Active campaigns</th></tr></thead><tbody>{settings.plans.map((plan) => <tr key={plan.id}><td>{plan.name}</td><td>{plan.weekly}</td><td>{plan.monthly}</td><td>{plan.connectedAccounts}</td><td>{plan.storageGiB} GiB</td><td>{plan.activeCampaigns}</td></tr>)}</tbody></table></div>
      <small>These are configured plan rules, not proof of any user’s current entitlement. No settings can be edited here.</small>
    </section>
  </AdminShell>;
}
