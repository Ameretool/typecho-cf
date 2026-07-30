import type { Database } from '@/db';

const generations = new WeakMap<object, number>();

export function getOptionsSnapshotGeneration(db: Database): number {
  return generations.get(db as object) ?? 0;
}

/**
 * Invalidate parsed options snapshots without importing the options Module
 * from cache.ts (which would introduce a runtime import cycle).
 */
export function advanceOptionsSnapshotGeneration(db: Database): number {
  const next = getOptionsSnapshotGeneration(db) + 1;
  generations.set(db as object, next);
  return next;
}
