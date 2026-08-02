import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import { deleteAttachments } from '@/lib/attachment-lifecycle';
import { addHook, removePluginHooks } from '@/lib/plugin';
import { createTestDb, disposeTestDb, seedAdmin, type TestDatabase } from '../helpers';

const PLUGIN_ID = 'attachment-lifecycle-fixture';
let db: TestDatabase;

async function attachment(authorId: number, slug: string, text: string) {
  const [row] = await db.insert(schema.contents).values({
    title: slug,
    slug,
    type: 'attachment',
    status: 'publish',
    authorId,
    text,
  }).returning();
  return row;
}

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  removePluginHooks(PLUGIN_ID);
  vi.restoreAllMocks();
  await disposeTestDb(db);
});

describe('deleteAttachments()', () => {
  it('classifies targets, deduplicates IDs, invokes hooks, and deletes rows set-wise', async () => {
    const actor = await seedAdmin(db, { secret: 'secret', authCode: 'code', group: 'editor' });
    const owned = await attachment(actor.uid, 'owned', JSON.stringify({ path: 'usr/uploads/owned.jpg' }));
    const malformed = await attachment(actor.uid, 'malformed', '{bad-json');
    const forbidden = await attachment(99, 'forbidden', JSON.stringify({ path: 'usr/uploads/forbidden.jpg' }));
    const [post] = await db.insert(schema.contents).values({
      title: 'post', slug: 'post', type: 'post', status: 'publish', authorId: actor.uid,
    }).returning();
    const hook = vi.fn();
    addHook('upload:delete', PLUGIN_ID, hook);
    const bucket = { delete: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await deleteAttachments({
      db: db as any,
      bucket: bucket as any,
      pluginCtx: { activatedPlugins: new Set([PLUGIN_ID]) },
      actor: { uid: actor.uid, group: actor.group, user: actor },
      request: new Request('https://example.com/api/admin/media-batch', { method: 'POST' }),
      options: { siteUrl: 'https://example.com' } as any,
    }, [owned.cid, owned.cid, malformed.cid, forbidden.cid, post.cid, 999]);

    expect(result).toEqual({
      deleted: [owned.cid, malformed.cid],
      forbidden: [forbidden.cid],
      missing: [post.cid, 999],
      orphanRisk: [malformed.cid],
    });
    expect(bucket.delete).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith('usr/uploads/owned.jpg');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(await db.query.contents.findFirst({ where: (t, { eq }) => eq(t.cid, owned.cid) })).toBeUndefined();
    expect(await db.query.contents.findFirst({ where: (t, { eq }) => eq(t.cid, forbidden.cid) })).toBeTruthy();
  });

  it('reports R2 failures but still removes the database row', async () => {
    const actor = await seedAdmin(db, { secret: 'secret', authCode: 'code' });
    const row = await attachment(actor.uid, 'r2-failure', JSON.stringify({ path: 'usr/uploads/failure.jpg' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await deleteAttachments({
      db: db as any,
      bucket: { delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')) } as any,
      pluginCtx: { activatedPlugins: new Set() },
      actor: { uid: actor.uid, group: actor.group, user: actor },
      request: new Request('https://example.com/api/admin/upload?cid=1', { method: 'DELETE' }),
      options: { siteUrl: 'https://example.com' } as any,
    }, [row.cid]);

    expect(result.deleted).toEqual([row.cid]);
    expect(result.orphanRisk).toEqual([row.cid]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'attachment_orphan_risk',
      cid: row.cid,
      reason: 'r2_delete_failed',
    }));
    expect(await db.query.contents.findFirst({ where: (t, { eq }) => eq(t.cid, row.cid) })).toBeUndefined();
  });
});
