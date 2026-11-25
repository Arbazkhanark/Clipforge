const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4 * 60_000;

export type WorkerSignals = Pick<NodeJS.Process, "once" | "removeListener">;

export interface ContinuousWorkerOptions<Result> {
  runOnce: () => Promise<Result>;
  idleDelayMs: (result: Result) => number;
  dispose?: () => Promise<void>;
  shutdownTimeoutMs?: number;
  signals?: WorkerSignals;
  forceExit?: (code: number) => never;
  onShutdownTimeout?: () => void;
}

type Outcome<Result> = { kind: "result"; result: Result } | { kind: "error"; error: unknown };

/** Polls serially, stops claiming after SIGINT/SIGTERM, and only disposes resources after work has drained. */
export async function runContinuousWorker<Result>(options: ContinuousWorkerOptions<Result>): Promise<void> {
  const signals = options.signals ?? process;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopping = false;
  const stopWaiters = new Set<() => void>();
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    for (const wake of stopWaiters) wake();
    stopWaiters.clear();
  };
  const waitForStop = (): { promise: Promise<void>; cancel: () => void } => {
    if (stopping) return { promise: Promise.resolve(), cancel: () => undefined };
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = () => resolve();
      stopWaiters.add(wake);
    });
    return { promise, cancel: () => { stopWaiters.delete(wake); } };
  };
  const waitOrStop = (ms: number): Promise<void> => new Promise((resolve) => {
    if (stopping) { resolve(); return; }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    stopWaiters.add(finish);
  });
  signals.once("SIGINT", requestStop);
  signals.once("SIGTERM", requestStop);
  let safeToDispose = true;

  try {
    while (!stopping) {
      let work: Promise<Outcome<Result>>;
      try {
        work = options.runOnce().then<Outcome<Result>, Outcome<Result>>(
          (result) => ({ kind: "result", result }),
          (error: unknown) => ({ kind: "error", error }),
        );
      } catch (error) {
        work = Promise.resolve({ kind: "error", error });
      }
      const stopWait = waitForStop();
      const first = await Promise.race([
        work.then((outcome) => ({ kind: "work" as const, outcome })),
        stopWait.promise.then(() => ({ kind: "stop" as const })),
      ]);
      stopWait.cancel();

      let outcome: Outcome<Result>;
      if (first.kind === "stop") {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([
          work.then((value) => ({ kind: "drained" as const, outcome: value })),
          new Promise<{ kind: "timeout" }>((resolve) => { timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), shutdownTimeoutMs); }),
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (drained.kind === "timeout") {
          safeToDispose = false;
          options.onShutdownTimeout?.();
          forceExit(1);
          return;
        }
        outcome = drained.outcome;
      } else {
        outcome = first.outcome;
      }

      if (outcome.kind === "error") throw outcome.error;
      if (stopping) break;
      const delay = options.idleDelayMs(outcome.result);
      if (delay > 0) await waitOrStop(delay);
    }
  } finally {
    signals.removeListener("SIGINT", requestStop);
    signals.removeListener("SIGTERM", requestStop);
    if (safeToDispose) await options.dispose?.();
  }
}
