import { FlashMessage } from "./FlashMessage.tsx";
import { AuthPasswordField } from "./AuthPasswordField.tsx";
import { AuthSubmitButton } from "./AuthSubmitButton.tsx";
import type { Flash } from "../server/flash.ts";
import type { EmailDelivery } from "../server/runtime.ts";

type Mode = "login" | "register" | "forgot" | "reset" | "verify";
const TITLES: Record<Mode, string> = { login: "Sign in", register: "Create your account", forgot: "Forgot your password?", reset: "Choose a new password", verify: "Confirm your email" };
const ACTIONS: Record<Mode, string> = { login: "/api/auth/login", register: "/api/auth/register", forgot: "/api/auth/forgot-password", reset: "/api/auth/reset-password", verify: "/api/auth/verify-email" };
const BUTTONS: Record<Mode, string> = { login: "Sign in", register: "Create account", forgot: "Request reset link", reset: "Change password", verify: "Confirm my email" };
const PENDING_BUTTONS: Record<Mode, string> = { login: "Signing in…", register: "Creating account…", forgot: "Sending request…", reset: "Updating password…", verify: "Confirming email…" };

function GoogleMark() {
  return (
    <svg aria-hidden="true" className="auth-google-mark" viewBox="0 0 48 48">
      <path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z" />
      <path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z" />
      <path fill="#FBBC05" d="M12.6 27.7a12 12 0 0 1 0-7.4V15H5.8a20 20 0 0 0 0 17.9l6.8-5.2Z" />
      <path fill="#EA4335" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 5.8 29.5 4 24 4A20 20 0 0 0 5.8 15l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z" />
    </svg>
  );
}

