"use client";

import { useState } from "react";
import type { Flash } from "../server/flash.ts";

/** Dismissible, accessible feedback for server-confirmed auth action results. */
export function AuthToast({ flash }: { flash: Flash }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  const isError = flash.kind === "error";
  return (
    <div role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} className={`notice auth-toast auth-toast--${flash.kind}`} data-flash={flash.kind}>
      <span className="auth-toast-message">{flash.message}</span>
      <button className="auth-toast-dismiss" type="button" aria-label="Dismiss message" onClick={() => setVisible(false)}>×</button>
    </div>
  );
}
