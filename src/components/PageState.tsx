import type { AppError } from "../server/errors.ts";

/** What to show when a page's data could not be loaded. Never reveals whether someone else's object exists. */
export function ErrorState({ error }: { error: AppError }) {
  if (error.status === 401) return <SignInRequired />;
  if (error.status === 404) return <section role="alert"><h1>Not found</h1><p>We could not find that, or you do not have access to it.</p><p><a href="/dashboard">Back to the dashboard</a></p></section>;
  if (error.status === 503) return <section role="alert"><h1>Not connected yet</h1><p>{error.message}</p></section>;
  if (error.status === 422) return <section role="alert"><h1>That request is not valid</h1><ul>{((error.details as { errors?: string[] } | undefined)?.errors ?? [error.message]).map((m) => <li key={m}>{m}</li>)}</ul></section>;
  return <section role="alert"><h1>Something went wrong</h1><p>Please try again.</p></section>;
}

export function SignInRequired() {
  return (
    <section>
      <h1>Sign in required</h1>
      <p>You are not signed in.</p>
      <p><a href="/login">Go to sign in</a></p>
    </section>
  );
}
