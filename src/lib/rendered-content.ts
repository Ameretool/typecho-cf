import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import { renderContent, renderMarkdownFiltered, renderExcerptHtml, type RenderedContent } from '@/lib/markdown';
import { escapeHtml } from '@/lib/escape';
import type { RequestContext } from '@/lib/context';
import { setActivatedPlugins } from '@/lib/plugin';

/**
 * 预渲染缓存（typecho_contents_rendered 表 + isolate 内 LRU）。
 *
 * 该表是本项目自建的派生缓存表，**不修改任何 PHP Typecho 原生表结构**，
 * 因此原生数据迁移不受影响。缓存行格式：
 * - renderedHtml    详情页正文 HTML（走 content:markdown / content:content filter）
 * - renderedExcerpt 列表页摘要 HTML（纯渲染，不经插件 filter）
 * - sourceHash      ${contentHash}|${pluginIds}|${hasMore}` —— 详情页用它精确校验内容+插件是否变化；列表页只取 hasMore 段决定是否附加「阅读剩余部分」链接，有效性用 renderedAt >= modified 判断
 * - renderedAt      渲染完成时间（秒）
 *
 * 有效性规则：
 * - 详情页：sourceHash 与当前（内容+插件列表+hasMore）完全一致才命中
 * - 列表页：renderedAt >= contents.modified（摘要不依赖插件，无需比较插件段）
 */

// ─── hash 与 sourceHash 编解码 ───────────────────────────────────────────────

/**
 * 计算原文的简单 hash，用于判断文章内容是否变化。
 */
export function hashSource(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36) + ':' + text.length;
}

const SOURCE_HASH_SEP = '|';

function pluginListOf(ctx?: { activatedPlugins: Set<string> }): string {
  return ctx?.activatedPlugins ? [...ctx.activatedPlugins].sort().join(',') : '';
}

/**
 * 缓存 key：原文 hash + 激活插件列表 + 是否含 <!--more-->。
 * 详情页渲染受插件 filter 影响，所以插件启用/禁用/变更时旧缓存自动失效。
 */
function buildCacheHash(sourceText: string, ctx?: { activatedPlugins: Set<string> }): string {
  const hasMore = (sourceText || '').includes('<!--more-->') ? '1' : '0';
  return hashSource(sourceText || '') + SOURCE_HASH_SEP + pluginListOf(ctx) + SOURCE_HASH_SEP + hasMore;
}

/** 从存量 sourceHash 提取插件列表段（兼容旧的两段格式 contentHash|pluginIds）。 */
export function pluginPartOf(sourceHash: string | null | undefined): string {
  if (!sourceHash) return '';
  const parts = sourceHash.split(SOURCE_HASH_SEP);
  return parts.length >= 2 ? parts[1] : '';
}

/** 从存量 sourceHash 提取 <!--more--> 标记（旧数据无第三段 → 视为无标记）。 */
export function hasMoreOf(sourceHash: string | null | undefined): boolean {
  if (!sourceHash) return false;
  const parts = sourceHash.split(SOURCE_HASH_SEP);
  return parts.length >= 3 && parts[2] === '1';
}

// ─── 行类型与校验 ───────────────────────────────────────────────────────────

export interface RenderedRow {
  renderedHtml?: string | null;
  renderedExcerpt: string | null;
  sourceHash: string | null;
  renderedAt: number | null;
}

/** 详情页校验：hash（内容+插件+more 标记）一致且正文完整。 */
export function isRenderedFresh(rendered: RenderedRow, cacheHash: string): boolean {
  return !!rendered.renderedHtml && rendered.sourceHash === cacheHash;
}

/** 列表页校验：渲染时间不早于内容修改时间（摘要渲染不经插件 filter）。 */
export function isExcerptFresh(rendered: RenderedRow, modified: number | null | undefined): boolean {
  return typeof rendered.renderedAt === 'number'
    && rendered.renderedAt >= (modified || 0)
    && !!rendered.renderedExcerpt;
}

