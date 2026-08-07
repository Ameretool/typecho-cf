import type { APIRoute } from 'astro';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import {
  applyCommentAction,
  getModeratableComment,
  normalizeCommentAction,
  purgeCommentModerationCache,
} from '@/lib/comment-moderation';
import { readAdminFormOrError } from '@/lib/input';

export const GET: APIRoute = async () =>
  new Response('Method Not Allowed', { status: 405 });

export const POST: APIRoute = async ({ request, locals, url }) => {
  const auth = await requireAdminAction(request, 'contributor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await readAdminFormOrError(request);
  if (formData instanceof Response) return formData;
  const action = normalizeCommentAction(
    formData.get('action')?.toString() || url.searchParams.get('action') || '',
  );
  const coid = parseInt(
    formData.get('coid')?.toString() || url.searchParams.get('coid') || '0',
    10,
  );
  if (!action || !coid) return new Response('Bad Request', { status: 400 });

  const comment = await getModeratableComment(auth.db, coid, auth.user);
  if (comment instanceof Response) return comment;

  await applyCommentAction(auth.pluginCtx, auth.db, comment, action, auth.options);
  await purgeCommentModerationCache(auth.db, auth.options, comment.cid);

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/manage-comments',
  );
  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
