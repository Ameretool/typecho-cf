import { describe, expect, it, vi } from 'vitest';
import {
  finalizeRequestResponse,
  mergeVary,
  resolveRequestTarget,
} from '@/lib/request-bootstrap';

describe('resolveRequestTarget()', () => {
  it('resolves pagination while preserving the original URL and query', () => {
    const locals = {} as App.Locals;
    const target = resolveRequestTarget(
      new Request('https://example.com/category/news/page/23/?sort=date'),
      locals,
    );
    expect(target.originalPath).toBe('/category/news/page/23/');
    expect(target.effectivePath).toBe('/category/news/');
    expect(target.routeTarget).toBe('/category/news/?sort=date');
    expect((locals as any)._page).toBe(23);
  });

  it('normalizes hostile page segments before a route can query with them', () => {
    const locals = {} as App.Locals;
    const target = resolveRequestTarget(new Request('https://example.com/page/Infinity/'), locals);
    expect(target.routeTarget).toBe('/');
    expect((locals as any)._page).toBe(1);

    resolveRequestTarget(new Request('https://example.com/page/999999999999/'), locals);
    expect((locals as any)._page).toBe(10_000);
  });
});

describe('finalizeRequestResponse()', () => {
  it('applies common headers and tracks a cookie-free cache write', async () => {
    const waitUntil = vi.fn();
    const put = vi.spyOn(caches.default, 'put');
    const request = new Request('https://example.com/page/2/');
    const cacheKey = new Request('https://example.com/page/2/?v=1');
    const response = await finalizeRequestResponse(new Response('ok', {
      headers: { 'Set-Cookie': 'secret=value' },
    }), { request, cacheKey, executionContext: { waitUntil } });

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(put).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(put.mock.results[0].value);
    const cached = put.mock.calls[0][1];
    expect(cached.headers.get('set-cookie')).toBeNull();
    expect(cached.headers.get('vary')).toContain('Cookie');
    put.mockRestore();
  });
});

describe('mergeVary()', () => {
  it('preserves and deduplicates tokens', () => {
    expect(mergeVary('Accept, Cookie', ['Cookie', 'Accept-Encoding']))
      .toBe('Accept, Cookie, Accept-Encoding');
  });
});
