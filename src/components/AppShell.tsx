"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { RuntimeMode } from "../server/runtime.ts";
import { TrialReminder } from "./TrialReminder.tsx";

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
  signedIn,
  googleConfigured,
  activeTrialEndsAt,
  children,
}: {
  mode: RuntimeMode;
  signedIn: boolean;
  googleConfigured: boolean;
  activeTrialEndsAt: number | null;
  children: ReactNode;
}) {
  const [pathname, setPathname] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const updatePath = () => setPathname(window.location.pathname);
    updatePath();
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <div className="app-shell workspace-shell">
      {menuOpen && <button className="workspace-nav-backdrop" type="button" aria-label="Close workspace navigation" onClick={() => setMenuOpen(false)} />}
      <aside id="workspace-navigation" className="workspace-sidebar" data-open={menuOpen} inert={isMobile && !menuOpen}>
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
                  aria-current={pathname === href || (href !== "/dashboard" && pathname?.startsWith(`${href}/`)) ? "page" : undefined}
                  className={
                    href === "/dashboard"
                      ? `workspace-nav-link workspace-nav-dashboard${pathname === href ? " is-active" : ""}`
                      : `workspace-nav-link${pathname === href || pathname?.startsWith(`${href}/`) ? " is-active" : ""}`
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
          <div className="workspace-topbar-leading">
            <button className="workspace-menu-toggle" type="button" aria-controls="workspace-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              <span aria-hidden="true">☰</span><span>{menuOpen ? "Close menu" : "Menu"}</span>
            </button>
            <span className="workspace-topbar-label">MY WORKSPACE</span>
          </div>
          <div className="workspace-topbar-trailing">
            <div className="workspace-topbar-account"><span className="workspace-account-dot" /><span>{signedIn ? "Signed in" : "Guest"}</span></div>
            <SessionActions signedIn={signedIn} googleConfigured={googleConfigured} />
          </div>
        </header>

        <main className="app-content">
          <TrialReminder trialEndsAt={activeTrialEndsAt} />
          {mode === "local" && (
            <div role="note" className="notice" data-local-banner>
              <p>
                Local development mode: accounts and data live in server
                memory and disappear when the server restarts. No email
                provider is connected, so account verification and
                password-reset messages are unavailable here.
              </p>
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
