/**
 * Login / register form. Real authentication does not exist yet, so the submit button is DISABLED and
 * says why. The fields are real (labels, autocomplete, required) so the final form needs no redesign.
 */
export function AuthForm({ mode, demoMode }: { mode: "login" | "register"; demoMode: boolean }) {
  const isRegister = mode === "register";
  return (
    <section aria-labelledby="auth-heading" className="auth-card">
      <h1 id="auth-heading">{isRegister ? "Create your account" : "Sign in"}</h1>
      <p role="note" className="notice">Accounts and sign-in are not available yet: there is no authentication or database in this build. The form below cannot be submitted.</p>
      <form method="post" action="#" aria-describedby="auth-heading">
        {isRegister && <p><label>Name<br /><input type="text" name="name" autoComplete="name" maxLength={100} /></label></p>}
        <p><label>Email<br /><input type="email" name="email" autoComplete="email" required /></label></p>
        <p><label>Password<br /><input type="password" name="password" autoComplete={isRegister ? "new-password" : "current-password"} minLength={isRegister ? 10 : undefined} required /></label></p>
        <button type="submit" disabled>{isRegister ? "Create account (not available yet)" : "Sign in (not available yet)"}</button>
      </form>
      <p>{isRegister ? <>Already have an account? <a href="/login">Sign in</a></> : <>New here? <a href="/register">Create an account</a></>}</p>
      {demoMode && <p role="note">Demo mode is on: you are already using a sample user. <a href="/dashboard">Open the dashboard</a></p>}
    </section>
  );
}
