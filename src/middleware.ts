import { defineMiddleware } from 'astro:middleware';
import { getDb } from '@/db';
import { schema } from '@/db';
import { loadOptions, ensureSecret } from '@/lib/options';
import { applyFilter, isPluginAdminPath, parseActivatedPlugins, setActivatedPlugins, type HookContext } from '@/lib/plugin';
import { hasAuthCookies } from '@/lib/auth';
import { applySecurityHeaders } from '@/lib/security-headers';
import { setRequestCoreContext } from '@/lib/context';
import { compilePermalinkPattern } from '@/lib/permalink-pattern';
import {
  ensureDatabaseReady,
  TablesMissingError,
} from '@/lib/isolate-boot';
import { eq, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { publishedPostCondition } from '@/lib/content-visibility';

const redirectToInstall = (request: Request) =>
  applySecurityHeaders(new Response(null, { status: 302, headers: { Location: '/install' } }), { request });

const BUILT_IN_ROUTES = [
  /^\/archives\/\d+\/?$/,       // post: /archives/{cid}/
  /^\/[^/]+\.html$/,            // page: /{slug}.html
  /^\/category\/[^/]+\/?$/,     // category: /category/{slug}/
  /^\/tag\//,
  /^\/author\//,
  /^\/search\//,
  /^\/$/,
  /^\/sitemap\.xml$/,           // SEO
  /^\/robots\.txt$/,            // SEO
  /^\/feed\/?$/,                // main feed
  /^\/feed\//,                  // sub feeds (atom, rss, comments)
];

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // Skip middleware for static assets, install page, and install API
  if (
    path.startsWith('/css/') ||
    path.startsWith('/js/') ||
    path.startsWith('/img/') ||
    path.startsWith('/themes/') ||
    path.startsWith('/vendor/') ||
    path.startsWith('/plugin-assets/') ||
    path.startsWith('/usr/uploads/') ||
    path === '/install' ||
    path === '/api/install'
  ) {
    return await applySecurityHeaders(await next(), { request: context.request });
  }

  // ── Pagination URL Rewriting ──────────────────────────────────────────────
  // Typecho uses /page/N/ suffix for pagination (e.g. /page/2/, /category/default/page/2/).
  // We rewrite the request in place via next(payload) rather than
  // context.rewrite(payload): the latter triggers a fresh rendering phase
  // that re-executes this whole middleware (options load, plugin chain,
  // permalink resolution, route:request filter — all doubled on every
  // paginated URL). next(payload) preserves the existing pipeline.
  const paginationMatch = path.match(/^(.*)\/page\/(\d+)\/?$/);
  if (paginationMatch) {
    const basePath = paginationMatch[1] || '';
    const pageNum = parseInt(paginationMatch[2], 10);
    context.locals._page = pageNum;
    // Preserve `?foo=bar` (search/filter/sort params etc.) — dropping the
    // query string would break `/search/keyword/page/2/?sort=date` links.
    const target = (basePath === '' ? '/' : basePath + '/') + url.search;
    return applySecurityHeaders(await next(target), { request: context.request });
  }

  const d1 = env.DB;

  try {
    await ensureDatabaseReady(d1);
  } catch (err) {
    if (err instanceof TablesMissingError) {
      return redirectToInstall(context.request);
    }
    // D1 unreachable or other unexpected error — fail open with 500
    // rather than redirecting to /install (which would try D1 again).
    console.error('[middleware] ensureTablesReady failed:', err);
    return applySecurityHeaders(new Response('Service unavailable', { status: 500 }), { request: context.request });
  }

  const db = getDb(d1);

  let options;
  try {
    options = await loadOptions(db);
    if (!options.installed) {
      return redirectToInstall(context.request);
    }
    // PHP-Typecho migrations import the options table without carrying the
    // `secret` value (it used to live in config.inc.php). Bootstrap one
    // synchronously the first time we see it missing, then reload options
    // so the current request has the freshly-generated value.
    if (!options.secret) {
      await ensureSecret(db);
      options = await loadOptions(db);
    }
  } catch (err) {
    console.error('[middleware] loadOptions failed:', err);
    return applySecurityHeaders(new Response('Service unavailable', { status: 500 }), { request: context.request });
  }

  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  await setActivatedPlugins(pluginCtx, activatedIds);
  setRequestCoreContext(context.locals, { db, options, pluginCtx }, context.request);

  const pluginRoute = await applyFilter(pluginCtx, 'route:request', { handled: false }, {
    request: context.request,
    url,
    path,
    db,
    options,
    env,
  });
  if (pluginRoute?.handled && pluginRoute.response instanceof Response) {
    // G6-4: hard-block plugins from claiming reserved core paths.
    // Even a buggy/malicious plugin that returns handled=true on /admin
    // must not be able to intercept admin auth, install, or core API.
    if (isReservedCorePath(path)) {
      console.warn(`[middleware] plugin tried to claim reserved path ${path}; ignoring`);
    } else {
      return await applySecurityHeaders(pluginRoute.response, { request: context.request }, pluginCtx);
    }
  }

  // ── Edge Cache Layer ──────────────────────────────────────────────────────
  const isGetRequest = context.request.method === 'GET';
  const hasAuth = hasAuthCookies(context.request.headers.get('cookie'));
  const isCacheable =
    options.cacheEnabled &&
    isGetRequest &&
    !hasAuth &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/usr/');

  // Reuse a single Request for both cache.match and cache.put
  const cacheKey = isCacheable
    ? new Request(withCacheVersion(context.request.url, options.cacheVersion), { method: 'GET' })
    : null;

  if (cacheKey) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return await applySecurityHeaders(cached, { request: context.request }, pluginCtx);
    }
  }

  // ── Permalink URL Rewriting ────────────────────────────────────────────────
  // After a rewrite the middleware runs again on the NEW path.
  // To avoid infinite loops, skip rewriting for paths that already
  // match an Astro built-in route (the rewrite targets).
  const postPattern = options.permalinkPattern as string | undefined;
  const pagePattern = options.pagePattern as string | undefined;
  const categoryPattern = options.categoryPattern as string | undefined;

  const isBuiltInRoute = BUILT_IN_ROUTES.some((re) => re.test(path));

  if (
    !isBuiltInRoute &&
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/feed') &&
    !path.startsWith('/usr/')
  ) {
    // ── Post permalink rewriting ──
    if (
      postPattern &&
      postPattern !== '/archives/{cid}/'
    ) {
      const regex = compilePermalinkPattern(postPattern, 'post');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let cid: number | null = null;

          if (match.groups.cid) {
            cid = parseInt(match.groups.cid, 10);
          } else if (match.groups.slug) {
            const row = await db.query.contents.findFirst({
              columns: { cid: true },
              where: and(eq(schema.contents.slug, match.groups.slug), publishedPostCondition()),
            });
            if (row) {
              cid = row.cid;
            }
          }

          if (cid) {
            return context.rewrite(`/archives/${cid}/`);
          }
        }
      }
    }

    // ── Page permalink rewriting ──
    if (
      pagePattern &&
      pagePattern !== '/{slug}.html'
    ) {
      const regex = compilePermalinkPattern(pagePattern, 'page');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.cid) {
            const row = await db.query.contents.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.contents.cid, parseInt(match.groups.cid, 10)),
                eq(schema.contents.type, 'page'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/${slug}.html`);
          }
        }
      }
    }

    // ── Category permalink rewriting ──
    if (
      categoryPattern &&
      categoryPattern !== '/category/{slug}/'
    ) {
      const regex = compilePermalinkPattern(categoryPattern, 'category');
      if (regex) {
        const match = path.match(regex);
        if (match?.groups) {
          let slug: string | null = null;

          if (match.groups.slug) {
            slug = match.groups.slug;
          } else if (match.groups.mid) {
            const row = await db.query.metas.findFirst({
              columns: { slug: true },
              where: and(
                eq(schema.metas.mid, parseInt(match.groups.mid, 10)),
                eq(schema.metas.type, 'category'),
              ),
            });
            if (row?.slug) {
              slug = row.slug;
            }
          }

          if (slug) {
            return context.rewrite(`/category/${slug}/`);
          }
        }
      }
    }
  }

  // Execute the route handler
  let response: Response;
  try {
    response = await next();
  } catch (err) {
    console.error('[middleware] next() threw:', path, err);
    return applySecurityHeaders(new Response('Server error', { status: 500 }), { request: context.request }, pluginCtx);
  }
  if (response.status === 404) {
    // Only warn for admin paths (should never 404); info for everything else
    // (bots hitting non-existent routes is normal traffic noise).
    if (path.startsWith('/admin')) {
      console.warn('[middleware] admin route 404:', { path, method: context.request.method });
    }
  }

  response = await applySecurityHeaders(response, { request: context.request }, pluginCtx);

  // ── Write response to edge cache ──────────────────────────────────────────
  if (cacheKey && response.status === 200) {
    const cacheHeaders = new Headers(response.headers);
    if (!cacheHeaders.has('Cache-Control')) {
      cacheHeaders.set('Cache-Control', 'public, s-maxage=300');
    }
    // G5-1: signal that cookies / encoding affect the cached response
    // even though logged-in requests already bypass the cache. Belt-
    // and-braces protects future readers who add cookie-bound state.
    cacheHeaders.set('Vary', mergeVary(cacheHeaders.get('Vary'), ['Cookie', 'Accept-Encoding']));
    // G5-2: never persist Set-Cookie (the Cache API ignores entries
    // with cookies anyway, but stripping makes the intent explicit and
    // avoids leaking auth tokens through future cache backends).
    cacheHeaders.delete('Set-Cookie');

    const cacheable = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers: cacheHeaders,
    });

    const cacheWrite = caches.default.put(cacheKey, cacheable);
    const executionContext = context.locals.cfContext;
    if (executionContext) {
      // Keep cache persistence off the response path. Call through the
      // ExecutionContext object so Workers receives the correct `this`.
      executionContext.waitUntil(cacheWrite);
    } else {
      // Astro's Node test/dev adapter does not always provide an execution
      // context, so preserve deterministic writes there.
      await cacheWrite;
    }
  }

  return response;
});

/** Merge a comma-separated Vary header with additional fields, deduped. */
function mergeVary(existing: string | null, additions: string[]): string {
  const tokens = new Set<string>();
  if (existing) {
    for (const tok of existing.split(',')) tokens.add(tok.trim());
  }
  for (const tok of additions) tokens.add(tok);
  return Array.from(tokens).filter(Boolean).join(', ');
}

/**
 * Paths that plugins MUST NOT be able to claim via route:request.
 * Hard-coded so a misbehaving plugin can never shadow the install
 * flow, login, or admin endpoints.
 */
function isReservedCorePath(path: string): boolean {
  // Allow plugins to claim specific admin paths (registered via registerPluginAdminPath)
  if (isPluginAdminPath(path)) return false;
  if (path === '/install' || path === '/api/install') return true;
  if (path === '/admin' || path.startsWith('/admin/')) return true;
  if (path === '/api/admin' || path.startsWith('/api/admin/')) return true;
  if (path === '/api/users/login' || path === '/api/users/logout' || path === '/api/users/register') return true;
  return false;
}

function withCacheVersion(requestUrl: string, cacheVersion?: number): string {
  const url = new URL(requestUrl);
  url.searchParams.set('__typecho_cache', String(cacheVersion || 0));
  return url.toString();
}
