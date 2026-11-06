import { getRuntime } from "../../../src/server/runtime.ts";

export const metadata = { title: "Dev outbox", robots: { index: false } };
export const dynamic = "force-dynamic";

// DEVELOPMENT ONLY. Lists messages the mock provider kept. Never shown in production, and never when no outbox exists.
export default function DevOutboxPage() {
  const runtime = getRuntime();
  if (!runtime.outbox || process.env["NODE_ENV"] === "production") return <section><h1>Not found</h1></section>;
  return (
    <section>
      <h1>Local outbox</h1>
      <p className="notice" role="note">Development only. These messages were NOT sent: there is no email provider.</p>
      {runtime.outbox.messages.length === 0 ? <p>No messages yet.</p> : (
        <ol>{[...runtime.outbox.messages].reverse().map((m, i) => <li key={i}><p><strong>{m.subject}</strong> to {m.to}</p><pre>{m.text}</pre></li>)}</ol>
      )}
    </section>
  );
}
