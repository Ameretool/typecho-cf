/**
 * Edge cache utilities using Cloudflare Workers Cache API (caches.default).
 *
 * - No extra bindings or dependencies needed.
 * - Per-PoP cache: cache.delete() only clears the current edge node.
 * - Logged-in users bypass cache entirely (ensured in middleware).
 *
 * Cross-PoP consistency for the options cache: the cache key embeds a
 * version stamp read from D1. bumpCacheVersion() advances the stamp so
 * every PoP naturally misses on its next read, no purge required.
 */

import { eq, and, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { OPTIONS_CACHE_TTL_SECONDS } from '@/lib/constants';
import { advanceOptionsSnapshotGeneration } from '@/lib/options-snapshot-generation';

/** Internal namespace used for Cache API keys that are not real URLs */
const INTERNAL_ORIGIN = 'https://typecho-cf-internal';

function optionsCacheKey(version: string | number): Request {
  return new Request(`${INTERNAL_ORIGIN}/__options?v=${encodeURIComponent(String(version))}`);
}

// In-memory cache-version memo (per isolate). Cross-PoP invalidation of
// the options blob is bounded by CACHE_VERSION_MEMO_TTL_MS: a bump made
// on PoP-A takes at most this long to be seen on PoP-B. In exchange we
// avoid a D1 read on every loadOptions() call — worth the small
// staleness for read-heavy endpoints. Content/option writes bump the
// stamp rarely, so a 5-minute bound is a good trade-off; comment writes
// no longer bump it at all (see purgeContentCache).
const CACHE_VERSION_MEMO_TTL_MS = 300_000;
let cachedVersion: string | null = null;
let cachedVersionAt = 0;

async function readCacheVersion(db: Database, now = Date.now()): Promise<string> {
  if (cachedVersion !== null && now - cachedVersionAt < CACHE_VERSION_MEMO_TTL_MS) {
    return cachedVersion;
  }
  const row = await db.query.options.findFirst({
    where: and(eq(schema.options.name, 'cacheVersion'), eq(schema.options.user, 0)),
  });
  cachedVersion = row?.value ?? '0';
  cachedVersionAt = now;
  return cachedVersion;
}

/**
 * Cheap cacheVersion probe used by loadOptions to invalidate the isolate
 * options snapshot after a cross-PoP bump (bounded by the memo TTL).
 */
export async function peekCacheVersion(db: Database): Promise<string> {
  return readCacheVersion(db);
}

/** Test-only: reset the in-memory version memo so unit tests start fresh. */
export function resetCacheVersionMemo(): void {
  cachedVersion = null;
  cachedVersionAt = 0;
}

/**
 * Stamp a request URL with the current cacheVersion. Every public page
 * cache key embeds this stamp so a version bump (content/option writes)
 * makes every PoP miss on its next read — no purge needed. purgeContentCache
 * reuses the same stamp to delete exact keys after comment writes.
 */
export function withCacheVersion(requestUrl: string, cacheVersion?: string | number): string {
  const url = new URL(requestUrl);
  url.searchParams.set('__typecho_cache', String(cacheVersion || 0));
  return url.toString();
}

export async function purgeCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const cache = caches.default;
  await Promise.all(urls.map(async (url) => {
    try {
      // Only try to purge absolute URLs (skip relative paths)
      if (url.startsWith('http://') || url.startsWith('https://')) {
        await cache.delete(new Request(url));
      }
    } catch {
      // Silently ignore errors (e.g., invalid URLs)
    }
  }));
}

/**
 * Purge the cached site options. Kept for legacy call sites; the version-
 * stamped cache key makes explicit purge redundant, but purging the
 * current-PoP entry costs nothing extra.
 */
export async function purgeOptionsCache(): Promise<void> {
  // No longer strictly necessary — the version stamp on the cache key
  // means bumpCacheVersion() makes every PoP miss on the next read. Kept
  // as a defensive no-op so old call sites still compile.
}

