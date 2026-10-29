import type { ReactNode } from "react";
import type { RuntimeMode } from "../server/runtime.ts";

const LINKS: [string, string][] = [["/dashboard", "Dashboard"], ["/media", "Media library"], ["/collections", "Collections"], ["/cycles", "Publishing cycles"], ["/pricing", "Plans"]];

/** Navigation + content area for signed-in screens. Responsive with CSS only (sidebar on wide screens, wrapped links on narrow ones). */
export function AppShell({ mode, children }: { mode: RuntimeMode; children: ReactNode }) {
  return (
    <div className="app-shell">
      <nav aria-label="App" className="app-nav">
        <ul>{LINKS.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}</ul>
      </nav>
      <div className="app-content">
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
