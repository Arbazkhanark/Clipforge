// src/components/AppShell.tsx
import type { ReactNode } from "react";
import type { EmailDelivery, RuntimeMode } from "../server/runtime.ts";

const LINKS: [string, string][] = [["/dashboard", "Dashboard"], ["/media", "Media library"], ["/collections", "Collections"], ["/cycles", "Publishing cycles"], ["/instagram", "Instagram"], ["/editor", "Editor"], ["/pricing", "Plans"]];

function SessionActions({ signedIn, googleConfigured }: { signedIn: boolean; googleConfigured: boolean }) {
  if (!signedIn) return <p><a href="/login">Sign in</a></p>;
  return (
    <>
      <form method="post" action="/api/auth/logout"><button type="submit">Sign out</button></form>
      {googleConfigured ? <form method="post" action="/api/auth/google/start"><input type="hidden" name="intent" value="link" /><button type="submit">Connect Google</button></form> : <p className="muted">Google sign-in is not configured.</p>}
    </>
  );
}

/** Navigation + content area for signed-in screens. Responsive with CSS only (sidebar on wide screens, wrapped links on narrow ones). */
export function AppShell({ mode, emailDelivery, signedIn, googleConfigured, children }: { mode: RuntimeMode; emailDelivery?: EmailDelivery; signedIn: boolean; googleConfigured: boolean; children: ReactNode }) {
  return (
    <div className="app-shell workspace-shell">
      <nav aria-label="Workspace" className="app-nav">
        <a href="/dashboard" className="app-nav-brand"><span className="site-brand-mark" aria-hidden="true">C</span><span><strong>Workspace</strong><small>Organize the next step</small></span></a>
        <ul>{LINKS.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
        <p className="app-nav-help">Need a guide? <a href="/help">Browse help and FAQs</a></p>
      </nav>
      <div className="app-content">
        {mode === "local" && (
          <div role="note" className="notice" data-local-banner>
            <p>Local development mode: accounts and data live in server memory and disappear when the server restarts. No email provider is connected, so account verification and password-reset messages are unavailable here.</p>
            <SessionActions signedIn={signedIn} googleConfigured={googleConfigured} />
          </div>
        )}
        {mode === "database" && (
          <div role="note" className="notice" data-database-banner>
            <p>This deployment is configured to store accounts, media details, collections, and publishing cycles in PostgreSQL when each operation succeeds. Uploaded files use the configured private storage adapter; they are not stored in PostgreSQL or in memory. If a request reports that the database is unavailable, that operation was not confirmed as saved. {emailDelivery === "outbox" ? "A real email provider is not connected, so confirmation messages are unavailable to account holders." : "Email is not sent, so new accounts stay unverified and can still sign in."} Instagram publishing and payment availability are shown on their respective pages. Cloud S3 storage is not connected.</p>
            <SessionActions signedIn={signedIn} googleConfigured={googleConfigured} />
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
