/**
 * Unit tests for cache URL planning.
 */
import { describe, it, expect } from 'vitest';
import { buildContentPurgeUrls, isCacheablePublicPath } from '@/lib/cache';

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

describe('isCacheablePublicPath()', () => {
  const defaults = {}; // every pattern falls back to its preset default

  it('caches the index', () => {
    expect(isCacheablePublicPath('/', defaults)).toBe(true);
  });

  it('caches default post/page/category permalink URLs', () => {
    expect(isCacheablePublicPath('/archives/123/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/archives/123', defaults)).toBe(true);
    expect(isCacheablePublicPath('/about', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech', defaults)).toBe(true);
  });

  it('caches bare slugs under the default page pattern', () => {
    expect(isCacheablePublicPath('/about', defaults)).toBe(true);
    // /{slug} also covers dotted slugs; fixed single-segment surfaces stay out.
    expect(isCacheablePublicPath('/about.html', defaults)).toBe(true);
    expect(isCacheablePublicPath('/admin', defaults)).toBe(false);
  });

  it('caches tag/author/search archives (incl. pagination-normalized paths)', () => {
    expect(isCacheablePublicPath('/tag/tech/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/author/1/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/search/hello', defaults)).toBe(true);
  });

  it('caches feeds, sitemap and robots', () => {
    expect(isCacheablePublicPath('/feed/', defaults)).toBe(true);
    expect(isCacheablePublicPath('/feed/atom', defaults)).toBe(true);
    expect(isCacheablePublicPath('/feed/rss/comments', defaults)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/tag/tech/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/author/1/feed.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/sitemap.xml', defaults)).toBe(true);
    expect(isCacheablePublicPath('/robots.txt', defaults)).toBe(true);
  });

  it('never caches admin/api/upload paths', () => {
    expect(isCacheablePublicPath('/admin/', defaults)).toBe(false);
    expect(isCacheablePublicPath('/admin/options-general', defaults)).toBe(false);
    expect(isCacheablePublicPath('/api/comment', defaults)).toBe(false);
    expect(isCacheablePublicPath('/usr/uploads/2026/08/a.png', defaults)).toBe(false);
  });

  it('follows custom post permalink patterns', () => {
    const opts = { permalinkPattern: '/posts/{slug}/' };
    expect(isCacheablePublicPath('/posts/hello/', opts)).toBe(true);
    expect(isCacheablePublicPath('/archives/123/', opts)).toBe(false);
  });

  it('follows custom page and category patterns', () => {
    const opts = { pagePattern: '/pages/{slug}/', categoryPattern: '/topics/{slug}/' };
    expect(isCacheablePublicPath('/pages/about/', opts)).toBe(true);
    expect(isCacheablePublicPath('/about', opts)).toBe(false);
    expect(isCacheablePublicPath('/topics/tech/', opts)).toBe(true);
    expect(isCacheablePublicPath('/category/tech/', opts)).toBe(false);
  });

  it('still guards admin paths under a pathological custom pattern', () => {
    const opts = { pagePattern: '/admin/{slug}/' };
    expect(isCacheablePublicPath('/admin/settings/', opts)).toBe(false);
  });
});
