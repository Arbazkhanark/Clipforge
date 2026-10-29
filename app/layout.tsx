import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: { default: "ClipForge", template: "%s | ClipForge" },
  description: "Organise short-form videos, share collections, and schedule publishing. Early development.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="muted">Skip to main content</a>
        <header className="site-header">
          <nav aria-label="Main">
            <a href="/">ClipForge</a>
            <a href="/pricing">Pricing</a>
            <a href="/dashboard">Dashboard</a>
            <a href="/login">Sign in</a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="muted">ClipForge is in early development.</footer>
      </body>
    </html>
  );
}
