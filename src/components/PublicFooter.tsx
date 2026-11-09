import React from 'react';

export function PublicFooter() {
  return (
    <footer className="site-footer">
    <div className="site-footer-inner">
      <div><a href="/" className="site-brand"><span className="site-brand-mark" aria-hidden="true">C</span><span>ClipForge</span></a><p>Prepare short-form video workflows in one organized workspace.</p></div>
      <nav aria-label="Footer">
        <a href="/about">About</a><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/how-it-works">How it works</a>
        <a href="/contact">Contact</a><a href="/help">Help &amp; FAQ</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/cookies">Cookies</a><a href="/refunds">Refunds</a>
      </nav>
      <p className="site-footer-note">Instagram publishing depends on account eligibility, Meta permissions, and server configuration. No advertising scripts are loaded in this build.</p>
    </div>
  </footer>
  );
}