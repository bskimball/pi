export type WaitOutcome<T> = T | "timeout" | "interrupted";

/**
 * Wait for a generation snapshot without coupling cancellation of the caller
 * to cancellation of the worker. Worker termination is an explicit task_abort
 * operation; an interrupted parent turn only detaches this waiter.
 */
export function waitForSnapshot<T>(options: {
  signal?: AbortSignal;
  timeoutMs: number;
  register: (resolve: (snapshot: T) => void) => () => void;
}): Promise<WaitOutcome<T>> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let unregister = () => {};

    const finish = (value: WaitOutcome<T>) => {
      if (done) return;
      done = true;
      options.signal?.removeEventListener("abort", onSignalAbort);
      if (timer) clearTimeout(timer);
      unregister();
      resolve(value);
    };

    const onSignalAbort = () => finish("interrupted");
    if (options.signal?.aborted) {
      finish("interrupted");
      return;
    }
    options.signal?.addEventListener("abort", onSignalAbort);

    unregister = options.register((snapshot) => finish(snapshot));
    // Registration may discover an already-settled generation and resolve
    // synchronously. In that case finish() ran before unregister was assigned.
    if (done) {
      unregister();
      return;
    }

    if (options.timeoutMs > 0) {
      timer = setTimeout(() => finish("timeout"), options.timeoutMs);
      timer.unref?.();
    }
  });
}
