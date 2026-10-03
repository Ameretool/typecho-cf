import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { eq, and, sql } from 'drizzle-orm';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';

/** Escape LIKE metacharacters so user input is treated literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

export const GET: APIRoute = async ({ request }) => {
  // Read-only autocomplete — CSRF is not required (same as meta GET list).
  const auth = await requireAdminAction(request, 'contributor', { csrf: false });
  if (isAdminActionResponse(auth)) return auth;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 1) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }

  const pattern = `%${escapeLikePattern(q)}%`;
  const rows = await auth.db
    .select({ name: schema.metas.name })
    .from(schema.metas)
    .where(and(
      eq(schema.metas.type, 'tag'),
      sql`${schema.metas.name} LIKE ${pattern} ESCAPE '\\'`,
    ))
    .limit(10);

  return new Response(JSON.stringify(rows.map((r) => r.name)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
