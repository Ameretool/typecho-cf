/**
 * Sidebar data loader
 * Aggregates recent posts, comments, categories, and archives
 * Uses db.batch() to execute all queries in a single D1 round-trip.
 */
import { eq, desc, and, gt, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { schema } from '@/db';
import { buildPermalink, buildCategoryLink, buildDateLink } from '@/lib/content';
import { applyFilterSafely, type HookContext } from '@/lib/plugin';
import { publishedPostCondition, nowSeconds } from '@/lib/content-visibility';

type SidebarDatabase = Pick<Database, 'batch' | 'select'>;
// Snapshots are version-keyed, so content/options writes invalidate them by
// changing the key. A longer TTL mainly protects logged-in/cache-bypassed page
// views from repeatedly rebuilding identical global chrome data.
const SIDEBAR_SNAPSHOT_TTL_MS = 300_000;

// The monthly archives widget only scans this many seconds of history. Old
// months drop out of the sidebar widget (the posts themselves stay online),
// which bounds the GROUP BY scan on large sites.
const SIDEBAR_ARCHIVE_WINDOW_SECONDS = 13 * 30 * 24 * 3600;

export interface SidebarData {
  recentPosts: Array<{ title: string; permalink: string }>;
  recentComments: Array<{ author: string; excerpt: string; permalink: string }>;
  categories: Array<{ name: string; slug: string; count: number; permalink: string }>;
  archives: Array<{ date: string; permalink: string }>;
}

type SidebarSnapshot = { key: string; expiresAt: number; data: SidebarData };
type NavPage = { title: string; slug: string; permalink: string };
type NavSnapshot = { key: string; expiresAt: number; data: NavPage[] };
// Isolate-level snapshots (not WeakMap-by-db): getDb() yields a fresh handle
// each request, so Database-keyed WeakMaps never reuse across requests.
let sidebarSnapshot: SidebarSnapshot | null = null;
let navSnapshot: NavSnapshot | null = null;

/**
 * Drop the isolate sidebar snapshot (recent posts/comments, categories,
 * monthly archives). Comment writes call this alongside purgeContentCache:
 * the snapshot keys on cacheVersion, which comments no longer bump, so a
 * locally-purged page would otherwise re-render with a stale widget for up
 * to the snapshot TTL.
 */
export function invalidateSidebarSnapshot(): void {
  sidebarSnapshot = null;
}

/** Test-only: clear isolate sidebar/nav snapshots. */
export function resetSidebarSnapshots(): void {
  sidebarSnapshot = null;
  navSnapshot = null;
}

function cloneSidebarData(data: SidebarData): SidebarData {
  return {
    recentPosts: data.recentPosts.map(item => ({ ...item })),
    recentComments: data.recentComments.map(item => ({ ...item })),
    categories: data.categories.map(item => ({ ...item })),
    archives: data.archives.map(item => ({ ...item })),
  };
}

function sidebarQueries(db: SidebarDatabase) {
  return [
    // Recent posts
    db
      .select({
        cid: schema.contents.cid,
        title: schema.contents.title,
        slug: schema.contents.slug,
        type: schema.contents.type,
        created: schema.contents.created,
      })
      .from(schema.contents)
      .where(publishedPostCondition())
      .orderBy(desc(schema.contents.created))
      .limit(10),

    // Recent comments — only need a short preview, not the whole body.
    db
      .select({
        coid: schema.comments.coid,
        cid: schema.comments.cid,
        author: schema.comments.author,
        text: sql<string>`substr(${schema.comments.text}, 1, 200)`,
      })
      .from(schema.comments)
      .where(eq(schema.comments.status, 'approved'))
      .orderBy(desc(schema.comments.created))
      .limit(10),

    // Categories
    db
      .select({
        name: schema.metas.name,
        slug: schema.metas.slug,
        count: schema.metas.count,
        order: schema.metas.order,
      })
      .from(schema.metas)
      .where(eq(schema.metas.type, 'category'))
      .orderBy(schema.metas.order),

    // Archives (by month)
    // Bound the scan to the recent window — strftime() cannot use the
    // (type, status, created) index for grouping, so this would otherwise
    // read every published row on each snapshot rebuild.
    db
      .select({
        year: sql<number>`cast(strftime('%Y', ${schema.contents.created}, 'unixepoch') as integer)`,
        month: sql<number>`cast(strftime('%m', ${schema.contents.created}, 'unixepoch') as integer)`,
      })
      .from(schema.contents)
      .where(and(
        publishedPostCondition(nowSeconds()),
        gt(schema.contents.created, nowSeconds() - SIDEBAR_ARCHIVE_WINDOW_SECONDS),
      ))
      .groupBy(
        sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`,
        sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`,
      )
      .orderBy(desc(sql`strftime('%Y', ${schema.contents.created}, 'unixepoch')`), desc(sql`strftime('%m', ${schema.contents.created}, 'unixepoch')`)),
  ] as const;
}

function navQuery(db: SidebarDatabase) {
  return db
    .select({
      cid: schema.contents.cid,
      title: schema.contents.title,
      slug: schema.contents.slug,
      type: schema.contents.type,
      created: schema.contents.created,
      order: schema.contents.order,
    })
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.type, 'page'),
        eq(schema.contents.status, 'publish')
      )
    )
    .orderBy(schema.contents.order);
}

