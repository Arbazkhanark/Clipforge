"use client";

import { useEffect, useState } from "react";
import { canShowTrialReminder, formatTrialRemaining } from "../lib/ui/trial-reminder.ts";

const LAST_SHOWN_KEY = "clipforge:trial-reminder:last-shown";
const SESSION_SHOWN_KEY = "clipforge:trial-reminder:shown-this-session";

export function TrialReminder({ trialEndsAt }: { trialEndsAt: number | null }) {
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (trialEndsAt === null || trialEndsAt * 1000 <= Date.now() || !Number.isFinite(new Date(trialEndsAt * 1000).getTime())) return;
    try {
      if (window.sessionStorage.getItem(SESSION_SHOWN_KEY) === "yes") return;
      const stored = window.localStorage.getItem(LAST_SHOWN_KEY);
      const lastShownAt = stored === null ? null : Number(stored);
      if (!canShowTrialReminder(lastShownAt, Date.now())) return;
      const shownAt = Date.now();
      window.localStorage.setItem(LAST_SHOWN_KEY, String(shownAt));
      window.sessionStorage.setItem(SESSION_SHOWN_KEY, "yes");
      setNow(shownAt);
      setVisible(true);
    } catch {
      // If browser storage is blocked, show this non-modal reminder for this mount only.
      setVisible(true);
    }
  }, [trialEndsAt]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible || trialEndsAt === null) return null;
  const endMs = trialEndsAt * 1000;
  const remainingMs = endMs - now;
  if (remainingMs <= 0 || !Number.isFinite(new Date(endMs).getTime())) return null;
  const endLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(endMs));

  return (
    <aside className="trial-reminder" role="status" aria-label="Free trial reminder">
      <span className="trial-reminder-mark" aria-hidden="true">✦</span>
      <div className="trial-reminder-copy">
        <strong>Your free trial · {formatTrialRemaining(remainingMs)}</strong>
        <span>Ends {endLabel}</span>
      </div>
      <a href="/pricing">View plan</a>
      <button type="button" aria-label="Dismiss trial reminder" onClick={() => setVisible(false)}>×</button>
    </aside>
  );
}
