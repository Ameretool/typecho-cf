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
  passwordResetSchemaPassed: boolean;
  indexEnsurePassed: boolean;
}

const state: IsolateBoot = {
  tableCheckPassed: false,
  passwordResetSchemaPassed: false,
  indexEnsurePassed: false,
};

/**
 * Resets all boot state. Exposed for tests so individual test cases
 * can simulate a cold isolate without forking a new worker process.
 */
export function resetIsolateBoot(): void {
  state.tableCheckPassed = false;
  state.passwordResetSchemaPassed = false;
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

const PASSWORD_RESET_COLUMNS = [
  ['uid', 'INTEGER'],
  ['tokenHash', 'TEXT'],
  ['expiresAt', 'INTEGER'],
] as const;

/**
 * Ensures the password-reset request table exists and is current.
 *
 * The earlier implementation called this table
 * `typecho_password_reset_throttle`. Rename that table in place so existing
 * rate-limit and pending-token state survives the terminology correction.
 */
export async function ensurePasswordResetSchema(d1: D1Database): Promise<void> {
  if (state.passwordResetSchemaPassed) return;

  const tables = await d1.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' " +
    "AND name IN ('typecho_password_reset_requests', 'typecho_password_reset_throttle')",
  ).all<{ name: string }>();
  const tableNames = new Set((tables.results ?? []).map(table => table.name));
  const hasCurrent = tableNames.has('typecho_password_reset_requests');
  const hasLegacy = tableNames.has('typecho_password_reset_throttle');

  if (hasLegacy && !hasCurrent) {
    await d1.batch([
      d1.prepare(
        'ALTER TABLE typecho_password_reset_throttle ' +
        'RENAME TO typecho_password_reset_requests',
      ),
      d1.prepare('DROP INDEX IF EXISTS typecho_password_reset_tokenHash'),
    ]);
  } else if (!hasCurrent) {
    await d1.batch([
      d1.prepare(
        'CREATE TABLE typecho_password_reset_requests (' +
        'email TEXT PRIMARY KEY NOT NULL, ' +
        'lastSentAt INTEGER NOT NULL DEFAULT 0, ' +
        'uid INTEGER, tokenHash TEXT, expiresAt INTEGER)',
      ),
    ]);
  }

  const result = await d1
    .prepare("PRAGMA table_info('typecho_password_reset_requests')")
    .all<{ name: string }>();
  const existing = new Set((result.results ?? []).map(column => column.name));
  const upgrades: D1PreparedStatement[] = [];
  for (const [name, type] of PASSWORD_RESET_COLUMNS) {
    if (!existing.has(name)) {
      upgrades.push(
        d1.prepare(`ALTER TABLE typecho_password_reset_requests ADD COLUMN ${name} ${type}`),
      );
    }
  }
  if (upgrades.length > 0) await d1.batch(upgrades);
  state.passwordResetSchemaPassed = true;
}

/**
 * Backfills any newly-added indexes exactly once per isolate.
 *
 * Off the request path via waitUntil if available; otherwise
 * fire-and-forget. CREATE INDEX IF NOT EXISTS is idempotent.
 */
export function ensureIndexes(
  d1: D1Database,
  executionContext?: Pick<ExecutionContext, 'waitUntil'>,
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
  if (executionContext) {
    executionContext.waitUntil(backfill);
  }
  // If waitUntil isn't available (e.g. tests), the promise runs in the
  // background — harmless since indexes are idempotent.
}
