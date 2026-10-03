/**
 * Unit tests for the prerendered-content cache (typecho_contents_rendered).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';
import * as schema from '@/db/schema';
import {
  getRenderedContent,
  getRenderedExcerpts,
  invalidateRenderedContent,
  isExcerptFresh,
  isRenderedFresh,
  pluginPartOf,
  hasMoreOf,
  resetRenderedLru,
  warmRenderedOnCacheHit,
  resetWarmedContentKeys,
  hashSource,
} from '@/lib/rendered-content';

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = await createTestDb();
  resetRenderedLru();
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('sourceHash helpers', () => {
  it('parses plugin and hasMore segments (new three-part format)', () => {
    const h = hashSource('hello');
    expect(pluginPartOf(h + '|antispam,webdav|1')).toBe('antispam,webdav');
    expect(hasMoreOf(h + '|antispam|1')).toBe(true);
    expect(hasMoreOf(h + '|antispam|0')).toBe(false);
  });

  it('handles legacy two-segment hashes', () => {
    const h = hashSource('hello');
    expect(pluginPartOf(h + '|antispam')).toBe('antispam');
    expect(hasMoreOf(h + '|antispam')).toBe(false);
    expect(pluginPartOf(null)).toBe('');
    expect(hasMoreOf(null)).toBe(false);
  });
});

describe('freshness helpers', () => {
  it('detail freshness requires matching hash and full html', () => {
    const row = { renderedHtml: '<p>x</p>', renderedExcerpt: '<p>x</p>', sourceHash: 'h|p|0', renderedAt: 100 };
    expect(isRenderedFresh(row, 'h|p|0')).toBe(true);
    expect(isRenderedFresh(row, 'other')).toBe(false);
    expect(isRenderedFresh({ ...row, renderedHtml: null }, 'h|p|0')).toBe(false);
  });

  it('excerpt freshness compares renderedAt >= modified', () => {
    const row = { renderedHtml: '<p>x</p>', renderedExcerpt: '<p>x</p>', sourceHash: 'h|p|0', renderedAt: 200 };
    expect(isExcerptFresh(row, 100)).toBe(true);
    expect(isExcerptFresh(row, 200)).toBe(true);
    expect(isExcerptFresh(row, 201)).toBe(false);
    expect(isExcerptFresh({ ...row, renderedAt: null }, 100)).toBe(false);
  });
});

describe('getRenderedContent()', () => {
  it('renders on miss and backfills the prerender table', async () => {
    const res = await getRenderedContent((testDb as any), 1, '## Hello\n\nWorld');
    expect(res.html).toContain('<h2>Hello</h2>');
    const row = await testDb.query.contentsRendered.findFirst();
    expect(row?.cid).toBe(1);
    expect(row?.renderedHtml).toBe(res.html);
    expect(row?.sourceHash).toContain('|');
  });

  it('serves a fresh prerendered row consistently across calls', async () => {
    await getRenderedContent((testDb as any), 7, 'body');
    const first = await getRenderedContent((testDb as any), 7, 'body');
    const second = await getRenderedContent((testDb as any), 7, 'body');
    expect(first.html).toBe(second.html);
    expect(first.plainExcerpt).toBe('body');
  });

  it('re-renders when the content changes (hash mismatch)', async () => {
    await getRenderedContent((testDb as any), 3, 'v1');
    const res = await getRenderedContent((testDb as any), 3, 'v2 **bold**');
    expect(res.html).toContain('<strong>bold</strong>');
    const row = await testDb.query.contentsRendered.findFirst();
    expect(row?.renderedHtml).toContain('<strong>');
  });
});

describe('getRenderedExcerpts()', () => {
  it('renders and backfills missing excerpts in one pass', async () => {
    await testDb.insert(schema.contents).values([
      { cid: 1, title: 'A', type: 'post', status: 'publish', created: 100, modified: 100, text: '**excerpt A**' },
      { cid: 2, title: 'B', type: 'post', status: 'publish', created: 100, modified: 100, text: 'excerpt B' },
    ]);
    const map = await getRenderedExcerpts((testDb as any), [
      { cid: 1, modified: 100, moreText: '- 阅读剩余部分 -', permalink: '/archives/1/' },
      { cid: 2, modified: 100, moreText: '- 阅读剩余部分 -', permalink: '/archives/2/' },
    ]);
    expect(map.get(1)).toContain('<strong>excerpt A</strong>');
    expect(map.get(2)).toContain('excerpt B');
    const rows = await testDb.select().from(schema.contentsRendered);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => !!r.renderedExcerpt)).toBe(true);
  });

  it('adds the more link only when the source has <!--more-->', async () => {
    await testDb.insert(schema.contents).values({
      cid: 10, title: 'C', type: 'post', status: 'publish', created: 100, modified: 100,
      text: 'part1\n\n<!--more-->\n\npart2',
    });
    const map = await getRenderedExcerpts((testDb as any), [
      { cid: 10, modified: 100, moreText: '更多', permalink: '/archives/10/' },
    ]);
    expect(map.get(10)).toContain('class="more"');
  });

  it('serves cached excerpts and invalidates when modified advances', async () => {
    await testDb.insert(schema.contents).values({
      cid: 20, title: 'D', type: 'post', status: 'publish', created: 100, modified: 100, text: 'cached body',
    });
    await getRenderedExcerpts((testDb as any), [{ cid: 20, modified: 100, moreText: '更多', permalink: '/archives/20/' }]);
    // Same modified → cached (row still fresh).
    const cached = await getRenderedExcerpts((testDb as any), [{ cid: 20, modified: 100, moreText: '更多', permalink: '/archives/20/' }]);
    expect(cached.get(20)).toContain('cached body');
    // modified advanced past renderedAt → re-render from contents.text.
    const stale = await getRenderedExcerpts((testDb as any), [{ cid: 20, modified: 999999999, moreText: '更多', permalink: '/archives/20/' }]);
    expect(stale.get(20)).toContain('cached body');
  });

  it('invalidateRenderedContent removes the prerender row', async () => {
    await getRenderedContent((testDb as any), 5, 'x');
    await invalidateRenderedContent((testDb as any), 5);
    const rows = await testDb.select().from(schema.contentsRendered);
    expect(rows).toHaveLength(0);
  });
});
describe('warmRenderedOnCacheHit()', () => {
  it('renders and backfills the prerender table on cache hit', async () => {
    await testDb.insert(schema.contents).values({
      cid: 50, title: 'W', type: 'post', status: 'publish', created: 100, modified: 100, text: 'warm body **bold**',
    });
    const tasks: Promise<unknown>[] = [];
    warmRenderedOnCacheHit(testDb as any, [], 50, 7, (p) => { tasks.push(p); });
    await Promise.all(tasks);
    const row = await testDb.query.contentsRendered.findFirst({ where: (r, { eq }) => eq(r.cid, 50) });
    expect(row?.renderedHtml).toContain('<strong>bold</strong>');
  });

  it('dedupes by (cacheVersion, cid), re-warms on version bump and after reset', async () => {
    await testDb.insert(schema.contents).values({
      cid: 51, title: 'W2', type: 'post', status: 'publish', created: 100, modified: 100, text: 'body2',
    });
    let count = 0;
    const tasks: Promise<unknown>[] = [];
    const waitFn = (p: Promise<unknown>) => { count++; tasks.push(p); };
    warmRenderedOnCacheHit(testDb as any, [], 51, 1, waitFn);
    warmRenderedOnCacheHit(testDb as any, [], 51, 1, waitFn); // 同版本去重
    expect(count).toBe(1);
    warmRenderedOnCacheHit(testDb as any, [], 51, 2, waitFn); // 版本变化重新预热
    expect(count).toBe(2);
    resetWarmedContentKeys();
    warmRenderedOnCacheHit(testDb as any, [], 51, 1, waitFn); // reset 后允许再预热
    expect(count).toBe(3);
    await Promise.all(tasks);
  });
});