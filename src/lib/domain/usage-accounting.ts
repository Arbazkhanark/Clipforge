// Usage accounting rules: idempotent (retries never double-count) and honest about shared videos.
//
// POLICY ASSUMPTIONS (not yet confirmed by the product owner - see docs/PLAN.md):
//  - A failed render charges nothing (no processing minutes, no export, no storage).
//  - Usage periods are calendar months in UTC (not the subscription billing cycle).
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
  consumerId: UserId; renderJobId: string; succeeded: boolean;
  processingSeconds: number; outputSizeBytes: number; now: Date;
}): UsageRecordDraft[] {
  const { consumerId, renderJobId, succeeded, processingSeconds, outputSizeBytes, now } = args;
  if (!succeeded) return []; // policy assumption: no output, no charge
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
