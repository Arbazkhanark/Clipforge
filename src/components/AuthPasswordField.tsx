"use client";

import { useState } from "react";

type Props = { id: string; name: string; autoComplete?: string; minLength?: number; required?: boolean; placeholder?: string };

export function AuthPasswordField({ id, ...inputProps }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-password-wrap">
      <input {...inputProps} id={id} type={visible ? "text" : "password"} />
      <button className="auth-password-toggle" type="button" aria-label={visible ? "Hide password" : "Show password"} aria-controls={id} aria-pressed={visible} onClick={() => setVisible((current) => !current)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          {visible ? <><path d="M3 3l18 18" /><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" /><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c5.2 0 8.7 4.4 9.5 6-.3.7-1.2 2-2.6 3.3M6.2 6.2C4.1 7.6 2.8 9.7 2.5 11c.8 1.6 4.3 6 9.5 6 1 0 2-.2 2.9-.5" /></> : <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
        </svg>
        <span>{visible ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
}
