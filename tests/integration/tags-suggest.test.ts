/**
 * Integration tests for GET /api/admin/tags-suggest
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { GET } from '@/pages/api/admin/tags-suggest';

const SECRET = 'test-secret-tags';
const AUTH_CODE = 'authcodetags';

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH_CODE });
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: 'https://example.com' });
  await testDb.insert(schema.metas).values([
    { name: 'JavaScript', slug: 'javascript', type: 'tag', count: 0 },
    { name: 'TypeScript', slug: 'typescript', type: 'tag', count: 0 },
    { name: 'News', slug: 'news', type: 'category', count: 0 },
  ]);
});

afterEach(async () => {
  await disposeTestDb(testDb);
});

describe('GET /api/admin/tags-suggest', () => {
  it('returns 401 without auth', async () => {
    const req = new Request('https://example.com/api/admin/tags-suggest?q=java');
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns matching tag names for a same-origin GET without CSRF token', async () => {
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/tags-suggest?q=script', {
      headers: { cookie, origin: 'https://example.com' },
    });
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);
    const body = await res.json<string[]>();
    expect(body.sort()).toEqual(['JavaScript', 'TypeScript']);
  });

  it('treats LIKE metacharacters literally', async () => {
    await testDb.insert(schema.metas).values({ name: '100% juice', slug: '100-juice', type: 'tag', count: 0 });
    const cookie = await makeAuthCookie(testDb, 1, AUTH_CODE, SECRET);
    const req = new Request('https://example.com/api/admin/tags-suggest?q=100%', {
      headers: { cookie },
    });
    const res = await GET({ request: req, locals: {}, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);
    const body = await res.json<string[]>();
    expect(body).toEqual(['100% juice']);
  });
});
