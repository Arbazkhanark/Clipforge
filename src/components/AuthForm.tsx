import { FlashMessage } from "./FlashMessage.tsx";
import type { Flash } from "../server/flash.ts";
import type { EmailDelivery } from "../server/runtime.ts";

type Mode = "login" | "register" | "forgot" | "reset" | "verify";
const TITLES: Record<Mode, string> = { login: "Sign in", register: "Create your account", forgot: "Forgot your password?", reset: "Choose a new password", verify: "Confirm your email" };
const ACTIONS: Record<Mode, string> = { login: "/api/auth/login", register: "/api/auth/register", forgot: "/api/auth/forgot-password", reset: "/api/auth/reset-password", verify: "/api/auth/verify-email" };
const BUTTONS: Record<Mode, string> = { login: "Sign in", register: "Create account", forgot: "Request reset link", reset: "Change password", verify: "Confirm my email" };

/**
 * Account forms. They are ENABLED only when the runtime really provides authentication (`available`). Otherwise the fields
 * are shown but the button is disabled and says why - nothing pretends to work.
 */
export function AuthForm({ mode, demoMode, available = false, flash = null, token = null, persistence = "memory", emailDelivery, googleConfigured = false, returnTo = "/dashboard" }: { mode: Mode; demoMode: boolean; available?: boolean; flash?: Flash | null; token?: string | null; persistence?: "memory" | "database"; emailDelivery?: EmailDelivery; googleConfigured?: boolean; returnTo?: string }) {
  const isRegister = mode === "register"; const needsEmail = mode === "login" || mode === "register" || mode === "forgot"; const needsPassword = mode === "login" || mode === "register" || mode === "reset";
  return (
    <section aria-labelledby="auth-heading" className="auth-card">
      <h1 id="auth-heading">{TITLES[mode]}</h1>
      <FlashMessage flash={flash} />
      {!available && <p role="note" className="notice">Accounts and sign-in are not available yet: there is no authentication or database in this build. The form below cannot be submitted.</p>}
      {available && persistence === "memory" && <p role="note" className="notice" data-auth-mode="local">Local development accounts live in server memory and disappear when the server restarts. No email provider is connected, so verification and password-reset messages are unavailable.</p>}
      {available && persistence === "database" && emailDelivery === "outbox" && <p role="note" className="notice" data-auth-mode="database-outbox">This deployment is configured to store accounts and sessions in PostgreSQL. If a request reports that the database is unavailable, that operation was not confirmed as saved. No email provider is connected; confirmation and password-reset messages are unavailable, and new accounts remain unverified.</p>}
      {available && persistence === "database" && emailDelivery !== "outbox" && <p role="note" className="notice" data-auth-mode="database">This deployment is configured to store accounts and sessions in PostgreSQL. If a request reports that the database is unavailable, that operation was not confirmed as saved. Email confirmation and password-reset email are not available yet, so no message is sent and the account stays unverified.</p>}
      <form method="post" action={available ? ACTIONS[mode] : "#"} aria-describedby="auth-heading">
        {mode === "verify" && <p>Press the button to confirm that this is your email address.</p>}
        {(mode === "verify" || mode === "reset") && <input type="hidden" name="token" value={token ?? ""} />}
        {(mode === "login" || mode === "register") && <input type="hidden" name="returnTo" value={returnTo} />}
        {isRegister && <p><label>Name<br /><input type="text" name="name" autoComplete="name" maxLength={100} /></label></p>}
        {needsEmail && <p><label>Email<br /><input type="email" name="email" autoComplete="email" required /></label></p>}
        {needsPassword && <p><label>{mode === "reset" ? "New password" : "Password"}<br /><input type="password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? undefined : 10} required /></label></p>}
        <button type="submit" disabled={!available}>{available ? BUTTONS[mode] : `${BUTTONS[mode]} (not available yet)`}</button>
      </form>
      {available && googleConfigured && (mode === "login" || mode === "register") && (
        <form method="post" action="/api/auth/google/start">
          <input type="hidden" name="intent" value="login" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit">Continue with Google</button>
        </form>
      )}
      {available && !googleConfigured && (mode === "login" || mode === "register") && <p role="note" className="muted">Google sign-in is not configured for this deployment.</p>}
      {mode === "login" && <p>{available && <><a href="/forgot-password">Forgot your password?</a> - </>}New here? <a href={returnTo === "/dashboard" ? "/register" : `/register?returnTo=${encodeURIComponent(returnTo)}`}>Create an account</a></p>}
      {isRegister && <p>Already have an account? <a href={returnTo === "/dashboard" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</a></p>}
      {demoMode && <p role="note">Demo mode is on: you are already using a sample user. <a href="/dashboard">Open the dashboard</a></p>}
    </section>
  );
}
