/**
 * Tool Abort Signal (AbortSignal) Propagation
 *
 * Design notes:
 * 1. Each run() creates a runAbortController as the abort source for that run
 * 2. Each tool execution may receive two layers of signal:
 *    - run-level signal (runAbortController.signal) — the entire run is cancelled
 *    - tool-level signal (from SDK or external) — a single tool is cancelled
 * 3. combineAbortSignals merges both layers: either one triggers abort
 * 4. abortable() wraps LLM call Promises, making them interruptible by abort
 */

import type { Tool, ToolContext } from "./types.js";

/**
 * Combine two AbortSignals; either one triggers abort
 *
 * - Prefers AbortSignal.any() (Node 20+)
 * - Falls back to manual listener when unavailable
 */
export function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;

  // Node 20+ native support
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([a as AbortSignal, b as AbortSignal]);
  }

  // Fallback: manual merge
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * Wrap a tool, injecting run-level abort signal
 *
 * - Merges the tool's own signal with the run-level signal
 * - Throws immediately if already aborted
 */
export function wrapToolWithAbortSignal<T>(tool: Tool<T>, runSignal: AbortSignal): Tool<T> {
  const original = tool.execute;
  return {
    ...tool,
    async execute(input: T, ctx: ToolContext): Promise<string> {
      const combined = combineAbortSignals(ctx.abortSignal, runSignal);
      if (combined?.aborted) {
        throw new Error("Operation aborted");
      }
      return original(input, { ...ctx, abortSignal: combined });
    },
  };
}

/**
 * Wrap a Promise to make it interruptible by abort
 *
 * - Used to wrap LLM streaming calls
 * - When signal fires, rejects the promise, interrupting the wait
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new Error("Operation aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
