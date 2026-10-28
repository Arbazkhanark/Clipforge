// Usage accounting rules: idempotent (retries never double-count) and honest about shared videos.
//
// USAGE POLICY (decided by the product owner):
//  - A render is "successful" only when it finished AND its output passed validation
//    (right size/duration, readable file). Only successful renders are charged.
//  - A failed or invalid render charges nothing: no processing time, no export, no storage.
//  - Usage resets on the 1st of each calendar month (UTC), independent of the billing renewal date.
//  - Using a shared video does NOT count its source file against the recipient's storage;
//    the recipient pays only for what THEY cause: processing time, exports, and their own rendered outputs.
import type { SourceKind, UserId } from "./types.ts";

export type UsageKind = "storage_bytes" | "processing_seconds" | "exports" | "scheduled_items";

export interface UsageRecordDraft {
  userId: UserId;
  kind: UsageKind;
  /** Positive to add usage; negative when storage is released (e.g. a deleted render). */
  amount: number;
  periodStart: Date;
  /** Same key = same event. The database has a UNIQUE constraint on this column. */
  idempotencyKey: string;
}

/** First instant of the (UTC) month containing `date`. */
/** The calendar month boundaries are UTC. The UI shows the reset moment in the user's own time zone. */
export const USAGE_RESET_TIME_ZONE = "UTC";

/** First instant of the NEXT calendar month: when this month's usage counters reset. */
export function nextUsageResetUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Clear text for the usage screen, e.g. "Usage resets on 1 July 2026, 5:30 am (Asia/Kolkata)". */
export function describeUsageReset(now: Date, userTimeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: userTimeZone, day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(nextUsageResetUtc(now));
  return `Usage resets on ${formatted} (${userTimeZone}). Resets happen monthly and do not depend on your billing renewal date.`;
}

export function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Add a record only if its key has not been seen. Returns what the caller should insert (0 or 1 records). */
export function recordsToInsert(existingKeys: ReadonlySet<string>, drafts: UsageRecordDraft[]): UsageRecordDraft[] {
  const seen = new Set(existingKeys);
  const toInsert: UsageRecordDraft[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.idempotencyKey)) continue;
    seen.add(draft.idempotencyKey);
    toInsert.push(draft);
  }
  return toInsert;
}

/**
 * Storage the user is charged for when a video becomes part of their cycle.
 * Shared references cost zero source storage - there is no second physical object.
 */
export function chargeableSourceStorageBytes(sourceKind: SourceKind, sourceSizeBytes: number): number {
  return sourceKind === "shared_reference" ? 0 : sourceSizeBytes;
}

/** Usage created by one finished render job, charged to the person who ran it. */
export function buildRenderUsage(args: {
  consumerId: UserId; renderJobId: string;
  /** The render job finished without error. */
  succeeded: boolean;
  /** The output file was checked (e.g. by ffprobe) and matches what was requested. */
  outputValidated: boolean;
  processingSeconds: number; outputSizeBytes: number; now: Date;
}): UsageRecordDraft[] {
  const { consumerId, renderJobId, succeeded, outputValidated, processingSeconds, outputSizeBytes, now } = args;
  if (!succeeded || !outputValidated) return []; // policy: failed or unvalidated render charges nothing
  const periodStart = monthStartUtc(now);
  const base = { userId: consumerId, periodStart };
  return [
    { ...base, kind: "processing_seconds", amount: Math.ceil(processingSeconds), idempotencyKey: `render:${renderJobId}:seconds` },
    { ...base, kind: "exports", amount: 1, idempotencyKey: `render:${renderJobId}:export` },
    { ...base, kind: "storage_bytes", amount: outputSizeBytes, idempotencyKey: `render:${renderJobId}:storage` },
  ];
}

export function totalsForPeriod(records: UsageRecordDraft[], userId: UserId, periodStart: Date): Record<UsageKind, number> {
  const totals: Record<UsageKind, number> = { storage_bytes: 0, processing_seconds: 0, exports: 0, scheduled_items: 0 };
  for (const record of records) {
    if (record.userId === userId && record.periodStart.getTime() === periodStart.getTime()) totals[record.kind] += record.amount;
  }
  return totals;
}