export async function bumpCacheVersion(db: Database): Promise<void> {
  const [updated] = await db.insert(schema.options)
    .values({ name: 'cacheVersion', user: 0, value: '1' })
    .onConflictDoUpdate({
      target: [schema.options.user, schema.options.name],
      set: {
        value: sql`cast(coalesce(${schema.options.value}, '0') as integer) + 1`,
      },
    })
    .returning({ value: schema.options.value });
  const stamp = updated?.value ?? '1';
  // Best-effort local memo update so the writer sees its own bump on
  // subsequent reads within the same isolate (other PoPs will refresh
  // after their memo expires — see CACHE_VERSION_MEMO_TTL_MS).
  cachedVersion = stamp;
  cachedVersionAt = Date.now();
  advanceOptionsSnapshotGeneration();
}

/**
 * Try to read cached options JSON, keyed by the current cacheVersion.
 * The version is memoized in-isolate for a short TTL so we don't hit D1
 * on every loadOptions() call. Cross-PoP writes become visible within
 * CACHE_VERSION_MEMO_TTL_MS.
 */
export async function getCachedOptions(db: Database): Promise<Record<string, unknown> | null> {
  const version = await readCacheVersion(db);
  const cache = caches.default;
  const res = await cache.match(optionsCacheKey(version));
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Write options JSON to cache under the current version stamp.
 * Callers must pass the version they read so a subsequent bump in
 * another PoP doesn't leave a stale entry under a fresh key.
 */
export async function setCachedOptions(data: Record<string, unknown>, version: string | number): Promise<void> {
  const cache = caches.default;
  const res = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${OPTIONS_CACHE_TTL_SECONDS}`,
    },
  });
  await cache.put(optionsCacheKey(version), res);
}

/**
 * Build a list of URLs that should be purged after a content write operation.
 * Covers index, feed, and the specific post page.
 */
export interface ContentPurgeUrlsOptions {
  contentUrl?: string | null;
  categoryUrls?: Array<string | null | undefined>;
  tagUrls?: Array<string | null | undefined>;
  authorUrl?: string | null;
}

export function buildContentPurgeUrls(
  siteUrl: string,
  cid?: number,
  related: ContentPurgeUrlsOptions = {},
): string[] {
  const base = siteUrl.replace(/\/$/, '');
  
  // Skip if siteUrl is empty or not an absolute URL (test environment)
  if (!base || !base.startsWith('http')) {
    return [];
  }
  
  const urls = [
    base + '/',
    base + '/feed',
    base + '/feed/atom',
    base + '/feed/rss',
    base + '/feed/comments',
    base + '/feed/rss/comments',
    base + '/feed/atom/comments',
  ];
  if (cid) {
    urls.push(base + `/archives/${cid}/`);
  }
  if (related.contentUrl) urls.push(related.contentUrl);
  if (related.authorUrl) urls.push(related.authorUrl);
  for (const url of related.categoryUrls || []) {
    if (url) urls.push(url);
  }
  for (const url of related.tagUrls || []) {
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Purge content-related page cache entries (index + feeds + post page).
 *
 * Comment writes no longer bump cacheVersion (that would invalidate the
 * whole site on every comment). Instead this deletes the exact version-
 * stamped keys for the affected URLs from the local PoP cache; other PoPs
 * converge within the page s-maxage TTL. Best-effort: cache API errors
 * and unknown URL shapes are ignored.
 */
export async function purgeContentCache(
  siteUrl: string,
  cacheVersion: string | number,
  cid?: number,
  related: ContentPurgeUrlsOptions = {},
): Promise<void> {
  const urls = buildContentPurgeUrls(siteUrl, cid, related);
  if (urls.length === 0) return;
  const version = String(cacheVersion || 0);
  const cache = caches.default;
  await Promise.all(urls.map(async (url) => {
    // A visitor may have stored the key with or without a trailing slash
    // (both reach the same middleware path); delete both variants.
    const candidates = new Set([url, url.endsWith('/') ? url.slice(0, -1) : url]);
    for (const candidate of candidates) {
      try {
        await cache.delete(new Request(withCacheVersion(candidate, version)));
      } catch {
        // Best-effort purge — invalid URLs or cache errors are ignored.
      }
    }
  }));
}

/**
 * Purge site-wide cache: index + all feeds + options.
 * Used when site settings, theme, or plugin change.
 */
export async function purgeSiteCache(_siteUrl: string): Promise<void> {
  // Kept for plugin/source compatibility. The preceding cacheVersion bump
  // invalidates page and options keys across every PoP.
}
