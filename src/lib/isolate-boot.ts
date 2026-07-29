/**
 * Per-isolate boot state for Cloudflare Workers.
 *
 * Workers reuse the same isolate across many requests. Certain one-time
 * checks (table existence, index creation) only need to run once per
 * isolate lifetime. This module aggregates those checks so middleware
 * doesn't carry module-level mutable booleans.
 *
 * All state is intentionally per-isolate (module-scope). Workers are
 * single-threaded, so concurrent access is not a concern.
 */

import { generateIndexSQL } from '@/lib/schema-sql';

/** Thrown when D1 has no typecho_options table — legitimate install-redirect case. */
export class TablesMissingError extends Error {
  constructor() {
    super('tables-missing');
    this.name = 'TablesMissingError';
  }
}

interface IsolateBoot {
  tableCheckPassed: boolean;
  indexEnsurePassed: boolean;
}

const state: IsolateBoot = {
  tableCheckPassed: false,
  indexEnsurePassed: false,
};

/**
 * Resets all boot state. Exposed for tests so individual test cases
 * can simulate a cold isolate without forking a new worker process.
 */
export function resetIsolateBoot(): void {
  state.tableCheckPassed = false;
  state.indexEnsurePassed = false;
}

/**
 * Ensures the D1 database has the typecho_options table.
 *
 * On the first request after a cold start, queries sqlite_master.
 * If the table exists, sets tableCheckPassed=true so subsequent
 * requests skip this check.
 *
 * Throws 'tables-missing' if the table does not exist, letting the
 * caller redirect to /install.
 */
export async function ensureTablesReady(d1: D1Database): Promise<void> {
  if (state.tableCheckPassed) return;
  const row = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='typecho_options'")
    .first<{ name: string }>();
  if (!row) throw new TablesMissingError();
  state.tableCheckPassed = true;
}

/**
 * Backfills any newly-added indexes exactly once per isolate.
 *
 * Off the request path via waitUntil if available; otherwise
 * fire-and-forget. CREATE INDEX IF NOT EXISTS is idempotent.
 */
export function ensureIndexes(
  d1: D1Database,
  waitUntil?: (p: Promise<unknown>) => void,
): void {
  if (state.indexEnsurePassed) return;
  state.indexEnsurePassed = true;
  const indexStatements = generateIndexSQL();
  if (indexStatements.length === 0) return;
  // Explicit loop — .prepare() loses its `this` binding when passed as a
  // .map() callback inside Cloudflare Workers' native API proxies.
  const stmts: D1PreparedStatement[] = [];
  for (const sql of indexStatements) {
    stmts.push(d1.prepare(sql));
  }
  const backfill = d1.batch(stmts).catch(
    err => console.warn('[isolate-boot] ensureIndexes failed:', err),
  );
  if (waitUntil) {
    waitUntil(backfill);
  }
  // If waitUntil isn't available (e.g. tests), the promise runs in the
  // background — harmless since indexes are idempotent.
}
