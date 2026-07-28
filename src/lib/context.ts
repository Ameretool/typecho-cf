/**
 * Request context - initializes DB, options, and user for each request
 * Equivalent to Typecho's Widget\Init bootstrap
 */

import { getDb, type Database } from '@/db';
import { loadOptions, type SiteOptions, computeUrls } from '@/lib/options';
import { getAuthCookies, validateAuthToken, hasPermission, generateSecurityToken } from '@/lib/auth';
import { setActivatedPlugins, parseActivatedPlugins, doHook, type HookContext } from '@/lib/plugin';
import { schema } from '@/db';
import { env } from 'cloudflare:workers';

/**
 * Extract the real client IP address from a request.
 *
 * Priority:
 *  1. CF-Connecting-IP  — set by Cloudflare to the true client IP (single value, always reliable)
 *  2. X-Forwarded-For   — may be a comma-separated list such as "clientIP, proxy1, proxy2";
 *                         only the *first* entry is the original client IP.
 *
 * The returned value is trimmed. Returns an empty string if no header is present.
 */
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();

  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    // X-Forwarded-For: clientIP, proxy1, proxy2 — only the first entry is the real client.
    // Filter out empty segments so a leading comma (", 1.2.3.4") doesn't yield the empty string.
    for (const raw of xff.split(',')) {
      const ip = raw.trim();
      if (ip) return ip;
    }
  }

  return '';
}

/** Drizzle-inferred user row type */
export type UserRow = typeof schema.users.$inferSelect;

export interface RequestContext extends HookContext {
  db: Database;
  options: SiteOptions;
  urls: ReturnType<typeof computeUrls>;
  user: UserRow | null;
  isLoggedIn: boolean;
  csrfToken: string | null;
}

/**
 * Create request context from Astro locals
 */
export async function createContext(locals: App.Locals, request: Request): Promise<RequestContext> {
  const db = getDb(env.DB);

  // Load site options
  const options = await loadOptions(db);
  const urls = computeUrls(options);

  // Load activated plugins from DB options. Nothing is auto-activated: an
  // operator must explicitly turn plugins on from /admin/plugin. This means a
  // hostile package that happens to land in node_modules with typecho/plugin
  // keywords cannot register hooks without a deliberate admin action.
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);

  const activatedPlugins = new Set<string>();
  const ctx: RequestContext = { db, options, urls, user: null, isLoggedIn: false, csrfToken: null, activatedPlugins };

  setActivatedPlugins(ctx, activatedIds);

  // Check auth
  const cookieHeader = request.headers.get('cookie');
  const { token } = getAuthCookies(cookieHeader);

  if (token && options.secret) {
    const result = await validateAuthToken(token, options.secret, db);
    if (result) {
      ctx.user = result.user;
      ctx.isLoggedIn = true;
    }
  }

  ctx.csrfToken = (ctx.user && options.secret)
    ? await generateSecurityToken(options.secret as string, ctx.user.authCode!, ctx.user.uid)
    : null;

  // Trigger system:begin hook
  await doHook(ctx, 'system:begin', ctx);

  return ctx;
}

/**
 * Require authentication - redirects to login if not authenticated
 */
export function requireAuth(ctx: RequestContext, redirectUrl?: string): Response | null {
  if (!ctx.isLoggedIn) {
    const target = redirectUrl || '/admin/login';
    return new Response(null, {
      status: 302,
      headers: { Location: target },
    });
  }
  return null;
}

/**
 * Require a specific permission level
 */
export function requirePermission(ctx: RequestContext, group: string, strict = false): Response | null {
  if (!ctx.isLoggedIn || !ctx.user) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/admin/login' },
    });
  }

  if (!hasPermission(ctx.user.group || 'visitor', group, strict)) {
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}
