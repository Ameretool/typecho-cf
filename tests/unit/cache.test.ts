/**
 * Unit tests for cache URL planning.
 */
import { describe, it, expect } from 'vitest';
import { buildContentPurgeUrls, purgeContentCache, withCacheVersion } from '@/lib/cache';

describe('buildContentPurgeUrls()', () => {
  it('includes custom permalink and related archive URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com/', 42, {
      contentUrl: 'https://example.com/posts/hello/',
      categoryUrls: ['https://example.com/category/tech/'],
      tagUrls: ['https://example.com/tag/astro/'],
      authorUrl: 'https://example.com/author/1/',
    });

    expect(urls).toContain('https://example.com/');
    expect(urls).toContain('https://example.com/feed/rss/comments');
    expect(urls).toContain('https://example.com/archives/42/');
    expect(urls).toContain('https://example.com/posts/hello/');
    expect(urls).toContain('https://example.com/category/tech/');
    expect(urls).toContain('https://example.com/tag/astro/');
    expect(urls).toContain('https://example.com/author/1/');
  });

  it('deduplicates URLs', () => {
    const urls = buildContentPurgeUrls('https://example.com', 1, {
      contentUrl: 'https://example.com/archives/1/',
    });

    expect(urls.filter((url) => url === 'https://example.com/archives/1/')).toHaveLength(1);
  });

});

describe('purgeContentCache()', () => {
  it('deletes version-stamped keys for index, feeds and the post page only', async () => {
    const siteUrl = 'https://example.com';
    await caches.default.put(new Request(withCacheVersion(siteUrl + '/', 3)), new Response('<html>index</html>'));
    await caches.default.put(new Request(withCacheVersion(siteUrl + '/archives/42/', 3)), new Response('<html>post</html>'));
    await caches.default.put(new Request(withCacheVersion(siteUrl + '/feed', 3)), new Response('<rss/>'));
    // unrelated page must survive
    await caches.default.put(new Request(withCacheVersion(siteUrl + '/about/', 3)), new Response('<html>about</html>'));

    await purgeContentCache(siteUrl, 3, 42);

    expect(await caches.default.match(new Request(withCacheVersion(siteUrl + '/', 3)))).toBeUndefined();
    expect(await caches.default.match(new Request(withCacheVersion(siteUrl + '/archives/42/', 3)))).toBeUndefined();
    expect(await caches.default.match(new Request(withCacheVersion(siteUrl + '/feed', 3)))).toBeUndefined();
    expect(await caches.default.match(new Request(withCacheVersion(siteUrl + '/about/', 3)))).toBeDefined();
  });

  it('purges the no-trailing-slash variant of the post URL', async () => {
    await caches.default.put(new Request(withCacheVersion('https://example.com/archives/42', 5)), new Response('x'));
    await purgeContentCache('https://example.com', 5, 42);
    expect(await caches.default.match(new Request(withCacheVersion('https://example.com/archives/42', 5)))).toBeUndefined();
  });

  it('is a no-op for empty or non-absolute siteUrl', async () => {
    await expect(purgeContentCache('', 1, 1)).resolves.toBeUndefined();
    await expect(purgeContentCache('relative/path', 1, 1)).resolves.toBeUndefined();
  });
});

