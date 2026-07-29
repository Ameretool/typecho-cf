import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { eq, and, like } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';

export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 1) return new Response('[]', { headers: { 'Content-Type': 'application/json' } });

  const db = getDb(env.DB);
  const rows = await db
    .select({ name: schema.metas.name })
    .from(schema.metas)
    .where(and(eq(schema.metas.type, 'tag'), like(schema.metas.name, `%${q}%`)))
    .limit(10);

  return new Response(JSON.stringify(rows.map((r) => r.name)), {
    headers: { 'Content-Type': 'application/json' },
  });
};
