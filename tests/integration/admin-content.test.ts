/**
 * Integration tests for POST /api/admin/content.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, makeAuthCookie, type TestDatabase } from '../helpers';
import { eq } from 'drizzle-orm';

let testDb: TestDatabase;
const { mockApplyFilter } = vi.hoisted(() => ({
  mockApplyFilter: vi.fn(async (_ctx: any, _hook: string, data: any) => data),
}));

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return { ...actual, requireAdminCSRF: async () => null };
});

vi.mock('@/lib/plugin', () => ({
  parseActivatedPlugins: () => [],
  setActivatedPlugins: () => {},
  applyFilter: mockApplyFilter,
  doHook: async () => {},
}));

import { POST } from '@/pages/api/admin/content';

const TEST_SECRET = 'content-secret';
const TEST_AUTH_CODE = 'content-auth-code';

async function makeContentRequest(fields: Record<string, string>, cookie: string) {
  const body = new URLSearchParams(fields);
  return new Request('https://example.com/api/admin/content', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      // G2-1: requireAdminAction enforces same-origin via Origin/Referer.
      origin: 'https://example.com',
    },
    body: body.toString(),
  });
}

describe('POST /api/admin/content', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedAdmin(testDb, { secret: TEST_SECRET, authCode: TEST_AUTH_CODE });
    await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
    mockApplyFilter.mockImplementation(async (_ctx: any, _hook: string, data: any) => data);
  });

  it('counts duplicate tag names once when creating content', async () => {
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create',
      type: 'post',
      title: 'Tagged post',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
      tags: 'astro, astro, Astro',
      allowFeed: '1',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const tags = await testDb.select().from(schema.metas).where(eq(schema.metas.type, 'tag'));
    const rels = await testDb.select().from(schema.relationships);
    expect(tags).toHaveLength(1);
    expect(tags[0].count).toBe(1);
    expect(rels).toHaveLength(1);
  });

  it('deduplicates slug when updating to another content slug', async () => {
    await testDb.insert(schema.contents).values({
      title: 'First',
      slug: 'shared-slug',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    await testDb.insert(schema.contents).values({
      title: 'Second',
      slug: 'second',
      type: 'post',
      status: 'publish',
      authorId: 1,
    });
    const second = await testDb.query.contents.findFirst({
      where: eq(schema.contents.slug, 'second'),
    });

    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update',
      cid: String(second!.cid),
      type: 'post',
      title: 'Second updated',
      slug: 'shared-slug',
      text: 'Body',
      status: 'publish',
      visibility: 'publish',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);

    const updated = await testDb.query.contents.findFirst({
      where: eq(schema.contents.cid, second!.cid),
    });
    expect(updated?.slug).toBe(`shared-slug-${second!.cid}`);
  });

  it('saves an edit of a published post as a revision and keeps the published row', async () => {
    const [post] = await testDb.insert(schema.contents).values({
      title: 'Published', slug: 'published', text: 'Live body', type: 'post', status: 'publish', authorId: 1,
      created: 1000,
    }).returning({ cid: schema.contents.cid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'update', cid: String(post.cid), type: 'post', title: 'Edited', slug: 'published', text: 'Draft body',
      status: 'draft', visibility: 'publish',
    }, cookie);
    expect((await POST({ request: req, locals: {} } as any)).status).toBe(302);
    const saved = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) });
    const revision = await testDb.query.contents.findFirst({
      where: eq(schema.contents.type, 'revision'),
    });
    expect(saved).toMatchObject({ title: 'Published', text: 'Live body', type: 'post', status: 'publish', created: 1000 });
    expect(revision).toMatchObject({ title: 'Edited', text: 'Draft body', type: 'revision', status: 'draft', parent: post.cid });
  });

  it('restores protected author and type fields after a malicious write filter', async () => {
    mockApplyFilter.mockImplementationOnce(async (_ctx: any, _hook: string, data: any) => ({
      ...data,
      title: 'Filtered title',
      authorId: 999,
      type: 'attachment',
      cid: 999,
    }));
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const req = await makeContentRequest({
      do: 'create', type: 'post', title: 'Original', text: 'Body',
      status: 'publish', visibility: 'publish', allowFeed: '1',
    }, cookie);

    const res = await POST({ request: req, locals: {} } as any);
    expect(res.status).toBe(302);
    const saved = await testDb.query.contents.findFirst();
    expect(saved).toMatchObject({ title: 'Filtered title', authorId: admin!.uid, type: 'post' });
    expect(saved?.cid).not.toBe(999);
  });

  it('updates one revision on repeated draft saves and removes it on publish', async () => {
    const [post] = await testDb.insert(schema.contents).values({ title: 'Live', slug: 'live', text: 'old', type: 'post', status: 'publish', authorId: 1, created: 1000 }).returning({ cid: schema.contents.cid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    const save = (text: string) => makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Live', slug: 'live', text, status: 'draft', visibility: 'publish' }, cookie);
    await POST({ request: await save('draft 1'), locals: {} } as any);
    await POST({ request: await save('draft 2'), locals: {} } as any);
    let revisions = await testDb.select().from(schema.contents).where(eq(schema.contents.type, 'revision'));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].text).toBe('draft 2');
    const publish = await makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Published again', slug: 'live', text: 'new live', status: 'publish', visibility: 'publish' }, cookie);
    await POST({ request: publish, locals: {} } as any);
    revisions = await testDb.select().from(schema.contents).where(eq(schema.contents.type, 'revision'));
    const updated = await testDb.query.contents.findFirst({ where: eq(schema.contents.cid, post.cid) });
    expect(revisions).toHaveLength(0);
    expect(updated).toMatchObject({ title: 'Published again', text: 'new live', type: 'post', status: 'publish' });
  });

  it('keeps revision metadata isolated from published counts', async () => {
    const [category] = await testDb.insert(schema.metas).values({ name: 'News', slug: 'news', type: 'category', count: 1 }).returning();
    const [post] = await testDb.insert(schema.contents).values({ title: 'Live', slug: 'live-meta', text: 'old', type: 'post', status: 'publish', authorId: 1 }).returning({ cid: schema.contents.cid });
    await testDb.insert(schema.relationships).values({ cid: post.cid, mid: category.mid });
    const admin = await testDb.query.users.findFirst();
    const cookie = await makeAuthCookie(testDb, admin!.uid, TEST_AUTH_CODE, TEST_SECRET);
    await POST({ request: await makeContentRequest({ do: 'update', cid: String(post.cid), type: 'post', title: 'Draft', slug: 'live-meta', text: 'draft', status: 'draft', visibility: 'publish', 'category[]': String(category.mid), 'fieldNames[]': 'source', 'fieldTypes[source]': 'str', 'fieldValues[source]': 'draft' }, cookie), locals: {} } as any);
    const revision = await testDb.query.contents.findFirst({ where: eq(schema.contents.type, 'revision') });
    expect(revision).toBeTruthy();
    expect((await testDb.query.metas.findFirst({ where: eq(schema.metas.mid, category.mid) }))?.count).toBe(1);
    expect((await testDb.query.fields.findFirst({ where: eq(schema.fields.cid, revision!.cid) }))?.str_value).toBe('draft');
  });
});
