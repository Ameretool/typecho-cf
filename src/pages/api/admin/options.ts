import type { APIRoute } from 'astro';
import { setOptionsBatch } from '@/lib/options';
import { isAdminActionResponse, requireAdminAction, safeAdminRedirectUrl } from '@/lib/admin-auth';
import { purgeSiteCache } from '@/lib/cache';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';
import { InputError, readBoundedFormData } from '@/lib/input';
import { parseSiteOptionsInput, SiteOptionsInputError } from '@/lib/options-input';
import { textError } from '@/lib/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'administrator');
  if (isAdminActionResponse(auth)) return auth;

  const referer = safeAdminRedirectUrl(
    request.headers.get('referer'),
    auth.options.siteUrl || '',
    '/admin/options-general',
  );

  const refererPath = referer.split('?')[0];
  let entries: Record<string, string>;
  try {
    const formData = await readBoundedFormData(request, REQUEST_BODY_LIMITS.adminForm);
    entries = parseSiteOptionsInput({ formData, sourcePath: refererPath });
  } catch (error) {
    if (error instanceof InputError) return textError(error.status, error.message);
    if (error instanceof SiteOptionsInputError) return textError(400, error.message);
    throw error;
  }

  await setOptionsBatch(auth.db, entries);
  await purgeSiteCache(auth.options.siteUrl || '');

  return new Response(null, {
    status: 302,
    headers: { Location: referer },
  });
};
