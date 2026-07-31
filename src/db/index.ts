import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

const databaseByBinding = new WeakMap<object, ReturnType<typeof drizzle<typeof schema>>>();

export function getDb(d1: D1Database) {
  const binding = d1 as unknown as object;
  const existing = databaseByBinding.get(binding);
  if (existing) return existing;
  // D1 read replicas are only considered when queries run through the
  // Sessions API. Keep one session per binding/isolate so the existing
  // parsed-options snapshot remains reusable across requests while the
  // session preserves monotonic reads after any write handled by this isolate.
  const queryable = typeof d1.withSession === 'function'
    ? d1.withSession('first-unconstrained')
    : d1;
  const db = drizzle(queryable as D1Database, { schema });
  databaseByBinding.set(binding, db);
  return db;
}

export type Database = ReturnType<typeof getDb>;

export { schema };
