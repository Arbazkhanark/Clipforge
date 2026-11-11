"use client";

import { useState } from "react";

export function AuthSubmitButton({ available, label, pendingLabel }: { available: boolean; label: string; pendingLabel: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="submit"
      disabled={!available || pending}
      className="auth-submit"
      onClick={(event: { currentTarget: HTMLButtonElement }) => {
        const form = event.currentTarget.form;
        if (!form?.checkValidity()) {
          form?.reportValidity();
          return;
        }
        setPending(true);
      }}
    >
      {available ? pending ? pendingLabel : label : `${label} (not available yet)`}
      {!pending && <span aria-hidden="true">→</span>}
      {pending && <span className="auth-submit-spinner" aria-hidden="true" />}
    </button>
  );
}
