import type { ReactNode } from "react";
import "./globals.css";
import { getRuntime } from "../src/server/runtime.ts";

export const metadata = {
  title: { default: "ClipForge", template: "%s | ClipForge" },
  description: "Organise short-form videos, share collections, and schedule publishing. Early development.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const signedIn = (await getRuntime().currentUserId()) !== null;
  return (
    <html lang="en">
      <body>
        <a href="#main" className="muted">Skip to main content</a>
        <header className="site-header">
          <nav aria-label="Main">
            <a href="/">ClipForge</a>
            <a href="/pricing">Pricing</a>
            <a href="/dashboard">Dashboard</a>
            {signedIn ? <span data-auth-state="signed-in">Signed in</span> : <a href="/login" data-auth-state="signed-out">Sign in</a>}
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="muted">ClipForge is in early development.</footer>
      </body>
    </html>
  );
}
