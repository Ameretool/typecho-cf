/**
 * Isolate-level generation counter for parsed Site Options snapshots.
 *
 * Kept in a tiny Module so cache.ts can invalidate options snapshots without
 * importing options.ts (which would introduce a runtime import cycle).
 *
 * Intentionally NOT keyed by the per-request Drizzle handle — `getDb()` creates
 * a fresh Sessions wrapper each request, so a WeakMap<Database, …> never hits
 * across requests inside the same isolate.
 */

let generation = 0;

export function getOptionsSnapshotGeneration(): number {
  return generation;
}

export function advanceOptionsSnapshotGeneration(): number {
  generation += 1;
  return generation;
}

/** Test-only: reset the isolate generation counter. */
export function resetOptionsSnapshotGeneration(): void {
  generation = 0;
}
