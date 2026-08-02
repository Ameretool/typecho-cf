import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import { resolveUniqueContentSlug, resolveUniqueMetaSlug } from '@/lib/slug';
import { createTestDb, disposeTestDb, type TestDatabase } from '../helpers';

let db: TestDatabase;

beforeEach(async () => { db = await createTestDb(); });
afterEach(async () => { await disposeTestDb(db); });

describe('slug namespace resolution', () => {
  it('normalizes unsafe content slugs and uses the current cid suffix on conflict', async () => {
    await db.insert(schema.contents).values({
      title: 'one', slug: 'hello-world', type: 'post', status: 'publish', authorId: 1,
    });
    expect(await resolveUniqueContentSlug(db as any, ' Hello / World?# ', 22))
      .toBe('hello-world-22');
  });

  it('resolves metadata conflicts only within the same type namespace', async () => {
    await db.insert(schema.metas).values([
      { name: 'Category', slug: 'news', type: 'category' },
      { name: 'Tag', slug: 'news', type: 'tag' },
    ]);
    expect(await resolveUniqueMetaSlug(db as any, 'News', 'category', 0, 'category'))
      .toBe('news-2');
    expect(await resolveUniqueMetaSlug(db as any, 'News', 'tag', 0, 'tag'))
      .toBe('news-2');
    expect(await resolveUniqueMetaSlug(db as any, 'Fresh', 'tag', 0, 'tag'))
      .toBe('fresh');
  });
});
