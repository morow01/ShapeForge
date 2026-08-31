import * as Comlink from "comlink";
import type { KernelAPI } from "./worker";
import { RETRYABLE_MESH_ERROR } from "./types";
import type { DisplayedSceneItem, ExportQuality, NodeSpec, SceneBuild } from "./types";

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

// Pre-warm the heavy worker's WASM modules (OCCT ~22MB + manifold ~530KB) as
// soon as this module loads, so the first "Preview merged result" click doesn't
// have to wait for a cold download+compile. Called directly on the raw worker
// (not via withWatchdog/coalesceLatest) so it doesn't block or interfere with
// any subsequent buildResult call the user triggers.
heavyCurrent.raw.warmup().catch(() => {/* ignore: buildResult re-runs init() itself */});


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
/** High-detail STL gets a shorter budget because export has a complete,
 * already-rendered mesh fallback. Scene rebuilding still keeps the generous
 * three-minute ceiling above. */
export const EXPORT_WATCHDOG_MS = 30_000;
/**
 * 3MF's high-detail path does strictly more work than STL's for the same
 * scene: STL fuses everything into one merged body with a single OCCT
 * boolean, while 3MF re-tessellates EVERY top-level object separately to
 * keep each one printable on its own — and any object overlapping a Hole
 * also pays for a full meshShape()+Manifold cut on top of that (see
 * exportMeshes in worker.ts). Sharing STL's 30s budget meant a scene that
 * finished as a full-detail STL well within it still blew straight past it
 * as 3MF, silently landing on the EDIT_QUALITY-vs-Fine fallback (see
 * exportDisplayedMeshes) every time — the fallback swap that should be rare
 * was instead the common case for anything past a handful of curved parts.
 * STL keeps its own tighter budget: its fallback is a surgical per-object
 * refinement (see the STL export handler in App.tsx), a much smaller quality
 * loss than 3MF's, so failing fast there is still the right trade.
 */
export const EXPORT_MESHES_WATCHDOG_MS = 90_000;
/** The verified-mesh fallback must not silently start another multi-minute
 * wait after the high-detail path reaches its deadline. */
export const DISPLAYED_EXPORT_WATCHDOG_MS = 30_000;
const CURVED_EXPORT_WATCHDOG_MS = 15_000;

// A cache lookup is supposed to be nearly instant, but worker messages are
// processed serially. If the scene worker is still finishing a complex
// rebuild, a lookup sent to it waits behind that rebuild and used to consume
// the entire three-minute watchdog before export even reached the dedicated
// heavy worker. Do not kill a useful scene rebuild just because this optional
// fast path is busy; fall back after a short wait and let its promise settle in
// the background. A slightly longer second probe recovers the common race
// where the scene finishes at almost the same moment the heavy export times
// out (the next click used to find that cache immediately).
const CACHE_PROBE_MS = 1_500;
const CACHE_RECOVERY_MS = 2_000;

function probeCached3MF(
  specs: NodeSpec[],
  quality: ExportQuality,
  timeoutMs: number,
): Promise<{ id: string; vertices: number[]; triangles: number[] }[] | null | undefined> {
  const probe = sceneCurrent.raw.exportCachedMeshes(specs, quality);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    probe.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function probeCachedSTL(
  specs: NodeSpec[],
  quality: ExportQuality,
  timeoutMs: number,
): Promise<Blob | null | undefined> {
  const probe = sceneCurrent.raw.exportCachedSTL(specs, quality);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // undefined means "the scene lane was busy", while null is a genuine
      // cache miss returned by the worker.
      resolve(undefined);
    }, timeoutMs);
    probe.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

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
  timeoutMs = WATCHDOG_MS,
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
    }, timeoutMs);

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

/**
 * A node that fails every retry inside ONE call to buildScene (see the
 * RETRY_BUDGET_MS loop in worker.ts) is not necessarily broken — reproduced
 * directly: the exact same node data, byte-for-byte, failed "could not be
 * rebuilt reliably" deterministically for several minutes against one
 * already-long-running scene worker, then built cleanly every single time
 * the instant a freshly spawned worker took the same call. Every existing
 * retry — buildScene's own internal attempts, and the UI's one-shot
 * recovery (see App.tsx's meshRecoveryNonce) — asks the SAME worker again,
 * which this evidence says cannot help; the boolean kernel itself is what
 * degrades over a long session, not the geometry.
 *
 * Gives a build with this specific error class exactly one more attempt
 * against a brand new scene worker before it ever reaches the UI. Bounded
 * to one extra attempt, not a loop: a genuinely invalid input fails the
 * same way on a fresh worker too, and retrying that forever would just
 * hide a real error behind a growing pile of abandoned workers.
 */
