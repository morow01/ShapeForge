import * as Comlink from "comlink";
import type { KernelAPI } from "./worker";
import type { NodeSpec } from "./types";

function spawnWorker() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const raw = Comlink.wrap<KernelAPI>(worker);
  return { worker, raw };
}

// Interactive scene edits must never queue behind an expensive merged result
// or STL export. A complex imported/grouped model can occupy manifold for
// minutes, so the two workloads use independent workers.
let sceneCurrent = spawnWorker();
let heavyCurrent = spawnWorker();

/**
 * A call took long enough that the worker was terminated and replaced rather
 * than waited on further. nodeId, when known, is the node that was actually
 * being processed at the time — see withWatchdog for why that is only ever
 * known on a best-effort basis.
 */
export class KernelTimeoutError extends Error {
  nodeId: string | null;
  constructor(nodeId: string | null) {
    super(
      nodeId
        ? "This object is very complex and was skipped after taking too long, so the rest of the scene " +
            "could keep working. A large scanned/downloaded STL can genuinely take minutes to merge or " +
            "export — if it keeps timing out, try simplifying it (fewer triangles) in a mesh tool first."
        : "The 3D kernel took too long to respond and had to be restarted.",
    );
    this.name = "KernelTimeoutError";
    this.nodeId = nodeId;
  }
}

/**
 * Generous, but not unbounded, ceiling on a single kernel call. OCCT and
 * manifold-3d calls are synchronous WASM execution — nothing else on that
 * worker's one thread can run while a call is in flight, so a genuinely
 * pathological input (a real-world scan STL that is not a clean manifold,
 * say) can occupy it indefinitely with no way to cancel just that call. The
 * only way out is terminating the whole worker. 45s is long enough that a
 * large-but-healthy import is very unlikely to trip it, while still bounding
 * how long the UI can sit on "building" with no explanation.
 */
/**
 * Measured against a real 42MB / ~887k-triangle scanned STL (not a synthetic
 * test file): a standalone import meshes for the edit view in ~20s, but the
 * merged-result/export path — which re-meshes through manifold-3d's own
 * mesh() with no simplification step available to skip — routinely ran past
 * two minutes for the SAME file even with nothing else to combine with, and
 * once (grouped with two small primitives, forcing an actual boolean fuse)
 * never completed inside 10 minutes. There is no timeout that turns a
 * genuinely too-complex file into a fast one; this bounds the wait to
 * something tolerable rather than promising every large file will finish.
 */
export const WATCHDOG_MS = 3 * 60_000;

/**
 * Runs one call against the current worker, racing it against WATCHDOG_MS.
 * onProgress (proxied into the worker) reports which node's own work last
 * started, so a timeout can be attributed to a specific node instead of
 * leaving the caller to guess — see makeLocal's onProgress parameter in
 * shape.ts for where that signal originates.
 *
 * On timeout the current worker is terminated and swapped for a fresh one
 * (which reboots both WASM modules on its next call — the existing meshCache
 * is lost with it, so the following build recomputes every node, but that is
 * a one-time cost and the alternative is staying stuck). Callers get a
 * KernelTimeoutError instead of a promise that never settles.
 */
function withWatchdog<R>(
  lane: "scene" | "heavy",
  run: (raw: KernelAPI, onProgress: (id: string) => void) => Promise<R>,
): Promise<R> {
  const current = lane === "scene" ? sceneCurrent : heavyCurrent;
  const { worker, raw } = current;
  let lastProgressId: string | null = null;
  let settled = false;

  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (lane === "scene") sceneCurrent = spawnWorker();
      else heavyCurrent = spawnWorker();
      reject(new KernelTimeoutError(lastProgressId));
    }, WATCHDOG_MS);

    run(raw, (id) => {
      lastProgressId = id;
    }).then(
      (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

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
  buildScene: coalesceLatest((specs: NodeSpec[]) =>
    withWatchdog("scene", (raw, onProgress) => raw.buildScene(specs, Comlink.proxy(onProgress))),
  ),
  buildResult: coalesceLatest((specs: NodeSpec[]) =>
    withWatchdog("heavy", (raw, onProgress) => raw.buildResult(specs, Comlink.proxy(onProgress))),
  ),
  // Not coalesced: an explicit user action (the Export STL button), not an
  // edit-triggered rebuild — every click should produce its own file.
  exportSTL: (specs: NodeSpec[]) =>
    withWatchdog("heavy", (raw, onProgress) => raw.exportSTL(specs, Comlink.proxy(onProgress))),
  // A live push/pull drag's preview — see previewLocal's own doc comment in
  // worker.ts. Shares the "scene" lane/worker with buildScene (it needs to
  // be just as responsive, and must never queue behind a "heavy" merged-
  // result/export call), coalesced the same way so a fast-moving drag's
  // later samples overwrite earlier, now-stale ones instead of piling up.
  previewLocal: coalesceLatest((spec: NodeSpec) =>
    withWatchdog("scene", (raw) => raw.previewLocal(spec)),
  ),
};
