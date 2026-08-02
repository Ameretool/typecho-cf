import { defineMiddleware } from 'astro:middleware';
import { schema } from '@/db';
import { applyFilter, isPluginAdminPath } from '@/lib/plugin';
import { hasAuthCookies } from '@/lib/auth';
import { compilePermalinkPattern } from '@/lib/permalink-pattern';
import {
  bootstrapRequestCore,
  finalizeRequestResponse,
  resolveRequestTarget,
} from '@/lib/request-bootstrap';
import { eq, and } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { publishedPostCondition } from '@/lib/content-visibility';

// Plugin loader registration (generated at build time by plugin-loader.ts).
// Statically imported so the lazy plugin loader table exists before the first
// request of a cold isolate runs setActivatedPlugins. Page-ssr scripts only
// execute after a page chunk loads, which may never happen before a plugin
// route like /webdav is requested. Vitest resolves this to a stub that
// mirrors the generated registry.
import 'virtual:typecho-plugin-registry';

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
  const target = resolveRequestTarget(context.request, context.locals);
  const { originalPath, effectivePath: path } = target;
  const url = target.effectiveUrl;

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
    return await finalizeRequestResponse(await next(), { request: context.request });
  }

  const bootstrap = await bootstrapRequestCore(context.request, context.locals);
  if (!bootstrap.ok) {
    return finalizeRequestResponse(bootstrap.response, { request: context.request });
  }
  const { db, options, pluginCtx } = bootstrap.core;

  const pluginRoute = await applyFilter(pluginCtx, 'route:request', { handled: false }, {
    request: context.request,
    url,
    path,
    originalPath,
    effectivePath: path,
    db,
    options,
    env,
  });
  if (pluginRoute?.handled && pluginRoute.response instanceof Response) {
    // G6-4: hard-block plugins from claiming reserved core paths.
    // Even a buggy/malicious plugin that returns handled=true on /admin
    // must not be able to intercept admin auth, install, or core API.
    if (isReservedCorePath(path)) {
      console.warn({ event: 'plugin_reserved_path_rejected', path });
    } else {
      return await finalizeRequestResponse(pluginRoute.response, { request: context.request, pluginCtx });
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
      return await finalizeRequestResponse(cached, { request: context.request, pluginCtx });
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
  let permalinkTarget: string | undefined;

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
            permalinkTarget = `/archives/${cid}/${url.search}`;
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
            permalinkTarget = `/${slug}.html${url.search}`;
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
            permalinkTarget = `/category/${slug}/${url.search}`;
          }
        }
      }
    }
  }

  // Execute the route handler
  let response: Response;
  try {
    const internalTarget = permalinkTarget || target.routeTarget;
    response = internalTarget ? await next(internalTarget) : await next();
  } catch (err) {
    console.error({ event: 'route_handler_failed', path, error: err instanceof Error ? err.message : String(err) });
    return finalizeRequestResponse(new Response('Server error', { status: 500 }), {
      request: context.request,
      pluginCtx,
    });
  }
  if (response.status === 404) {
    // Only warn for admin paths (should never 404); info for everything else
    // (bots hitting non-existent routes is normal traffic noise).
    if (path.startsWith('/admin')) {
      console.warn({ event: 'admin_route_not_found', path, method: context.request.method });
    }
  }

  return finalizeRequestResponse(response, {
    request: context.request,
    pluginCtx,
    cacheKey,
    executionContext: context.locals.cfContext,
  });
});

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