function buildSceneWithFreshWorkerRetry(specs: NodeSpec[]): Promise<SceneBuild> {
  const attempt = () =>
    withWatchdog("scene", (raw, onProgress) => raw.buildScene(specs, Comlink.proxy(onProgress)));
  return attempt().then((first) => {
    const retryableCount = (build: SceneBuild) =>
      build.errors.filter((e) => e.message.startsWith(RETRYABLE_MESH_ERROR)).length;
    if (retryableCount(first) === 0) return first;
    sceneCurrent.worker.terminate();
    sceneCurrent = spawnWorker();
    return attempt().then((retried) => (retryableCount(retried) <= retryableCount(first) ? retried : first));
  });
}

export const kernel = {
  buildScene: coalesceLatest(buildSceneWithFreshWorkerRetry),
  buildResult: coalesceLatest((specs: NodeSpec[]) =>
    withWatchdog("heavy", (raw, onProgress) => raw.buildResult(specs, Comlink.proxy(onProgress))),
  ),
  /** Per-object meshes for a 3MF export with cache probing and watchdog. */
  exportMeshes: async (specs: NodeSpec[], quality: ExportQuality) => {
    const cached = await probeCached3MF(specs, quality, CACHE_PROBE_MS);
    if (cached) return cached;
    try {
      return await withWatchdog(
        "heavy",
        (raw, onProgress) => raw.exportMeshes(specs, quality, Comlink.proxy(onProgress)),
        EXPORT_MESHES_WATCHDOG_MS,
      );
    } catch (error) {
      if (!(error instanceof KernelTimeoutError)) throw error;
      const recovered = await probeCached3MF(specs, quality, CACHE_RECOVERY_MS);
      if (recovered) return recovered;
      throw error;
    }
  },
  exportDisplayedMeshes: (items: DisplayedSceneItem[]) =>
    withWatchdog(
      "heavy",
      (raw) => raw.exportDisplayedMeshes(items),
      DISPLAYED_EXPORT_WATCHDOG_MS,
    ),
  // Not coalesced: an explicit user action (the Export STL button), not an
  // edit-triggered rebuild — every click should produce its own file.
  exportSTL: async (specs: NodeSpec[], quality: ExportQuality) => {
    // The scene worker may already hold this exact evaluated solid. Ask it
    // for a tessellation-only export first. Do not wait behind a long scene
    // rebuild: export can proceed independently on the heavy worker.
    const cached = await probeCachedSTL(specs, quality, CACHE_PROBE_MS);
    if (cached) return cached;
    try {
      return await withWatchdog(
        "heavy",
        (raw, onProgress) => raw.exportSTL(specs, quality, Comlink.proxy(onProgress)),
        EXPORT_WATCHDOG_MS,
      );
    } catch (error) {
      if (!(error instanceof KernelTimeoutError)) throw error;
      // The interactive scene often finishes while the isolated export is
      // running. Recover its now-cached STL automatically instead of briefly
      // showing a timeout and requiring the exact same click again.
      const recovered = await probeCachedSTL(specs, quality, CACHE_RECOVERY_MS);
      if (recovered) return recovered;
      throw error;
    }
  },
  exportDisplayedSTL: (items: DisplayedSceneItem[]) =>
    withWatchdog(
      "heavy",
      (raw) => raw.exportDisplayedSTL(items),
      DISPLAYED_EXPORT_WATCHDOG_MS,
    ),
  exportRefinedSTL: (specs: NodeSpec[], quality: ExportQuality) =>
    withWatchdog(
      "heavy",
      (raw) => raw.exportRefinedSTL(specs, quality),
      CURVED_EXPORT_WATCHDOG_MS,
    ),
  // Bounding-box centres for regrouping — see the worker's centresOf. Runs
  // on the scene lane: it is small, and it blocks a user action.
  centresOf: (specs: NodeSpec[]) => withWatchdog("scene", (raw) => raw.centresOf(specs)),

  // Shape Builder decomposition: an explicit tool entry, not an edit-driven
  // rebuild, so it is not coalesced. Runs on the heavy lane — a four-body
  // decomposition is 15 cells' worth of booleans and must never queue in
  // front of the interactive rebuilds.
  buildCells: (specs: NodeSpec[]) => withWatchdog("heavy", (raw) => raw.buildCells(specs)),

  // A live push/pull drag's preview — see previewLocal's own doc comment in
  // worker.ts. Shares the "scene" lane/worker with buildScene (it needs to
  // be just as responsive, and must never queue behind a "heavy" merged-
  // result/export call), coalesced the same way so a fast-moving drag's
  // later samples overwrite earlier, now-stale ones instead of piling up.
  previewLocal: coalesceLatest((spec: NodeSpec) =>
    withWatchdog("scene", (raw) => raw.previewLocal(spec)),
  ),
  // Not coalesced: an explicit, one-off user action (the "Remove broken
  // edit" button), not a rebuild fired on every change.
  pruneDeadOps: (spec: NodeSpec) => withWatchdog("scene", (raw) => raw.pruneDeadOps(spec)),
};
