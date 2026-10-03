import type { APIRoute } from 'astro';
import { schema } from '@/db';
import { hasPermission } from '@/lib/auth';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { resolveUniqueContentSlug } from '@/lib/slug';
import { readAdminFormOrError } from '@/lib/input';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await readAdminFormOrError(request);
  if (formData instanceof Response) return formData;
  const action = formData.get('do')?.toString() || 'update';
  const cid = parseInt(formData.get('cid')?.toString() || '0', 10);

  if (!cid) return new Response('Bad Request', { status: 400 });

  if (action === 'delete') {
    const result = await deleteAttachments({
      db: auth.db,
      bucket: env.BUCKET,
      pluginCtx: auth.pluginCtx,
      actor: { uid: auth.uid, group: auth.user.group, user: auth.user },
      request,
      options: auth.options,
    }, [cid]);
    if (result.missing.includes(cid)) return new Response('Not Found', { status: 404 });
    if (result.forbidden.includes(cid)) return new Response('Forbidden', { status: 403 });
    return new Response(null, { status: 302, headers: { Location: '/admin/manage-medias' } });
  }

  const attachment = await auth.db.query.contents.findFirst({
    where: eq(schema.contents.cid, cid),
  });

  if (!attachment || attachment.type !== 'attachment') {
    return new Response('Not Found', { status: 404 });
  }

  const isAdmin = hasPermission(auth.user.group || 'visitor', 'administrator');
  if (!isAdmin && attachment.authorId !== auth.uid) {
    return new Response('Forbidden', { status: 403 });
  }

  // Update attachment
  const name = formData.get('name')?.toString()?.trim() || attachment.title;
  const slug = await resolveUniqueContentSlug(
    auth.db,
    formData.get('slug')?.toString() || attachment.slug,
    cid,
    attachment.title || String(cid),
  );

  if (action !== 'update') return new Response('Invalid action', { status: 400 });

  await auth.db.update(schema.contents).set({
    title: name,
    slug,
    modified: Math.floor(Date.now() / 1000),
  }).where(eq(schema.contents.cid, cid));

  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/media?cid=${cid}` },
  });
};
