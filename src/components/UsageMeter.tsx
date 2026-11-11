// src/components/UsageMeter.tsx
import { formatCount } from "./format.ts";

export interface UsageMeterProps {
  label: string;
  used: number;
  limit: number;
  /** Turns a raw number into text, e.g. formatStorage for bytes. */
  formatValue?: (n: number) => string;
  /** From describeUsageReset(): tells the user exactly when this counter resets. */
  resetNotice?: string;
}

export function UsageMeter({ label, used, limit, formatValue = formatCount, resetNotice }: UsageMeterProps) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const state = used > limit ? "over" : percent >= 80 ? "warning" : "ok";
  return (
    <div className="usage-meter" data-state={state}>
      <div className="usage-meter-header">
        <span>{label}</span>
        <span>{formatValue(used)} of {formatValue(limit)} used</span>
      </div>
      <progress max={100} value={percent} aria-label={`${label}: ${percent}% used`} />
      {state === "warning" && <p role="status">You have used {percent}% of this allowance.</p>}
      {state === "over" && <p role="alert">You are over your plan limit. New work in this category is blocked until the reset or an upgrade.</p>}
      {resetNotice && <p className="muted">{resetNotice}</p>}
    </div>
  );
}