/** Account forms submit to the existing server routes; this component changes presentation only. */
export function AuthForm({ mode, demoMode, available = false, flash = null, token = null, persistence = "memory", emailDelivery, googleConfigured = false, returnTo = "/dashboard" }: { mode: Mode; demoMode: boolean; available?: boolean; flash?: Flash | null; token?: string | null; persistence?: "memory" | "database"; emailDelivery?: EmailDelivery; googleConfigured?: boolean; returnTo?: string }) {
  const isRegister = mode === "register";
  const isSignInOrRegister = mode === "login" || isRegister;
  const needsEmail = mode === "login" || isRegister || mode === "forgot";
  const needsPassword = mode === "login" || isRegister || mode === "reset";

  const formContent = (
    <>
      <p className="auth-panel-eyebrow">{isRegister ? "START WITH A CLEAR WORKFLOW" : "YOUR WORKSPACE, READY WHEN YOU ARE"}</p>
      <h1 id="auth-heading">{isRegister ? "Create your account" : mode === "login" ? "Sign in" : TITLES[mode]}</h1>
      {isSignInOrRegister && <p className="auth-panel-description">{isRegister ? "Set up your ClipForge workspace and bring your content workflow together." : "Sign in to pick up where your content workflow left off."}</p>}
      <FlashMessage flash={flash} variant={isSignInOrRegister ? "toast" : "default"} />

      {!available && <p role="note" className="notice">Accounts and sign-in are not available yet: there is no authentication or database in this build. The form below cannot be submitted.</p>}
      {available && persistence === "memory" && <aside role="note" className="auth-storage-note"><strong>Local development mode</strong><span>Accounts stay in server memory and disappear when the server restarts. Email verification and password-reset messages are unavailable.</span></aside>}
      {available && persistence === "database" && <aside role="note" className="auth-storage-note"><strong>Account storage</strong><span>This deployment stores accounts and sessions in PostgreSQL. If the database reports an error, the operation was not confirmed as saved. {emailDelivery === "ses" || emailDelivery === "nodemailer" ? "Email confirmation and password-reset messages use the configured server-side provider." : "No email provider is connected, so confirmation and password-reset messages are not sent; new accounts remain unverified."}</span></aside>}

      {available && googleConfigured && isSignInOrRegister && (
        <form method="post" action="/api/auth/google/start" className="auth-google-form">
          <input type="hidden" name="intent" value="login" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button type="submit" className="auth-google-button"><GoogleMark /><span>Continue with Google</span></button>
          <p className="auth-google-caption">Fast, secure sign-in with your Google account</p>
        </form>
      )}
      {available && !googleConfigured && isSignInOrRegister && <p role="note" className="muted auth-google-unavailable">Google sign-in is not configured for this deployment.</p>}

      {available && googleConfigured && isSignInOrRegister && <div className="auth-divider" aria-hidden="true"><span>or continue with email</span></div>}

      <form method="post" action={available ? ACTIONS[mode] : "#"} className="auth-fields" aria-describedby="auth-heading">
        {mode === "verify" && <p>Press the button to confirm that this is your email address.</p>}
        {(mode === "verify" || mode === "reset") && <input type="hidden" name="token" value={token ?? ""} />}
        {isSignInOrRegister && <input type="hidden" name="returnTo" value={returnTo} />}
        {isRegister && <div className="auth-field"><label><span>Name <small>Optional</small></span><input id="auth-name" type="text" name="name" autoComplete="name" maxLength={100} placeholder="Your name" /></label></div>}
        {needsEmail && <div className="auth-field"><label><span>Email address</span><input id="auth-email" type="email" name="email" autoComplete="email" required placeholder="you@example.com" /></label></div>}
        {needsPassword && <div className="auth-field"><label htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}</label><AuthPasswordField id="auth-password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? undefined : 10} required placeholder={mode === "login" ? "Enter your password" : "At least 10 characters"} /></div>}
        {isRegister && <p className="auth-password-hint">Use 10–128 characters. Avoid common or highly repetitive passwords, and don’t use your email address.</p>}
        {mode === "login" && available && <a className="auth-forgot-link" href="/forgot-password">Forgot your password?</a>}
        <AuthSubmitButton available={available} label={BUTTONS[mode]} pendingLabel={PENDING_BUTTONS[mode]} />
      </form>

      {mode === "login" && <p className="auth-switch-link">New to ClipForge? <a href={returnTo === "/dashboard" ? "/register" : `/register?returnTo=${encodeURIComponent(returnTo)}`}>Create an account</a></p>}
      {isRegister && <p className="auth-switch-link">Already have an account? <a href={returnTo === "/dashboard" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</a></p>}
      {demoMode && <p role="note" className="notice">Demo mode is on: you are already using a sample user. <a href="/dashboard">Open the dashboard</a></p>}
    </>
  );

  if (!isSignInOrRegister) return <section aria-labelledby="auth-heading" className="auth-card">{formContent}</section>;

  return (
    <section className={`auth-screen auth-screen--${mode}`} aria-labelledby="auth-heading">
      <div className="auth-story">
        <p className="auth-story-kicker"><span aria-hidden="true" /> THE CREATOR WORKFLOW, IN ONE PLACE</p>
        <h2>Make more.<br /><em>Manage less.</em></h2>
        <p className="auth-story-copy">Bring your videos, branded edits, collections and publishing plans into one thoughtfully organized workspace.</p>
        <ul className="auth-story-list">
          <li><span aria-hidden="true">01</span> Organize your video library</li>
          <li><span aria-hidden="true">02</span> Prepare every edit with your style</li>
          <li><span aria-hidden="true">03</span> Plan campaigns and publishing</li>
        </ul>
        <p className="auth-story-footnote">Your workflow stays yours. Connect and configure the tools you choose.</p>
      </div>
      <div className="auth-panel-wrap">
        <div className="auth-card auth-card--branded">{formContent}</div>
        <p className="auth-panel-footnote">By continuing, you agree to use ClipForge responsibly and keep your account details secure.</p>
      </div>
    </section>
  );
}
