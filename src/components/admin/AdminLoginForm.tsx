import { FlashMessage } from "../FlashMessage.tsx";
import type { Flash } from "../../server/flash.ts";

export function AdminLoginForm({ available, flash, passwordAuthEnabled = false }: { available: boolean; flash: Flash | null; passwordAuthEnabled?: boolean }) {
  return (
    <div className="admin-login-page">
      <section aria-labelledby="admin-login-title" className="admin-login-card">
        <div className="admin-login-brand" aria-label="ClipForge administrator sign in">
          <span className="admin-login-brand-mark" aria-hidden="true">C</span>
          <span><strong>ClipForge</strong><small>ADMIN CONSOLE</small></span>
        </div>
        <div className="admin-login-intro">
          <p className="admin-login-eyebrow">PRIVATE WORKSPACE</p>
          <h1 id="admin-login-title">Administrator sign in</h1>
          <p>Sign in with your ClipForge administrator account to continue.</p>
        </div>
        <FlashMessage flash={flash} />
        {!passwordAuthEnabled && <p role="status" className="admin-login-unavailable">Email and password admin sign-in is disabled. Use your Google account; administrator access still requires the existing admin role. <a href="/login">Continue to Google sign-in</a>.</p>}
        {passwordAuthEnabled && !available && <p role="status" className="admin-login-unavailable">Admin sign-in is unavailable right now.</p>}
        {passwordAuthEnabled && <form className="admin-login-form" method="post" action={available ? "/api/admin/login" : "#"}>
          <label className="admin-login-field">
            <span>Email address</span>
            <input type="email" name="email" autoComplete="username" maxLength={320} required />
          </label>
          <label className="admin-login-field">
            <span>Password</span>
            <input type="password" name="password" autoComplete="current-password" maxLength={1024} required />
          </label>
          <button className="admin-login-submit" type="submit" disabled={!available}>Sign in to Admin</button>
        </form>}
        <div className="admin-login-security-note"><span aria-hidden="true">●</span> Protected administrator access</div>
      </section>
      <p className="admin-login-footer">ClipForge · Administrator access · First Admin provisioning is operator-only.</p>
    </div>
  );
}
