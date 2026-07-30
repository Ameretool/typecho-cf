import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

const databaseByBinding = new WeakMap<object, ReturnType<typeof drizzle<typeof schema>>>();

export function getDb(d1: D1Database) {
  const binding = d1 as unknown as object;
  const existing = databaseByBinding.get(binding);
  if (existing) return existing;
  const db = drizzle(d1, { schema });
  databaseByBinding.set(binding, db);
  return db;
}

export type Database = ReturnType<typeof getDb>;

export { schema };
