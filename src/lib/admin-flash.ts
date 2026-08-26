import type { SiteOptions } from '@/lib/options';
import { isRequestHttps, timeSafeEqual, validateAuthToken, getAuthCookies } from '@/lib/auth';
import type { Database } from '@/db';
import { safeAdminRedirectUrl } from '@/lib/admin-auth';

export const ADMIN_FLASH_COOKIE = '__typecho_admin_flash';
const FLASH_TTL_SECONDS = 90;
const MAX_MESSAGE_LENGTH = 500;

interface AdminFlashPayload {
  uid: number;
  message: string;
  expiresAt: number;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function encode(value: string): string {
  const bytes = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return btoa(bytes)
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decode(value: string): string | null {
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const bytes = atob(padded);
    const escaped = Array.from(bytes, byte => `%${byte.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
    return decodeURIComponent(escaped);
  } catch {
    return null;
  }
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === ADMIN_FLASH_COOKIE) return rest.join('=') || null;
  }
  return null;
}

function setCookie(value: string, request: Request, maxAge: number): string {
  const secure = isRequestHttps(request) ? '; Secure' : '';
  return `${ADMIN_FLASH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function isAdminHtmlFormRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== 'POST') return false;
  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.startsWith('application/x-www-form-urlencoded') &&
      !contentType.startsWith('multipart/form-data')) return false;
  const accept = request.headers.get('accept')?.toLowerCase() || '';
  return !accept.includes('application/json') && request.headers.get('x-requested-with')?.toLowerCase() !== 'xmlhttprequest';
}

export function adminFallbackForApiPath(path: string): string {
  if (path.includes('/theme-config')) return '/admin/themes';
  if (path.includes('/plugin-config')) return '/admin/plugins';
  if (path.includes('/options')) return '/admin/options-general';
  if (path.includes('/content')) return '/admin/manage-posts';
  if (path.includes('/user')) return '/admin/manage-users';
  if (path.includes('/meta') || path.includes('/tags')) return '/admin/manage-tags';
  if (path.includes('/media') || path.includes('/upload')) return '/admin/manage-medias';
  if (path.includes('/comment')) return '/admin/manage-comments';
  return '/admin';
}

export async function createAdminErrorRedirect(
  request: Request,
  options: SiteOptions,
  uid: number,
  message: string,
  fallback: string,
  status = 303,
): Promise<Response> {
  const payload: AdminFlashPayload = {
    uid,
    message: message.trim().slice(0, MAX_MESSAGE_LENGTH) || '操作失败',
    expiresAt: Math.floor(Date.now() / 1000) + FLASH_TTL_SECONDS,
  };
  const encoded = encode(JSON.stringify(payload));
  const signature = await digest(`${options.secret}|${encoded}`);
  const target = safeAdminRedirectUrl(request.headers.get('referer'), options.siteUrl || '', fallback);
  return new Response(null, {
    status,
    headers: {
      Location: target,
      'Set-Cookie': setCookie(`${encoded}.${signature}`, request, FLASH_TTL_SECONDS),
    },
  });
}

export async function readAdminFlash(
  request: Request,
  options: SiteOptions,
  uid: number,
): Promise<string | null> {
  const value = cookieValue(request);
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = await digest(`${options.secret}|${encoded}`);
  if (!timeSafeEqual(signature, expected)) return null;
  const raw = decode(encoded);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as AdminFlashPayload;
    if (payload.uid !== uid || payload.expiresAt < Math.floor(Date.now() / 1000) || typeof payload.message !== 'string') return null;
    return payload.message.slice(0, MAX_MESSAGE_LENGTH);
  } catch {
    return null;
  }
}

export function clearAdminFlash(request: Request): string {
  return setCookie('', request, 0);
}

export async function getAdminUserForFlash(request: Request, db: Database, options: SiteOptions): Promise<number | null> {
  const { token } = getAuthCookies(request.headers.get('cookie'));
  if (!token || !options.secret) return null;
  const auth = await validateAuthToken(token, options.secret, db);
  return auth?.uid ?? null;
}
