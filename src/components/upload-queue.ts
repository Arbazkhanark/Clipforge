export interface RetryableUpload { status: string; uncertain?: boolean; }

export class UploadRunGuard {
  private active = false;
  begin(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }
  end(): void { this.active = false; }
}

/** Selects only failed rows; successful rows are removed from the pending queue by the caller. */
export function retryableUploads<T extends RetryableUpload>(items: readonly T[]): T[] {
  return items.filter((item) => item.status === "failed" && item.uncertain !== true);
}

/** Runs independent upload requests with a fixed concurrency ceiling and never short-circuits on one failure. */
export async function runBoundedUploads<T>(items: readonly T[], concurrency: number, upload: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError("Upload concurrency must be a positive integer.");
  let next = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try { await upload(items[index]!); }
      catch { /* The caller records each file's error; other files must continue. */ }
    }
  }));
}
