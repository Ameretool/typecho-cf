import { and, eq, ne } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { normalizeSlug } from '@/lib/input';

export async function resolveUniqueContentSlug(
  db: Database,
  desired: unknown,
  cid: number,
  fallback?: string,
): Promise<string> {
  const base = normalizeSlug(desired, fallback || String(cid)) || String(cid);
  let candidate = base;
  let suffix = 0;
  while (true) {
    const existing = await db.query.contents.findFirst({
      columns: { cid: true },
      where: and(eq(schema.contents.slug, candidate), ne(schema.contents.cid, cid)),
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = cid > 0
      ? (suffix === 1 ? `${base}-${cid}` : `${base}-${cid}-${suffix}`)
      : `${base}-${suffix + 1}`;
  }
}

export async function resolveUniqueMetaSlug(
  db: Database,
  desired: unknown,
  type: 'category' | 'tag',
  mid = 0,
  fallback = '',
): Promise<string> {
  const base = normalizeSlug(desired, fallback) || (mid ? String(mid) : type);
  let candidate = base;
  let suffix = 1;
  while (true) {
    const conditions = [eq(schema.metas.slug, candidate), eq(schema.metas.type, type)];
    if (mid) conditions.push(ne(schema.metas.mid, mid));
    const existing = await db.query.metas.findFirst({
      columns: { mid: true },
      where: and(...conditions),
    });
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}
