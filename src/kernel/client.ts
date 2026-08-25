import * as Comlink from "comlink";
import type { KernelAPI } from "./worker";
import type { NodeSpec } from "./types";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const raw = Comlink.wrap<KernelAPI>(worker);

/**
 * Wraps an async function so a call made while a previous call from the same
 * wrapper is still running does not queue behind it — it overwrites whatever
 * was pending, and exactly one more call (with the LATEST arguments) runs the
 * moment the current one finishes.
 *
 * This bounds the worker's outstanding message queue at "one running plus one
 * pending", no matter how fast the caller fires. A debounce alone only
 * reduces how OFTEN calls are sent — it does not cap how many can still pile
 * up if a call takes longer than the debounce window. That gap is exactly
 * what let a delete or rename get stuck for up to a minute behind a long
 * backlog of stale rebuilds queued by an earlier slider drag: the worker
 * processes its message queue strictly one at a time, so every superseded
 * rebuild had to finish before the delete's request was even looked at.
 *
 * A call that gets silently superseded here never settles its own promise —
 * by design (nothing is waiting on an outdated result) — which is safe: once
 * the caller's fire-and-forget .then/.catch chain is the only reference to
 * it, it is ordinary garbage, not a leak.
 */
function coalesceLatest<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  let inFlight = false;
  let pending: { args: Args; resolve: (v: R) => void; reject: (e: unknown) => void } | null = null;

  const run = (args: Args): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      if (inFlight) {
        pending = { args, resolve, reject };
        return;
      }
      inFlight = true;
      fn(...args)
        .then(resolve, reject)
        .finally(() => {
          inFlight = false;
          if (pending) {
            const next = pending;
            pending = null;
            run(next.args).then(next.resolve, next.reject);
          }
        });
    });

  return (...args: Args) => run(args);
}

export const kernel = {
  buildScene: coalesceLatest((specs: NodeSpec[]) => raw.buildScene(specs)),
  buildResult: coalesceLatest((specs: NodeSpec[]) => raw.buildResult(specs)),
  // Not coalesced: an explicit user action (the Export STL button), not an
  // edit-triggered rebuild — every click should produce its own file.
  exportSTL: (specs: NodeSpec[]) => raw.exportSTL(specs),
};
