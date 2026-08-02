import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = handler;

async function handler({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) {
  const auth = await requireAdminAction(request, 'editor');
  if (isAdminActionResponse(auth)) return auth;

  const action = url.searchParams.get('do') || '';
  if (action !== 'delete') return new Response('Invalid action', { status: 400 });

  // Get selected cids from form body
  let cids: number[] = [];
  if (request.method === 'POST') {
    const formData = await request.formData();
    cids = formData.getAll('cid[]').map(v => parseInt(v.toString(), 10)).filter(Boolean);
  }

  if (cids.length === 0) {
    const referer = safeAdminRedirectUrl(
      request.headers.get('referer'),
      auth.options.siteUrl || '',
      '/admin/manage-medias',
    );
    return new Response(null, { status: 302, headers: { Location: referer } });
  }

  await deleteAttachments({
    db: auth.db,
    bucket: env.BUCKET,
    pluginCtx: auth.pluginCtx,
    actor: { uid: auth.uid, group: auth.user.group, user: auth.user },
    request,
    options: auth.options,
  }, cids);

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-medias',
  );
  return new Response(null, { status: 302, headers: { Location: referer } });
}
