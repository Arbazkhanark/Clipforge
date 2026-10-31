import { FlashMessage } from "./FlashMessage.tsx";
import type { Flash } from "../server/flash.ts";

type Mode = "login" | "register" | "forgot" | "reset" | "verify";
const TITLES: Record<Mode, string> = { login: "Sign in", register: "Create your account", forgot: "Forgot your password?", reset: "Choose a new password", verify: "Confirm your email" };
const ACTIONS: Record<Mode, string> = { login: "/api/auth/login", register: "/api/auth/register", forgot: "/api/auth/forgot-password", reset: "/api/auth/reset-password", verify: "/api/auth/verify-email" };
const BUTTONS: Record<Mode, string> = { login: "Sign in", register: "Create account", forgot: "Send reset link", reset: "Change password", verify: "Confirm my email" };

/**
 * Account forms. They are ENABLED only when the runtime really provides authentication (`available`). Otherwise the fields
 * are shown but the button is disabled and says why - nothing pretends to work.
 */
export function AuthForm({ mode, demoMode, available = false, flash = null, token = null }: { mode: Mode; demoMode: boolean; available?: boolean; flash?: Flash | null; token?: string | null }) {
  const isRegister = mode === "register"; const needsEmail = mode === "login" || mode === "register" || mode === "forgot"; const needsPassword = mode === "login" || mode === "register" || mode === "reset";
  return (
    <section aria-labelledby="auth-heading" className="auth-card">
      <h1 id="auth-heading">{TITLES[mode]}</h1>
      <FlashMessage flash={flash} />
      {!available && <p role="note" className="notice">Accounts and sign-in are not available yet: there is no authentication or database in this build. The form below cannot be submitted.</p>}
      {available && <p role="note" className="notice" data-auth-mode="local">Local development accounts: they live in server memory and disappear when the server restarts.</p>}
      <form method="post" action={available ? ACTIONS[mode] : "#"} aria-describedby="auth-heading">
        {mode === "verify" && <p>Press the button to confirm that this is your email address.</p>}
        {(mode === "verify" || mode === "reset") && <input type="hidden" name="token" value={token ?? ""} />}
        {isRegister && <p><label>Name<br /><input type="text" name="name" autoComplete="name" maxLength={100} /></label></p>}
        {needsEmail && <p><label>Email<br /><input type="email" name="email" autoComplete="email" required /></label></p>}
        {needsPassword && <p><label>{mode === "reset" ? "New password" : "Password"}<br /><input type="password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? undefined : 10} required /></label></p>}
        <button type="submit" disabled={!available}>{available ? BUTTONS[mode] : `${BUTTONS[mode]} (not available yet)`}</button>
      </form>
      {mode === "login" && <p>{available && <><a href="/forgot-password">Forgot your password?</a> - </>}New here? <a href="/register">Create an account</a></p>}
      {isRegister && <p>Already have an account? <a href="/login">Sign in</a></p>}
      {demoMode && <p role="note">Demo mode is on: you are already using a sample user. <a href="/dashboard">Open the dashboard</a></p>}
    </section>
  );
}
