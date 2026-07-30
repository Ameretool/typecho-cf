import { describe, expect, it } from 'vitest';
import {
  compilePermalinkPattern,
  renderPermalinkPattern,
} from '@/lib/permalink-pattern';

describe('permalink pattern grammar', () => {
  it('round-trips a post pattern through the shared renderer and matcher', () => {
    const pattern = '/{year}/{month}/{slug}.html';
    const path = renderPermalinkPattern(pattern, 'post', {
      year: '2026',
      month: '07',
      slug: 'hello',
    });
    expect(path).toBe('/2026/07/hello.html');
    expect(path!.match(compilePermalinkPattern(pattern, 'post')!)?.groups).toMatchObject({
      year: '2026',
      month: '07',
      slug: 'hello',
    });
  });

  it('rejects variables that the selected route cannot render', () => {
    expect(renderPermalinkPattern('/{year}/{slug}/', 'page', { slug: 'about' })).toBeNull();
    expect(compilePermalinkPattern('/{year}/{slug}/', 'page')).toBeNull();
  });

  it('rejects patterns with no resolvable identity', () => {
    expect(compilePermalinkPattern('/{year}/{month}/', 'post')).toBeNull();
  });

  it('escapes literal regex metacharacters', () => {
    const regex = compilePermalinkPattern('/docs+/{slug}.html', 'page')!;
    expect(regex.test('/docs+/about.html')).toBe(true);
    expect(regex.test('/docss/about.html')).toBe(false);
  });
});
