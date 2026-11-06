import type { ReactNode } from "react";
import type { EmailDelivery, RuntimeMode } from "../server/runtime.ts";

const LINKS: [string, string][] = [["/dashboard", "Dashboard"], ["/media", "Media library"], ["/collections", "Collections"], ["/cycles", "Publishing cycles"], ["/editor", "Editor"], ["/pricing", "Plans"]];

/** Navigation + content area for signed-in screens. Responsive with CSS only (sidebar on wide screens, wrapped links on narrow ones). */
export function AppShell({ mode, emailDelivery, children }: { mode: RuntimeMode; emailDelivery?: EmailDelivery; children: ReactNode }) {
  return (
    <div className="app-shell">
      <nav aria-label="App" className="app-nav">
        <ul>{LINKS.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
      </nav>
      <div className="app-content">
        {mode === "local" && (
          <div role="note" className="notice" data-local-banner>
            <p>Local development mode: accounts and data live in server memory and disappear when the server restarts. No email is sent (see <a href="/dev/outbox">the outbox</a>).</p>
            <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
          </div>
        )}
        {mode === "database" && (
          <div role="note" className="notice" data-database-banner>
            <p>Accounts, media details, collections, and publishing cycles are stored in the database. Uploaded files are saved in a private folder on this computer when that folder is configured, and they are not stored in the database or in memory. {emailDelivery === "outbox" ? "Confirmation messages stay in the local outbox. No email company is connected." : "Email is not sent, so new accounts stay unverified and can still sign in."} Instagram, payments, and cloud file storage are not connected.</p>
            <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
          </div>
        )}
        {mode === "demo" && (
          <p role="note" className="notice" data-demo-banner>
            Demo mode: you are using built-in SAMPLE data held in server memory. It resets when the server restarts. Nothing is uploaded, stored, or published,
            and these screens are read-only previews.
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