function excerptToPlain(excerptHtml: string): string {
  return excerptHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── isolate 内 LRU ──────────────────────────────────────────────────────────

interface LruEntry {
  sourceHash: string;
  renderedHtml: string;
  renderedExcerpt: string;
  renderedAt: number;
}

const RENDERED_LRU_MAX = 200;
const renderedLru = new Map<number, LruEntry>();

function lruGet(cid: number): LruEntry | undefined {
  const entry = renderedLru.get(cid);
  if (!entry) return undefined;
  // Refresh insertion order for LRU eviction.
  renderedLru.delete(cid);
  renderedLru.set(cid, entry);
  return entry;
}

function lruSet(cid: number, entry: LruEntry): void {
  renderedLru.delete(cid);
  renderedLru.set(cid, entry);
  if (renderedLru.size > RENDERED_LRU_MAX) {
    const oldest = renderedLru.keys().next().value;
    if (oldest !== undefined) renderedLru.delete(oldest);
  }
}

/** Test-only: clear the in-isolate rendered LRU. */
export function resetRenderedLru(): void {
  renderedLru.clear();
}

/** 内存中的 pending map：防止同一篇文章被并发重复渲染。 */
const pendingRenders = new Map<string, Promise<RenderedContent>>();
/**
 * 缓存命中时后台预热详情页预渲染。
 *
 * 匿名 GET 的文章页由边缘缓存命中时，中间件直接返回缓存响应，Astro 路由不会
 * 执行，懒预渲染回填（getRenderedContent 写表）不触发——这会导致缓存过期后
 * 的首个 miss 请求仍要承担完整渲染成本。此函数在缓存命中时把渲染移到
 * waitUntil 后台：查正文 → 渲染 → 写回预渲染表，下次 miss 直接命中表。
 *
 * 按 (cacheVersion, cid) 去重：同版本下每篇文章只预热一次；内容变更（版本戳
 * bump）后自动重新预热。
 */
const warmedContentKeys = new Set<string>();

/** Test-only: clear the cache-hit warm dedup set. */
export function resetWarmedContentKeys(): void {
  warmedContentKeys.clear();
}

export function warmRenderedOnCacheHit(
  db: Database,
  activatedIds: string[],
  cid: number,
  cacheVersion: string | number,
  waitUntil: (p: Promise<unknown>) => void,
): void {
  const key = `${cacheVersion}:${cid}`;
  if (warmedContentKeys.has(key)) return;
  warmedContentKeys.add(key);
  const task = (async () => {
    try {
      const pluginCtx = { activatedPlugins: new Set<string>() };
      if (activatedIds.length > 0) await setActivatedPlugins(pluginCtx, activatedIds);
      const row = await db.query.contents.findFirst({
        columns: { text: true },
        where: eq(schema.contents.cid, cid),
      });
      if (!row || row.text == null) return;
      await getRenderedContent(db, cid, row.text, { ctx: pluginCtx });
    } catch (err) {
      console.warn('[rendered-content] 缓存命中预热失败:', err);
    }
  })();
  waitUntil(task);
}

// ─── 详情页渲染 ──────────────────────────────────────────────────────────────

export interface GetRenderedOptions {
  /** Workers waitUntil，用于异步回填不阻塞响应 */
  waitUntil?: (p: Promise<unknown>) => void;
  /** 传入则执行 content:markdown / content:content 插件 filter */
  /** 传入则执行 content:markdown / content:content 插件 filter（仅使用 activatedPlugins） */
  ctx?: { activatedPlugins: Set<string> };
  /** 摘要最大长度，默认 200 */
  maxExcerptLength?: number;
  /** 调用方已在同一 D1 batch 中预加载的缓存行（避免二次查询） */
  preloaded?: RenderedRow | null;
}

/**
 * 获取文章渲染结果（懒渲染模式，兼容插件 filter）。
 *
 * 命中顺序：isolate LRU → 预渲染表 → 实时渲染（异步回填）。
 * 传入 preloaded 时跳过表查询，供调用方把该查询并入自己的 D1 batch。
 */
export async function getRenderedContent(
  db: Database,
  cid: number,
  sourceText: string,
  options: GetRenderedOptions = {},
): Promise<RenderedContent> {
  const { waitUntil, ctx, maxExcerptLength = 200, preloaded } = options;
  const cacheHash = buildCacheHash(sourceText, ctx);

  // 1. isolate 内 LRU
  const lru = lruGet(cid);
  if (lru && lru.renderedHtml && lru.sourceHash === cacheHash) {
    return { html: lru.renderedHtml, plainExcerpt: excerptToPlain(lru.renderedExcerpt) };
  }

  // 2. 预渲染表（preloaded 由调用方 batch 提供，否则自行查询）
  const cached = preloaded !== undefined
    ? preloaded
    : await db.query.contentsRendered.findFirst({
        where: eq(schema.contentsRendered.cid, cid),
      });

  if (cached && isRenderedFresh(cached, cacheHash)) {
    const plainExcerpt = excerptToPlain(cached.renderedExcerpt || '');
    lruSet(cid, {
      sourceHash: cacheHash,
      renderedHtml: cached.renderedHtml!,
      renderedExcerpt: cached.renderedExcerpt || '',
      renderedAt: cached.renderedAt ?? 0,
    });
    return { html: cached.renderedHtml!, plainExcerpt };
  }

  // 3. 并发去重
  const pendingKey = `${cid}:${cacheHash}`;
  const pending = pendingRenders.get(pendingKey);
  if (pending) return pending;

  // 4. 实时渲染
  const renderPromise = (async () => {
    // 正文：传入 ctx 则执行插件 filter，否则纯渲染
    const html = ctx
      ? await renderMarkdownFiltered(ctx, sourceText || '')
      : renderContent(sourceText || '', maxExcerptLength).html;

    // HTML 格式摘要（列表页用）
    const excerptHtml = renderExcerptHtml(sourceText || '');

    const plainExcerpt = excerptToPlain(excerptHtml);
    const renderedAt = Math.floor(Date.now() / 1000);

    // 5. 异步回填预渲染表（renderedExcerpt 始终存 HTML 摘要）
    const writeBack = db.insert(schema.contentsRendered)
      .values({
        cid,
        renderedHtml: html,
        renderedExcerpt: excerptHtml,
        sourceHash: cacheHash,
        renderedAt,
      })
      .onConflictDoUpdate({
        target: [schema.contentsRendered.cid],
        set: {
          renderedHtml: html,
          renderedExcerpt: excerptHtml,
          sourceHash: cacheHash,
          renderedAt,
        },
      })
      .catch(err => console.warn('[rendered-content] 写入预渲染表失败:', err))
      .finally(() => pendingRenders.delete(pendingKey));

    if (waitUntil) {
      waitUntil(writeBack);
    } else {
      // 没有 waitUntil 时同步等待，确保一定写入
      await writeBack;
    }

    lruSet(cid, { sourceHash: cacheHash, renderedHtml: html, renderedExcerpt: excerptHtml, renderedAt });
    return { html, plainExcerpt };
  })();

  pendingRenders.set(pendingKey, renderPromise);
  return renderPromise;
}

// ─── 列表页批量摘要 ──────────────────────────────────────────────────────────

export interface ExcerptRequest {
  cid: number;
  /** contents.modified（秒）——用于 renderedAt >= modified 有效性校验 */
  modified: number | null;
  /** 「阅读剩余部分」链接文案 */
  moreText: string;
  permalink: string;
}

function withMoreLink(excerptHtml: string, hasMore: boolean, moreText: string, permalink: string): string {
  return hasMore
    ? `${excerptHtml}<p class="more"><a href="${escapeHtml(permalink)}" title="${escapeHtml(moreText)}">${escapeHtml(moreText)}</a></p>`
    : excerptHtml;
}

/**
 * 列表页批量获取摘要（命中预渲染表/LRU 直接返回；未命中并发渲染并一次性写回）。
 *
 * 列表查询不再读取全文 text 大列：有效性用 contents.modified 与 renderedAt
 * 比较，摘要 HTML 直接从预渲染表取出。未命中的文章才按 cid 批量补查全文并渲染。
 *
 * @returns Map<cid, 展示用摘要 HTML（含 more 链接）>
 */
export async function getRenderedExcerpts(
  db: Database,
  items: ExcerptRequest[],
  options: GetRenderedOptions = {},
): Promise<Map<number, string>> {
  const { waitUntil, ctx } = options;
  const result = new Map<number, string>();
  if (items.length === 0) return result;

  // 1. isolate 内 LRU
  const misses: ExcerptRequest[] = [];
  for (const item of items) {
    const lru = lruGet(item.cid);
    if (lru && lru.renderedExcerpt && lru.renderedAt >= (item.modified || 0)) {
      result.set(item.cid, withMoreLink(lru.renderedExcerpt, hasMoreOf(lru.sourceHash), item.moreText, item.permalink));
    } else {
      misses.push(item);
    }
  }
  if (misses.length === 0) return result;

  // 2. 预渲染表批量读
  const rows = await db
    .select({
      cid: schema.contentsRendered.cid,
      renderedExcerpt: schema.contentsRendered.renderedExcerpt,
      sourceHash: schema.contentsRendered.sourceHash,
      renderedAt: schema.contentsRendered.renderedAt,
    })
    .from(schema.contentsRendered)
    .where(sql`${schema.contentsRendered.cid} IN (${sql.join(misses.map(m => sql`${m.cid}`), sql`,`)})`);
  const rowByCid = new Map(rows.map(r => [r.cid, r]));
  const toRender: ExcerptRequest[] = [];
  for (const item of misses) {
    const row = rowByCid.get(item.cid);
    if (row && isExcerptFresh(row, item.modified)) {
      result.set(item.cid, withMoreLink(row.renderedExcerpt || '', hasMoreOf(row.sourceHash), item.moreText, item.permalink));
      lruSet(item.cid, {
        sourceHash: row.sourceHash || '',
        renderedHtml: '',
        renderedExcerpt: row.renderedExcerpt || '',
        renderedAt: row.renderedAt ?? 0,
      });
    } else {
      toRender.push(item);
    }
  }
  if (toRender.length === 0) return result;

  // 3. 未命中：一次批量补查全文，然后并发渲染摘要
  const textRows = await db
    .select({ cid: schema.contents.cid, text: schema.contents.text })
    .from(schema.contents)
    .where(sql`${schema.contents.cid} IN (${sql.join(toRender.map(m => sql`${m.cid}`), sql`,`)})`);
  const textByCid = new Map(textRows.map(r => [r.cid, r.text || '']));

  const renderedAt = Math.floor(Date.now() / 1000);
  const pluginIds = pluginListOf(ctx);
  const rendered = await Promise.all(toRender.map(async (item) => {
    const text = textByCid.get(item.cid) ?? '';
    const excerptHtml = renderExcerptHtml(text);
    const sourceHash = buildCacheHash(text, ctx);
    return { item, text, excerptHtml, sourceHash };
  }));

  // 4. 一次性写回（不覆盖已有的 renderedHtml —— 只维护摘要与 hash）
  const statements = rendered.map(({ item, excerptHtml, sourceHash }) =>
    db.insert(schema.contentsRendered)
      .values({
        cid: item.cid,
        renderedExcerpt: excerptHtml,
        sourceHash,
        renderedAt,
      })
      .onConflictDoUpdate({
        target: [schema.contentsRendered.cid],
        set: {
          renderedExcerpt: excerptHtml,
          sourceHash,
          renderedAt,
        },
      }),
  );
  const writeBack = (async () => {
    if (statements.length === 0) return;
    const batchFn = (db as any).batch as ((stmts: any[]) => Promise<unknown>) | undefined;
    if (typeof batchFn === 'function') {
      await batchFn.call(db, statements as any);
    } else {
      await Promise.all(statements.map(s => s));
    }
  })().catch(err => console.warn('[rendered-content] 批量写入摘要失败:', err));
  if (waitUntil) waitUntil(writeBack); else await writeBack;

  for (const { item, text, excerptHtml, sourceHash } of rendered) {
    result.set(item.cid, withMoreLink(excerptHtml, text.includes('<!--more-->'), item.moreText, item.permalink));
    lruSet(item.cid, { sourceHash, renderedHtml: '', renderedExcerpt: excerptHtml, renderedAt });
  }
  return result;
}

/**
 * 文章删除时调用，删除对应的预渲染缓存并清理 isolate LRU。
 */
export async function invalidateRenderedContent(db: Database, cid: number): Promise<void> {
  renderedLru.delete(cid);
  await db.delete(schema.contentsRendered)
    .where(eq(schema.contentsRendered.cid, cid))
    .catch(() => {});
}

/**
 * 批量查询时计算 hash（包含插件列表与 more 标记），供 page-data.ts 使用。
 */
export function hashSourceWithPlugins(sourceText: string, ctx?: RequestContext): string {
  return buildCacheHash(sourceText, ctx);
}

// ─── 写时预热 ────────────────────────────────────────────────────────────────

/**
 * 发布/更新后调用：后台预渲染正文并回填预渲染表，再无 Cookie 自请求受影响
 * 的公开页面，把渲染成本从「首个访客」移到「写者请求」的 waitUntil 阶段。
 * 仅在提供 waitUntil（生产 waitUntil 上下文）时执行，避免测试/无上下文环境
 * 产生游离的后台任务。
 */
export function schedulePublicCacheWarm(
  db: Database,
  pluginCtx: { activatedPlugins: Set<string> },
  row: { cid: number; text: string | null },
  urls: string[],
  waitUntil?: (p: Promise<unknown>) => void,
): void {
  if (!waitUntil || urls.length === 0) return;
  const task = (async () => {
    // 1. 预渲染正文并回填预渲染表（与 getRenderedContent 同一渲染路径）
    try {
      const text = row.text || '';
      const html = await renderMarkdownFiltered(pluginCtx as any, text);
      const excerptHtml = renderExcerptHtml(text);
      const renderedAt = Math.floor(Date.now() / 1000);
      const sourceHash = buildCacheHash(text, pluginCtx);
      await db.insert(schema.contentsRendered)
        .values({ cid: row.cid, renderedHtml: html, renderedExcerpt: excerptHtml, sourceHash, renderedAt })
        .onConflictDoUpdate({
          target: [schema.contentsRendered.cid],
          set: { renderedHtml: html, renderedExcerpt: excerptHtml, sourceHash, renderedAt },
        });
      lruSet(row.cid, { sourceHash, renderedHtml: html, renderedExcerpt: excerptHtml, renderedAt });
    } catch (err) {
      console.warn('[rendered-content] 写时预热渲染失败:', err);
    }
    // 2. 预热公开页面（走中间件正常渲染路径，自动回填边缘缓存）
    await Promise.allSettled(urls.map(url =>
      fetch(url, { headers: { 'x-typecho-warm': '1' } }).catch(() => null),
    ));
  })();
  waitUntil(task);
}