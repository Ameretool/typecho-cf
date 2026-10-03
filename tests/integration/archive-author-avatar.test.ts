/**
 * Regression: homepage/archive lists must expose the author's real avatar URL
 * derived from the user's mail — not the local default (/img/avatar.svg).
 *
 * The old code built a temporary AuthorMap with `avatarUrl: defaultAvatar`
 * and then used `authorMap ??= fetchAuthors(...)`, which never overwrote the
 * already-set temporary map, so every list author showed the default avatar
 * even when the author had a mail address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, type TestDatabase } from '../helpers';
import { schema } from '@/db';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { prepareIndexData, prepareCategoryData } from '@/lib/page-data';

const NOW = Math.floor(Date.now() / 1000);

async function seedAuthorWithMail() {
  await testDb.insert(schema.users).values({
    name: 'alice',
    mail: 'alice@example.com',
    screenName: 'Alice',
    group: 'editor',
    authCode: 'x',
  });
  const author = (await testDb.query.users.findFirst())!;

  await testDb.insert(schema.contents).values({
    title: 'Avatar Post',
    slug: 'avatar-post',
    type: 'post',
    status: 'publish',
    authorId: author.uid,
    created: NOW - 60,
    modified: NOW - 60,
  });

  // Category so the category-archive path also has rows to render
  await testDb.insert(schema.metas).values({
    name: 'Tech', slug: 'tech', type: 'category', count: 0, order: 1,
  });
  const category = (await testDb.query.metas.findFirst({
    where: (t, { eq }) => eq(t.slug, 'tech'),
  }))!;
  const post = (await testDb.query.contents.findFirst({
    where: (t, { eq }) => eq(t.slug, 'avatar-post'),
  }))!;
  await testDb.insert(schema.relationships).values({ cid: post.cid, mid: category.mid });

  return { author, post };
}

function buildCtx() {
  return {
    db: testDb,
    options: {
      siteUrl: 'https://example.com',
      pageSize: 10,
      categoryPattern: '/category/{slug}/',
      permalinkPattern: '/archives/{cid}/',
      pagePattern: '/{slug}.html',
      commentsAvatarRating: 'G',
      commentsOrder: 'ASC',
      timezone: 0,
      commentsAntiSpam: 0,
      secret: '',
    } as any,
    urls: { siteUrl: 'https://example.com' } as any,
    user: null,
    isLoggedIn: false,
    csrfToken: null,
  };
}

// MD5('alice@example.com') on seccdn.libravatar.org
const ALICE_AVATAR = 'https://seccdn.libravatar.org/avatar/c160f8cc69a4f0bf2b0362752353d060?d=identicon&s=96&r=G';

describe('list author avatar (G7-?)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('index post author carries the mail-derived avatar URL, not the local default', async () => {
    await seedAuthorWithMail();
    const props = await prepareIndexData(buildCtx() as any, 'https://example.com/', {}, new URL('https://example.com/'));
    const post = props.posts[0];
    expect(post).toBeDefined();
    expect(post.author).not.toBeNull();
    expect(post.author!.avatarUrl).toBe(ALICE_AVATAR);
  });

  it('category archive post author also carries the real avatar URL', async () => {
    await seedAuthorWithMail();
    const result = await prepareCategoryData(
      buildCtx() as any,
      'tech',
      'https://example.com/category/tech/',
      {},
      new URL('https://example.com/category/tech/'),
    );
    if (!('posts' in result)) throw new Error('expected ThemeArchiveProps');
    expect(result.posts[0].author!.avatarUrl).toBe(ALICE_AVATAR);
    expect(result.posts[0].author!.avatarUrl).not.toBe('/img/avatar.svg');
  });
});
