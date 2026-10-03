import type { APIRoute } from 'astro';
import { clearAuthCookieHeaders } from '@/lib/auth';

/**
 * Logout — POST only to actually clear cookies. The CSRF risk of clearing
 * cookies on GET (image-tag forced logout) is real, so the GET handler
 * is preserved as a no-op redirect for backwards compatible link targets
 * but never modifies session state.
 */
export const POST: APIRoute = async ({ request }) => {
  const requestOrigin = new URL(request.url).origin;
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (source) {
    try {
      if (new URL(source).origin !== requestOrigin) {
        return new Response('Forbidden', { status: 403 });
      }
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }
  const cookieHeaders = clearAuthCookieHeaders(request);
  const headers = new Headers();
  headers.set('Location', '/');
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
};

export const GET: APIRoute = async () => {
  // GET logout kept for backward compat — DOES NOT clear cookies to prevent
  // CSRF logout via <img src=...>. Use POST /api/users/logout for actual logout.
  return new Response(null, {
    status: 302,
    headers: { Location: '/' },
  });
};
