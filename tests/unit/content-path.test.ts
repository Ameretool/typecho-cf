import { describe, expect, it } from 'vitest';
import { isContentPathAllowed } from '@/lib/content-path';

describe('isContentPathAllowed', () => {
  it('allows every content default form while all patterns are default', () => {
    expect(isContentPathAllowed('/archives/123/', {})).toBe(true);
    expect(isContentPathAllowed('/archives/123', {})).toBe(true);
    expect(isContentPathAllowed('/about', {})).toBe(true);
    expect(isContentPathAllowed('/category/tech/', {})).toBe(true);
  });

  it('rejects the unified content entry regardless of configuration', () => {
    // /contents/{cid}/ is the internal rewrite target, never a public URL.
    expect(isContentPathAllowed('/contents/123/', {})).toBe(false);
    expect(isContentPathAllowed('/contents/123/', { permalinkPattern: '/archives/{cid}/' })).toBe(false);
    expect(isContentPathAllowed('/contents/123/', { permalinkPattern: '/contents/{cid}/' })).toBe(true);
  });

  it('rejects /archives/{cid}/ once the post pattern is custom', () => {
    const options = { permalinkPattern: '/post/{slug}/' };
    expect(isContentPathAllowed('/post/hello/', options)).toBe(true);
    expect(isContentPathAllowed('/archives/123/', options)).toBe(false);
    expect(isContentPathAllowed('/archives/123', options)).toBe(false);
    expect(isContentPathAllowed('/about', options)).toBe(true);
    expect(isContentPathAllowed('/category/tech/', options)).toBe(true);
  });

  it('rejects the bare-slug default form once the page pattern is custom', () => {
    const options = { pagePattern: '/pages/{slug}/' };
    expect(isContentPathAllowed('/pages/about/', options)).toBe(true);
    expect(isContentPathAllowed('/about', options)).toBe(false);
    expect(isContentPathAllowed('/nested/about.html', options)).toBe(true);
    expect(isContentPathAllowed('/archives/123/', options)).toBe(true);
    expect(isContentPathAllowed('/category/tech/', options)).toBe(true);
  });

  it('rejects /category/{slug}/ once the category pattern is custom', () => {
    const options = { categoryPattern: '/topics/{slug}/' };
    expect(isContentPathAllowed('/topics/tech/', options)).toBe(true);
    expect(isContentPathAllowed('/category/tech/', options)).toBe(false);
    expect(isContentPathAllowed('/category/tech', options)).toBe(false);
    expect(isContentPathAllowed('/archives/123/', options)).toBe(true);
    expect(isContentPathAllowed('/about', options)).toBe(true);
  });

  it('allows a custom pattern that overlaps the default URL form', () => {
    // /archives/{cid} (no trailing slash) is valid and its own canonical
    // URLs must not be rejected by the whitelist.
    const options = { permalinkPattern: '/archives/{cid}' };
    expect(isContentPathAllowed('/archives/123', options)).toBe(true);
    expect(isContentPathAllowed('/archives/123/', options)).toBe(false);
  });

  it('never gates fixed single-segment surfaces even under a custom page pattern', () => {
    // The bare-slug page form overlaps these surfaces; they are not content
    // URLs and must survive a custom page pattern.
    const options = { pagePattern: '/pages/{slug}/' };
    expect(isContentPathAllowed('/admin', options)).toBe(true);
    expect(isContentPathAllowed('/install', options)).toBe(true);
    expect(isContentPathAllowed('/feed', options)).toBe(true);
    expect(isContentPathAllowed('/search', options)).toBe(true);
    expect(isContentPathAllowed('/sitemap.xml', options)).toBe(true);
    expect(isContentPathAllowed('/robots.txt', options)).toBe(true);
  });

  it('does not know plugin routes (middleware exempts them via isPluginRoute)', () => {
    // Plugin front-end routes are dynamic and live in the plugin route table,
    // not here; a bare plugin slug is indistinguishable from a deprecated
    // default page form at this layer.
    const options = { pagePattern: '/pages/{slug}/' };
    expect(isContentPathAllowed('/webdav', options)).toBe(false);
    expect(isContentPathAllowed('/webdav', {})).toBe(true);
  });
  it('never gates non-content routes', () => {
    const options = {
      permalinkPattern: '/post/{slug}/',
      pagePattern: '/pages/{slug}/',
      categoryPattern: '/topics/{slug}/',
    };
    expect(isContentPathAllowed('/', options)).toBe(true);
    expect(isContentPathAllowed('/tag/x/', options)).toBe(true);
    expect(isContentPathAllowed('/author/1/', options)).toBe(true);
    expect(isContentPathAllowed('/search/foo', options)).toBe(true);
    expect(isContentPathAllowed('/feed', options)).toBe(true);
    expect(isContentPathAllowed('/search', options)).toBe(true);
    expect(isContentPathAllowed('/feed/atom', options)).toBe(true);
    expect(isContentPathAllowed('/category/tech/feed.xml', options)).toBe(true);
    expect(isContentPathAllowed('/sitemap.xml', options)).toBe(true);
    expect(isContentPathAllowed('/robots.txt', options)).toBe(true);
    expect(isContentPathAllowed('/admin/', options)).toBe(true);
    expect(isContentPathAllowed('/api/comment', options)).toBe(true);
    expect(isContentPathAllowed('/usr/uploads/2026/08/a.png', options)).toBe(true);
  });
});