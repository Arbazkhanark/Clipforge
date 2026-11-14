export const TRIAL_REMINDER_COOLDOWN_MS = 10 * 60 * 60 * 1000;

export function isActiveTrial(status: string, trialEndsAtUnix: number | null, nowUnix: number): boolean {
  return status === "authenticated" && trialEndsAtUnix !== null && Number.isSafeInteger(trialEndsAtUnix) && trialEndsAtUnix > nowUnix && Number.isFinite(new Date(trialEndsAtUnix * 1000).getTime());
}

export function canShowTrialReminder(lastShownAt: number | null, nowMs: number): boolean {
  return lastShownAt === null || !Number.isFinite(lastShownAt) || nowMs - lastShownAt >= TRIAL_REMINDER_COOLDOWN_MS;
}

export function formatTrialRemaining(remainingMs: number): string {
  if (remainingMs < 3_600_000) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"} remaining`;
  }
  const totalHours = Math.max(0, Math.ceil(remainingMs / 3_600_000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}${hours ? `, ${hours} hour${hours === 1 ? "" : "s"}` : ""} remaining`;
  return `${hours} hour${hours === 1 ? "" : "s"} remaining`;
}
