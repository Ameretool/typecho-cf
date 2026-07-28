/**
 * Unit tests for src/lib/options.ts
 *
 * Tests loadOptions(), getOption(), setOption(), deleteOption() and computeUrls()
 * using an in-memory libSQL database via Drizzle ORM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../helpers';
import { loadOptions, getOption, setOption, deleteOption, computeUrls, ensureSecret } from '@/lib/options';

async function createOptionsTestDb() {
  return await createTestDb() as any;
}

describe('loadOptions()', () => {
  it('returns defaults when database is empty', async () => {
    const db = await createOptionsTestDb();
    const opts = await loadOptions(db);
    expect(opts.title).toBe('Hello World');
    expect(opts.pageSize).toBe(5);
    expect(opts.commentsPostInterval).toBe(60);
    expect(opts.timezone).toBe(28800);
  });

  it('overrides defaults with values from DB', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'My Blog');
    await setOption(db, 'pageSize', '10');
    const opts = await loadOptions(db);
    expect(opts.title).toBe('My Blog');
    expect(opts.pageSize).toBe(10);
  });

  it('parses numeric option keys as integers', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'allowRegister', '1');
    const opts = await loadOptions(db);
    expect(typeof opts.allowRegister).toBe('number');
    expect(opts.allowRegister).toBe(1);
  });

  it('does not auto-generate secret in the read path', async () => {
    // loadOptions is a pure read; secret bootstrap is now handled by
    // ensureSecret() during install / by middleware for PHP migrations.
    const db = await createOptionsTestDb();
    const opts = await loadOptions(db);
    expect(opts.secret).toBeUndefined();
  });

  it('ensureSecret generates and persists on first call, reuses on subsequent calls', async () => {
    const db = await createOptionsTestDb();
    const first = await ensureSecret(db);
    expect(first).toBeTruthy();
    expect(first.length).toBeGreaterThan(0);
    const second = await ensureSecret(db);
    expect(second).toBe(first);
  });
});

describe('getOption()', () => {
  it('returns null for non-existent option', async () => {
    const db = await createOptionsTestDb();
    expect(await getOption(db, 'nonexistent')).toBeNull();
  });

  it('returns stored value', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'Test Blog');
    expect(await getOption(db, 'title')).toBe('Test Blog');
  });
});

describe('setOption()', () => {
  it('inserts a new option', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'theme', 'my-theme');
    expect(await getOption(db, 'theme')).toBe('my-theme');
  });

  it('updates an existing option (upsert)', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'title', 'First');
    await setOption(db, 'title', 'Updated');
    expect(await getOption(db, 'title')).toBe('Updated');
  });
});

describe('deleteOption()', () => {
  it('removes an option', async () => {
    const db = await createOptionsTestDb();
    await setOption(db, 'toDelete', 'value');
    await deleteOption(db, 'toDelete');
    expect(await getOption(db, 'toDelete')).toBeNull();
  });

  it('does not throw when deleting non-existent option', async () => {
    const db = await createOptionsTestDb();
    await expect(deleteOption(db, 'ghost')).resolves.toBeUndefined();
  });
});

describe('computeUrls()', () => {
  const baseOpts = {
    siteUrl: 'https://example.com',
    theme: 'typecho-theme-minimal',
  } as any;

  it('computes admin URL', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.adminUrl).toBe('https://example.com/admin/');
  });

  it('strips trailing slash from siteUrl', () => {
    const urls = computeUrls({ ...baseOpts, siteUrl: 'https://example.com/' });
    expect(urls.siteUrl).toBe('https://example.com');
  });

  it('computes feed URLs', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.feedUrl).toBe('https://example.com/feed');
    expect(urls.feedRssUrl).toBe('https://example.com/feed/rss');
    expect(urls.feedAtomUrl).toBe('https://example.com/feed/atom');
  });

  it('themeUrl builds correct path', () => {
    const urls = computeUrls(baseOpts);
    expect(urls.themeUrl('style.css')).toBe('https://example.com/themes/typecho-theme-minimal/style.css');
  });
});
