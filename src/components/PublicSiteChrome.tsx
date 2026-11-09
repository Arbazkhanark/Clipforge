"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation.js";

export function shouldShowPublicSiteChrome(pathname: string | null): boolean {
  return !pathname?.startsWith("/admin");
}

export function PublicSiteChrome({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const body = document.body;
    if (!shouldShowPublicSiteChrome(pathname)) {
      body.classList.remove("clipforge-public", "clipforge-dark");
      return;
    }
    body.classList.add("clipforge-public");
    let saved: string | null = null;
    try { saved = window.localStorage.getItem("clipforge:theme"); } catch { /* Storage can be unavailable in private browsing. */ }
    const initial = saved === "dark" || saved === "light" ? saved : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    setTheme(initial);
    body.classList.toggle("clipforge-dark", initial === "dark");
  }, [pathname]);

  if (!shouldShowPublicSiteChrome(pathname)) return null;

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.body.classList.toggle("clipforge-dark", next === "dark");
    try { window.localStorage.setItem("clipforge:theme", next); } catch { /* Theme still works for this page view. */ }
  };

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <a href="/" className="site-brand" aria-label="ClipForge home"><span className="site-brand-mark" aria-hidden="true">C</span><span>ClipForge</span></a>
          <nav aria-label="Main" className="site-primary-nav">
            <a href="/features">Features</a>
            <a href="/how-it-works">How it works</a>
            <a href="/pricing">Pricing</a>
          </nav>
          <div className="site-header-actions">
            <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} aria-pressed={theme === "dark"}>
              <span aria-hidden="true">{theme === "dark" ? "☼" : "◐"}</span><span className="theme-toggle-label">{theme === "dark" ? "Light" : "Dark"}</span>
            </button>
            <a className="site-workspace-link" href={signedIn ? "/dashboard" : "/login"} data-auth-state={signedIn ? "signed-in" : "signed-out"}>{signedIn ? "Open workspace" : "Sign in"}</a>
            {!signedIn && <a className="site-primary-cta" href="/register">Get started</a>}
          </div>
        </div>
      </header>

    </>
  );
}