function mapSidebarRows(
  recentPostRows: any[],
  recentCommentRows: any[],
  categoryRows: any[],
  archiveRows: any[],
  siteUrl: string,
  permalinkPattern?: string | null,
  categoryPattern?: string | null,
): SidebarData {
  const recentPosts = recentPostRows.map((p) => ({
    title: p.title || '无标题',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      permalinkPattern,
    ),
  }));

  const recentComments = recentCommentRows.map((c) => ({
    author: c.author || '匿名',
    excerpt: (c.text || '').replace(/<[^>]+>/g, '').substring(0, 35) + (c.text && c.text.length > 35 ? '...' : ''),
    permalink: `${siteUrl.replace(/\/$/, '')}/archives/${c.cid}/#comment-${c.coid}`,
  }));

  const categories = categoryRows.map((c) => ({
    name: c.name || '',
    slug: c.slug || '',
    count: c.count || 0,
    permalink: buildCategoryLink(c.slug || '', siteUrl, categoryPattern),
  }));

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const archives = archiveRows.map((a) => ({
    date: `${monthNames[a.month - 1]} ${a.year}`,
    permalink: buildDateLink(a.year, a.month, undefined, siteUrl),
  }));

  return { recentPosts, recentComments, categories, archives };
}

function mapNavRows(rows: any[], siteUrl: string, pagePattern?: string | null): NavPage[] {
  return rows.map((p) => ({
    title: p.title || '无标题',
    slug: p.slug || '',
    permalink: buildPermalink(
      { cid: p.cid, slug: p.slug, type: p.type, created: p.created },
      siteUrl,
      undefined,
      pagePattern,
    ),
  }));
}

export async function loadSidebarData(
  ctx: HookContext,
  db: SidebarDatabase,
  siteUrl: string,
  permalinkPattern?: string | null,
  categoryPattern?: string | null,
  cacheVersion: string | number = 0,
): Promise<SidebarData> {
  const cacheKey = `${cacheVersion}\0${siteUrl}\0${permalinkPattern || ''}\0${categoryPattern || ''}`;
  const cached = sidebarSnapshot;
  if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
    return await applyFilterSafely(
      ctx,
      'widget:sidebar',
      cloneSidebarData(cached.data),
      db,
      siteUrl,
    );
  }

  const [recentPostRows, recentCommentRows, categoryRows, archiveRows] = await db.batch(sidebarQueries(db) as unknown as [any, ...any[]]);
  const sidebarData = mapSidebarRows(recentPostRows, recentCommentRows, categoryRows, archiveRows, siteUrl, permalinkPattern, categoryPattern);
  sidebarSnapshot = {
    key: cacheKey,
    expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS,
    data: sidebarData,
  };

  // Apply widget:sidebar filter — plugins can add/modify sidebar widgets
  return await applyFilterSafely(ctx, 'widget:sidebar', cloneSidebarData(sidebarData), db, siteUrl);
}

export async function loadNavPages(
  db: SidebarDatabase,
  siteUrl: string,
  pagePattern?: string | null,
  cacheVersion: string | number = 0,
): Promise<NavPage[]> {
  const cacheKey = `${cacheVersion}\0${siteUrl}\0${pagePattern || ''}`;
  const cached = navSnapshot;
  if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) {
    return cached.data.map(item => ({ ...item }));
  }

  const rows = await navQuery(db);
  const pages = mapNavRows(rows, siteUrl, pagePattern);
  navSnapshot = {
    key: cacheKey,
    expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS,
    data: pages,
  };
  return pages.map(item => ({ ...item }));
}

/**
 * 合并加载侧边栏与导航页：两个快照都命中时零查询；任一未命中时一次 db.batch
 * 完成 4 条侧边栏查询 + 1 条导航查询（此前 loadCommon 是两个独立往返）。
 */
export async function loadSidebarAndNav(
  ctx: HookContext,
  db: SidebarDatabase,
  siteUrl: string,
  permalinkPattern?: string | null,
  categoryPattern?: string | null,
  pagePattern?: string | null,
  cacheVersion: string | number = 0,
): Promise<{ sidebarData: SidebarData; pages: NavPage[] }> {
  const sidebarKey = `${cacheVersion}\0${siteUrl}\0${permalinkPattern || ''}\0${categoryPattern || ''}`;
  const navKey = `${cacheVersion}\0${siteUrl}\0${pagePattern || ''}`;
  const now = Date.now();
  const sCached = sidebarSnapshot && sidebarSnapshot.key === sidebarKey && sidebarSnapshot.expiresAt > now;
  const nCached = navSnapshot && navSnapshot.key === navKey && navSnapshot.expiresAt > now;
  if (sCached && nCached) {
    return {
      sidebarData: await applyFilterSafely(ctx, 'widget:sidebar', cloneSidebarData(sidebarSnapshot!.data), db, siteUrl),
      pages: navSnapshot!.data.map(item => ({ ...item })),
    };
  }

  const [recentPostRows, recentCommentRows, categoryRows, archiveRows, navRows] = await db.batch([
    ...sidebarQueries(db),
    navQuery(db),
  ] as unknown as [any, ...any[]]);
  const sidebarData = mapSidebarRows(recentPostRows, recentCommentRows, categoryRows, archiveRows, siteUrl, permalinkPattern, categoryPattern);
  const pages = mapNavRows(navRows, siteUrl, pagePattern);
  sidebarSnapshot = { key: sidebarKey, expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS, data: sidebarData };
  navSnapshot = { key: navKey, expiresAt: Date.now() + SIDEBAR_SNAPSHOT_TTL_MS, data: pages };
  return {
    sidebarData: await applyFilterSafely(ctx, 'widget:sidebar', cloneSidebarData(sidebarData), db, siteUrl),
    pages,
  };
}