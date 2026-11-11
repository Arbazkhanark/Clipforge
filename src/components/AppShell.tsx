import type { ReactNode } from "react";
import type { EmailDelivery, RuntimeMode } from "../server/runtime.ts";

const LINKS: [string, string, string][] = [
  ["/dashboard", "Overview", "⌂"],
  ["/media", "Media library", "▣"],
  ["/collections", "Collections", "▤"],
  ["/cycles", "Publishing cycles", "◷"],
  ["/instagram", "Instagram", "◎"],
  ["/editor", "Video editor", "✎"],
  ["/pricing", "Plans & billing", "◇"],
];

function SessionActions({
  signedIn,
  googleConfigured,
}: {
  signedIn: boolean;
  googleConfigured: boolean;
}) {
  if (!signedIn) {
    return (
      <p>
        <a href="/login">Sign in</a>
      </p>
    );
  }

  return (
    <div className="workspace-session-actions">
      <form method="post" action="/api/auth/logout">
        <button type="submit">Sign out</button>
      </form>

      {googleConfigured ? (
        <form method="post" action="/api/auth/google/start">
          <input type="hidden" name="intent" value="link" />
          <button type="submit">Connect Google</button>
        </form>
      ) : (
        <p className="muted">Google sign-in is not configured.</p>
      )}
    </div>
  );
}

export function AppShell({
  mode,
  emailDelivery,
  signedIn,
  googleConfigured,
  children,
}: {
  mode: RuntimeMode;
  emailDelivery?: EmailDelivery;
  signedIn: boolean;
  googleConfigured: boolean;
  children: ReactNode;
}) {
  return (
    <div className="app-shell workspace-shell">
      <aside className="workspace-sidebar">
        <a href="/dashboard" className="workspace-brand">
          <span className="site-brand-mark" aria-hidden="true">
            C
          </span>
          <span>
            <strong>ClipForge</strong>
            <small>Creator workspace</small>
          </span>
        </a>

        <div className="workspace-nav-label">WORKSPACE</div>

        <nav aria-label="Workspace navigation">
          <ul className="workspace-nav-list">
            {LINKS.map(([href, label, icon]) => (
              <li key={href}>
                <a
                  href={href}
                  className={
                    href === "/dashboard"
                      ? "workspace-nav-link workspace-nav-dashboard"
                      : "workspace-nav-link"
                  }
                >
                  <span className="workspace-nav-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span>{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="workspace-sidebar-bottom">
          <div className="workspace-help-card">
            <strong>Need help?</strong>
            <p>Find answers and learn how to use ClipForge.</p>
            <a href="/help">Browse help →</a>
          </div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="workspace-topbar">
          <span className="workspace-topbar-label">MY WORKSPACE</span>
          <div className="workspace-topbar-account">
            <span className="workspace-account-dot" />
            <span>{signedIn ? "Signed in" : "Guest"}</span>
          </div>
        </header>

        <main className="app-content">
          {mode === "local" && (
            <div role="note" className="notice" data-local-banner>
              <p>
                Local development mode: accounts and data live in server
                memory and disappear when the server restarts. No email
                provider is connected, so account verification and
                password-reset messages are unavailable here.
              </p>
              <SessionActions
                signedIn={signedIn}
                googleConfigured={googleConfigured}
              />
            </div>
          )}

          {mode === "database" && (
            <div role="note" className="notice" data-database-banner>
              <p>
                This deployment is configured to store accounts, media
                details, collections, and publishing cycles in PostgreSQL
                when each operation succeeds. Uploaded files use the
                configured private storage adapter; they are not stored in
                PostgreSQL or in memory. If a request reports that the
                database is unavailable, that operation was not confirmed
                as saved.{" "}
                {emailDelivery === "outbox"
                  ? "A real email provider is not connected, so confirmation messages are unavailable to account holders."
                  : "Email is not sent, so new accounts stay unverified and can still sign in."}{" "}
                Instagram publishing and payment availability are shown on
                their respective pages. Cloud S3 storage is not connected.
              </p>

              <SessionActions
                signedIn={signedIn}
                googleConfigured={googleConfigured}
              />
            </div>
          )}

          {mode === "demo" && (
            <p role="note" className="notice" data-demo-banner>
              Demo mode: you are using built-in SAMPLE data held in server
              memory. It resets when the server restarts. Nothing is
              uploaded, stored, or published, and these screens are
              read-only previews.
            </p>
          )}

          {children}
        </main>
      </div>
    </div>
  );
}
