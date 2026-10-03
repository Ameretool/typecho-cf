/**
 * Page data preparation layer
 *
 * Extracts DB queries from .astro page files into pure TypeScript functions.
 * Each function returns a standardized Props object for theme components.
 * This separation allows theme components to be purely presentational.
 */
import { eq, and, desc, asc, lt, gt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@/db';
import type { SiteOptions } from '@/lib/options';
import { loadSidebarAndNav, loadNavPages, type SidebarData } from '@/lib/sidebar';
import { buildFtsMatchExpression, contentsFtsTableRef, FTS_MIN_CHARS, isFtsAvailable } from '@/lib/fulltext';
import {
  buildPermalink, buildAuthorLink,
  buildCategoryLink, buildTagLink, buildSearchLink,
} from '@/lib/content';
import { renderCommentText } from '@/lib/markdown';
import { getRenderedContent, getRenderedExcerpts } from '@/lib/rendered-content';
import { paginate } from '@/lib/pagination';
import { generateCommentToken } from '@/lib/auth';
import { buildGravatarUrl } from '@/lib/gravatar';
import { loadCommentPage } from '@/lib/comment-page';
import type { RequestContext } from '@/lib/context';
import { canViewContent, publishedPostCondition, listPostCondition, type ContentViewer } from '@/lib/content-visibility';
import type {
  ThemeIndexProps, ThemePostProps, ThemePageProps, ThemeArchiveProps, ThemeNotFoundProps,
  PostListItem, CommentNode, CommentOptions,
} from '@/lib/theme-props';

// 导入 createHash 用于同步生成 Gravatar 头像（在 prepareAuthorData 中使用）
import { createHash } from 'node:crypto';

// ─── Local row types (derived from Drizzle schema) ───────────────────────
type ContentRow = typeof schema.contents.$inferSelect;
type CommentRow = typeof schema.comments.$inferSelect;
type MetaRow = typeof schema.metas.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
type CategoryEntry = { name: string; slug: string; permalink: string };
type CategoryMap = Map<number, CategoryEntry[]>;

// 已修改：AuthorEntry 包含 avatarUrl
type AuthorEntry = { uid: number; name: string | null; screenName: string | null; avatarUrl: string };
type AuthorMap = Map<number, AuthorEntry>;

type ListContentRow = {
  cid: number;
  title: string | null;
  slug: string | null;
  type: string | null;
  created: number | null;
  modified: number | null;
  commentsNum: number | null;
  authorId: number | null;
  status: string | null;
};

/** 列表查询只取必要列（不含 text 大列），摘要走预渲染表。 */
const LIST_SELECT_FIELDS = {
  cid: schema.contents.cid,
  title: schema.contents.title,
  slug: schema.contents.slug,
  type: schema.contents.type,
  created: schema.contents.created,
  modified: schema.contents.modified,
  commentsNum: schema.contents.commentsNum,
  authorId: schema.contents.authorId,
  status: schema.contents.status,
} as const;

const EMPTY_SIDEBAR: SidebarData = {
  recentPosts: [],
  recentComments: [],
  categories: [],
  archives: [],
};

// ─── Helpers ────────────────────────────────────────────────────────────

async function loadCommon(ctx: RequestContext, requestUrl: string, withSidebar = true) {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const loaded = withSidebar
    ? await loadSidebarAndNav(
        ctx,
        db,
        urls.siteUrl,
        options.permalinkPattern as string | undefined,
        options.categoryPattern as string | undefined,
        options.pagePattern as string | undefined,
        options.cacheVersion,
      )
    : {
        sidebarData: EMPTY_SIDEBAR,
        pages: await loadNavPages(db, urls.siteUrl, options.pagePattern as string | undefined, options.cacheVersion),
      };
  const { sidebarData, pages } = loaded;
  const currentPath = new URL(requestUrl).pathname;
  return { options, urls, user, isLoggedIn, pages, sidebarData, currentPath, pluginCtx: ctx };
}

function getPage(locals: Record<string, unknown>, url: URL): number {
  const raw = (locals as { _page?: number })._page ?? url.searchParams.get('page');
  return raw ? (typeof raw === 'number' ? raw : parseInt(raw, 10) || 1) : 1;
}

function buildCommentTree(allComments: CommentRow[], options: SiteOptions): CommentNode[] {
  const map = new Map<number, CommentNode>();
  const roots: CommentNode[] = [];
  for (const c of allComments) {
    map.set(c.coid, {
      coid: c.coid,
      author: c.author || '匿名',
      mail: c.mail || '',
      url: c.url || '',
      text: renderCommentText(c.text || '', {
        markdown: !!options.commentsMarkdown,
        htmlTagAllowed: options.commentsHTMLTagAllowed,
      }),
      created: c.created || 0,
      children: [],
    });
  }
  if (!options.commentsThreaded) {
    return allComments.map(comment => map.get(comment.coid)!);
  }
  for (const c of allComments) {
    const node = map.get(c.coid)!;
    if (c.parent && map.has(c.parent)) {
      map.get(c.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function buildGravatarMap(allComments: CommentRow[], avatarRating: string): Promise<Record<number, string>> {
  const urlsByEmail = new Map<string, Promise<string>>();
  const entries = await Promise.all(
    allComments.map(async (c) => {
      const email = (c.mail || '').trim().toLowerCase();
      let pending = urlsByEmail.get(email);
      if (!pending) {
        pending = buildGravatarUrl(email, {
          defaultImage: 'identicon',
          size: 96,
          rating: avatarRating,
        });
        urlsByEmail.set(email, pending);
      }
      return [c.coid, await pending] as const;
    })
  );
  return Object.fromEntries(entries);
}

function buildCommentOptions(options: SiteOptions, securityToken: string): CommentOptions {
  return {
    allowComment: true,
    requireMail: !!options.commentsRequireMail,
    showUrl: !!options.commentsShowUrl,
    showAvatar: !!options.commentsAvatar,
    avatarRating: options.commentsAvatarRating || 'G',
    order: options.commentsOrder === 'DESC' ? 'DESC' : 'ASC',
    dateFormat: options.commentDateFormat || 'Y-m-d H:i',
    timezone: options.timezone || 28800,
    securityToken,
    showCommentOnly: !!options.commentsShowCommentOnly,
    markdown: !!options.commentsMarkdown,
    urlNofollow: !!options.commentsUrlNofollow,
    threaded: !!options.commentsThreaded,
    maxNestingLevels: Number(options.commentsMaxNestingLevels) || 2,
    pageBreak: !!options.commentsPageBreak,
    pageSize: Number(options.commentsPageSize) || 20,
    pageDisplay: (options.commentsPageDisplay === 'first' ? 'first' : 'last') as 'first' | 'last',
    htmlTagAllowed: options.commentsHTMLTagAllowed || '',
  };
}

/**
 * 由用户行构建 AuthorMap：有邮箱则生成真实头像 URL（Gravatar/Libravatar），
 * 没有邮箱时回退到默认头像。
 */
async function buildAuthorMap(
  authors: Array<{ uid: number; name: string | null; screenName: string | null; mail: string | null }>,
  defaultAvatar: string,
): Promise<AuthorMap> {
  const entries = await Promise.all(
    authors.map(async (a) => {
      const avatarUrl = a.mail
        ? await buildGravatarUrl(a.mail, { defaultImage: 'identicon', size: 96, rating: 'G' })
        : defaultAvatar;
      return [a.uid, { uid: a.uid, name: a.name, screenName: a.screenName, avatarUrl }] as const;
    })
  );
  return new Map(entries);
}

function mapPostCategories(
  rows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }>,
  siteUrl: string,
  categoryPattern?: string | null,
): CategoryMap {
  const map: CategoryMap = new Map();
  for (const row of rows) {
    if (!map.has(row.cid)) map.set(row.cid, []);
    map.get(row.cid)!.push({
      name: row.name || '',
      slug: row.slug || '',
      permalink: buildCategoryLink(row.slug || '', siteUrl, categoryPattern),
    });
  }
  return map;
}

/**
 * 批量查询文章的预渲染摘要。
 * 命中缓存的文章可以直接用，避免每篇都执行 Markdown 渲染。
 */
function toPostListItem(
  post: ListContentRow,
  authorMap: AuthorMap,
  categoryMap: CategoryMap,
  siteUrl: string,
  permalinkPattern: string | null | undefined,
  excerptMap: Map<number, string>,
): PostListItem {
  const author = authorMap.get(post.authorId || 0);
  const categories = categoryMap.get(post.cid) || [];
  const permalink = buildPermalink(
    { cid: post.cid, slug: post.slug, type: post.type, created: post.created, category: categories[0]?.slug },
    siteUrl,
    permalinkPattern,
  );
  // 摘要由 getRenderedExcerpts 统一准备（预渲染表/LRU 命中或实时渲染回填）
  const excerpt = excerptMap.get(post.cid) ?? '';
  return {
    cid: post.cid,
    title: post.title || '无标题',
    permalink,
    excerpt,
    created: post.created || 0,
    commentsNum: post.commentsNum || 0,
    status: post.status || '',
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '', avatarUrl: author.avatarUrl } : null,
    categories,
  };
}

// ─── Shared archive query ───────────────────────────────────────────────

interface ArchiveParams {
  archiveTitle: string;
  archiveType: 'index' | 'category' | 'tag' | 'author' | 'search';
  baseUrl: string;
  extraWhere?: ReturnType<typeof sql>;
  joinMid?: number;
  authorOverride?: AuthorMap;
  ftsMatch?: string | null;
  countKey?: string;
}

const ARCHIVE_COUNT_CACHE_TTL_MS = 60_000;
const ARCHIVE_COUNT_CACHE_MAX = 200;
const archiveCountCache = new Map<string, { count: number; expiresAt: number }>();

export function resetArchiveCountCache(): void {
  archiveCountCache.clear();
}

function readCachedArchiveCount(key: string): number | undefined {
  const entry = archiveCountCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    archiveCountCache.delete(key);
    return undefined;
  }
  return entry.count;
}

function writeCachedArchiveCount(key: string, count: number): void {
  archiveCountCache.set(key, { count, expiresAt: Date.now() + ARCHIVE_COUNT_CACHE_TTL_MS });
  if (archiveCountCache.size > ARCHIVE_COUNT_CACHE_MAX) {
    const now = Date.now();
    for (const [cacheKey, entry] of archiveCountCache) {
      if (entry.expiresAt <= now) archiveCountCache.delete(cacheKey);
    }
  }
}

async function prepareArchiveData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  params: ArchiveParams,
): Promise<ThemeArchiveProps> {
  const { db, options, urls, user, isLoggedIn } = ctx;

  // 构造 viewer
  const viewer: ContentViewer = {
    uid: user?.uid ?? null,
    isLoggedIn: !!user,
  };

  // 定义默认头像（可从 options 读取，否则使用 Gravatar 默认标识）
  const defaultAvatar = (options as any).defaultAvatar || '/img/avatar.svg';

  const commonPromise = loadCommon(ctx, requestUrl);
  const page = getPage(locals, url);
  const pageSize = options.pageSize || 5;

  const baseConditions = [
    listPostCondition(viewer),
  ];
  if (params.extraWhere) baseConditions.push(params.extraWhere);
  if (params.ftsMatch) {
    baseConditions.push(sql`${contentsFtsTableRef} MATCH ${params.ftsMatch}`);
  }

  const hasJoin = params.joinMid !== undefined;
  const hasFts = !!params.ftsMatch;
  const countWhere = hasJoin
    ? and(eq(schema.relationships.mid, params.joinMid!), ...baseConditions)
    : and(...baseConditions);

  const applyJoins = (q: any): any => {
    let joined = q;
    if (hasJoin) {
      joined = joined.innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid));
    }
    if (hasFts) {
      joined = joined.innerJoin(
        contentsFtsTableRef,
        sql`${contentsFtsTableRef}.rowid = ${schema.contents.cid}`,
      );
    }
    return joined;
  };

  const makeListStatement = (cursor: { created: number; cid: number } | null) => {
    const q = applyJoins(
      (hasJoin || hasFts)
        ? db.select({ content: { ...LIST_SELECT_FIELDS } }).from(schema.contents)
        : db.select({ ...LIST_SELECT_FIELDS }).from(schema.contents),
    );
    const where = cursor
      ? and(
          countWhere,
          or(
            lt(schema.contents.created, cursor.created),
            and(eq(schema.contents.created, cursor.created), lt(schema.contents.cid, cursor.cid)),
          ),
        )
      : countWhere;
    return q
      .where(where)
      .orderBy(desc(schema.contents.created), desc(schema.contents.cid))
      .limit(pageSize);
  };

  const makeBoundaryStatement = (offset: number) =>
    applyJoins(db.select({ created: schema.contents.created, cid: schema.contents.cid }).from(schema.contents))
      .where(countWhere)
      .orderBy(desc(schema.contents.created), desc(schema.contents.cid))
      .limit(1)
      .offset(offset);

  const requestedPage = Math.max(1, page);

  const countCacheKey = `${options.cacheVersion}\0${params.archiveType}\0${params.countKey || params.baseUrl}\0${params.joinMid ?? ''}\0${params.ftsMatch || ''}`;
  const cachedCount = readCachedArchiveCount(countCacheKey);
  const countStatement = cachedCount === undefined
    ? applyJoins(
        db.select({ count: sql<number>`count(*)` }).from(schema.contents),
      ).where(countWhere)
    : null;

  const listOrBoundary = requestedPage === 1
    ? makeListStatement(null)
    : makeBoundaryStatement((requestedPage - 1) * pageSize - 1);

  const [common, batchResult] = await Promise.all([
    commonPromise,
    countStatement
      ? db.batch([countStatement, listOrBoundary])
      : db.batch([listOrBoundary]),
  ]);

  let totalPosts: number;
  let initialPosts: unknown;
  if (countStatement) {
    const [countResult, posts] = batchResult as [Array<{ count: number }>, unknown];
    totalPosts = Number(countResult?.[0]?.count ?? 0);
    writeCachedArchiveCount(countCacheKey, totalPosts);
    initialPosts = posts;
  } else {
    totalPosts = cachedCount!;
    initialPosts = batchResult[0];
  }

  const pg = paginate(totalPosts, page, pageSize, params.baseUrl);
  const currentPage = pg.currentPage;

  let posts: ContentRow[] | Array<{ content: ContentRow }>;
  if (requestedPage === 1) {
    posts = initialPosts as ContentRow[] | Array<{ content: ContentRow }>;
  } else if (currentPage === requestedPage) {
    const boundary = (initialPosts as Array<{ created: number | null; cid: number | null }>)[0];
    posts = boundary
      ? await makeListStatement({ created: boundary.created ?? 0, cid: boundary.cid ?? 0 })
      : [];
  } else {
    const [boundaryRows] = await db.batch([
      makeBoundaryStatement((currentPage - 1) * pageSize - 1),
    ]);
    const boundary = boundaryRows[0];
    posts = boundary
      ? await makeListStatement({ created: boundary.created ?? 0, cid: boundary.cid ?? 0 })
      : [];
  }

  const rawPosts: ListContentRow[] = (hasJoin || hasFts)
    ? (posts as { content: ListContentRow }[]).map(p => p.content)
    : (posts as ListContentRow[]);

  const authorIds = [...new Set(rawPosts.map(p => p.authorId).filter((id): id is number => Boolean(id)))];
  const postIds = rawPosts.map(p => p.cid).filter((id): id is number => id !== null);

  let authorMap = params.authorOverride;
  let categoryRows: Array<{ cid: number; mid: number; name: string | null; slug: string | null }> = [];

  if (postIds.length > 0) {
    const categoryStatement = db
      .select({
        cid: schema.relationships.cid,
        mid: schema.relationships.mid,
        name: schema.metas.name,
        slug: schema.metas.slug,
      })
      .from(schema.relationships)
      .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
      .where(
        and(
          sql`${schema.relationships.cid} IN (${sql.join(postIds.map(id => sql`${id}`), sql`, `)})`,
          eq(schema.metas.type, 'category')
        )
      );

    if (authorMap || authorIds.length === 0) {
      categoryRows = await categoryStatement;
    } else {
      const [authors, categories] = await db.batch([
        db
          .select({
            uid: schema.users.uid,
            name: schema.users.name,
            screenName: schema.users.screenName,
            mail: schema.users.mail,
          })
          .from(schema.users)
          .where(sql`${schema.users.uid} IN (${sql.join(authorIds.map(id => sql`${id}`), sql`, `)})`),
        categoryStatement,
      ]);
      authorMap = await buildAuthorMap(authors, defaultAvatar);
      categoryRows = categories;
    }
  }
  authorMap ??= new Map();

  const categoryMap = mapPostCategories(
    categoryRows,
    urls.siteUrl,
    options.categoryPattern as string | undefined,
  );

  const cfContext = (locals as { cfContext?: { waitUntil?: (p: Promise<unknown>) => void } }).cfContext;
  const waitUntil = cfContext?.waitUntil ? (p: Promise<unknown>) => cfContext!.waitUntil!(p) : undefined;

  const excerptMap = await getRenderedExcerpts(
    db,
    rawPosts.map(p => ({
      cid: p.cid,
      modified: p.modified,
      moreText: '- 阅读剩余部分 -',
      permalink: buildPermalink(
        { cid: p.cid, slug: p.slug, type: p.type, created: p.created, category: (categoryMap.get(p.cid) || [])[0]?.slug },
        urls.siteUrl,
        options.permalinkPattern as string | undefined,
      ),
    })),
    { ctx, waitUntil },
  );

  return {
    ...common,
    archiveTitle: params.archiveTitle,
    archiveType: params.archiveType,
    posts: rawPosts.map(p =>
      toPostListItem(p, authorMap, categoryMap, urls.siteUrl, options.permalinkPattern as string | undefined, excerptMap)
    ),
    pagination: pg,
  };
}

// ─── Index (home page) ──────────────────────────────────────────────────

export async function prepareIndexData(
  ctx: RequestContext,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeIndexProps> {
  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: '',
    archiveType: 'index',
    baseUrl: ctx.urls.siteUrl + '/',
  });
}

// ─── Post detail ────────────────────────────────────────────────────────

export interface PreparePostResult {
  props: ThemePostProps;
  redirect?: never;
}

export async function preparePostData(
  ctx: RequestContext,
  cidNum: number,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  executionContext?: { waitUntil?: (p: Promise<unknown>) => void } | null,
): Promise<ThemePostProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const waitUntil = executionContext?.waitUntil ? (p: Promise<unknown>) => executionContext!.waitUntil!(p) : undefined;

  const contentRow = preloadedRow ?? await db.query.contents.findFirst({
    where: eq(schema.contents.cid, cidNum),
  });
  if (!contentRow) return new Response('Not Found', { status: 404 });
  if (!canViewContent(contentRow, { isLoggedIn, uid: user?.uid })) {
    return new Response('Not Found', { status: 404 });
  }

  const hasPassword = !!contentRow.password;
  const passwordVerified = hasPassword && suppliedPassword === contentRow.password;

  const [
    common,
    [
      authorRows,
      relatedMetas,
      prevPostRows,
      nextPostRows,
      renderedRows,
    ],
    commentPage,
  ] = await Promise.all([
    loadCommon(ctx, requestUrl),
    db.batch([
      db
        .select({
          uid: schema.users.uid,
          name: schema.users.name,
          screenName: schema.users.screenName,
          mail: schema.users.mail,
        })
        .from(schema.users)
        .where(eq(schema.users.uid, contentRow.authorId || 0))
        .limit(1),
      db
        .select({ name: schema.metas.name, slug: schema.metas.slug, type: schema.metas.type })
        .from(schema.relationships)
        .innerJoin(schema.metas, eq(schema.relationships.mid, schema.metas.mid))
        .where(eq(schema.relationships.cid, cidNum)),
      db
        .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
        .from(schema.contents)
        .where(and(publishedPostCondition(), lt(schema.contents.created, contentRow.created || 0)))
        .orderBy(desc(schema.contents.created))
        .limit(1),
      db
        .select({ cid: schema.contents.cid, title: schema.contents.title, slug: schema.contents.slug, type: schema.contents.type, created: schema.contents.created })
        .from(schema.contents)
        .where(and(publishedPostCondition(), gt(schema.contents.created, contentRow.created || 0)))
        .orderBy(asc(schema.contents.created))
        .limit(1),
      db
        .select({
          renderedHtml: schema.contentsRendered.renderedHtml,
          renderedExcerpt: schema.contentsRendered.renderedExcerpt,
          sourceHash: schema.contentsRendered.sourceHash,
          renderedAt: schema.contentsRendered.renderedAt,
        })
        .from(schema.contentsRendered)
        .where(eq(schema.contentsRendered.cid, cidNum))
        .limit(1),
    ]),
    loadCommentPage(db, cidNum, options, requestUrl, contentRow.commentsNum ?? null, options.cacheVersion),
  ]);

  const author = authorRows[0] ?? null;

  // 生成 author 的头像 URL（如果有 mail）
  const defaultAvatar = (options as any).defaultAvatar || '/img/avatar.svg';
  let authorAvatar = defaultAvatar;
  if (author?.mail) {
    const hash = createHash('md5').update(author.mail.trim().toLowerCase()).digest('hex');
    authorAvatar = `https://www.gravatar.com/avatar/${hash}?s=48&d=identicon`;
  }

  const allComments = commentPage.rows;
  type MetaEntry = { name: string | null; slug: string | null; type: string | null };
  const categories = (relatedMetas as MetaEntry[]).filter(m => m.type === 'category').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildCategoryLink(m.slug || '', urls.siteUrl, options.categoryPattern as string | undefined),
  }));
  const tags = (relatedMetas as MetaEntry[]).filter(m => m.type === 'tag').map(m => ({
    name: m.name || '',
    slug: m.slug || '',
    permalink: buildTagLink(m.slug || '', urls.siteUrl),
  }));

  const commentTree = buildCommentTree(allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};

  const permalink = buildPermalink(
    { cid: contentRow.cid, slug: contentRow.slug, type: contentRow.type, created: contentRow.created, category: categories[0]?.slug },
    urls.siteUrl,
    options.permalinkPattern as string | undefined,
  );

  const allowComment = contentRow.allowComment === '1';

  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : (await getRenderedContent(db, contentRow.cid, contentRow.text || '', { ctx, preloaded: renderedRows[0] ?? null, waitUntil })).html;

  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, contentRow.cid)
    : '';

  return {
    ...common,
    post: {
      cid: contentRow.cid,
      title: contentRow.title || '无标题',
      permalink,
      content: renderedContent,
      created: contentRow.created || 0,
      modified: contentRow.modified,
      commentsNum: contentRow.commentsNum || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    // author 带上 avatarUrl
    author: author ? { uid: author.uid, name: author.name || '', screenName: author.screenName || author.name || '', avatarUrl: authorAvatar } : null,
    categories,
    tags,
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    prevPost: prevPostRows[0] ? {
      title: prevPostRows[0].title || '无标题',
      permalink: buildPermalink(prevPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    nextPost: nextPostRows[0] ? {
      title: nextPostRows[0].title || '无标题',
      permalink: buildPermalink(nextPostRows[0], urls.siteUrl, options.permalinkPattern as string | undefined),
    } : null,
    gravatarMap,
  };
}

// ─── Independent page ───────────────────────────────────────────────────

export async function preparePageData(
  ctx: RequestContext,
  cleanSlug: string,
  requestUrl: string,
  suppliedPassword: string | null,
  preloadedRow?: ContentRow | null,
  executionContext?: { waitUntil?: (p: Promise<unknown>) => void } | null,
): Promise<ThemePageProps | Response> {
  const { db, options, urls, user, isLoggedIn } = ctx;
  const waitUntil = executionContext?.waitUntil ? (p: Promise<unknown>) => executionContext!.waitUntil!(p) : undefined;

  const pageRow = preloadedRow ?? await db.query.contents.findFirst({
    where: and(eq(schema.contents.slug, cleanSlug), eq(schema.contents.type, 'page')),
  });
  if (!pageRow) return new Response('Not Found', { status: 404 });
  if (!canViewContent(pageRow, { isLoggedIn, uid: user?.uid })) {
    return new Response('Not Found', { status: 404 });
  }

  const permalink = buildPermalink(
    { cid: pageRow.cid, slug: pageRow.slug, type: pageRow.type, created: pageRow.created },
    urls.siteUrl,
    undefined,
    options.pagePattern as string | undefined,
  );

  const hasPassword = !!pageRow.password;
  const passwordVerified = hasPassword && suppliedPassword === pageRow.password;

  const [commentPage, common] = await Promise.all([
    loadCommentPage(db, pageRow.cid, options, requestUrl, pageRow.commentsNum ?? null, options.cacheVersion),
    loadCommon(ctx, requestUrl),
  ]);

  const allComments = commentPage.rows;
  const commentTree = buildCommentTree(allComments, options);
  const gravatarMap = options.commentsAvatar
    ? await buildGravatarMap(allComments, options.commentsAvatarRating || 'G')
    : {};

  const allowComment = pageRow.allowComment === '1';

  const renderedContent = hasPassword && !passwordVerified
    ? '<p>此内容已加密，请输入密码访问。</p>'
    : (await getRenderedContent(db, pageRow.cid, pageRow.text || '', { ctx, waitUntil })).html;

  const securityToken = options.commentsAntiSpam
    ? await generateCommentToken(options.secret as string, pageRow.cid)
    : '';

  return {
    ...common,
    page: {
      cid: pageRow.cid,
      title: pageRow.title || '无标题',
      slug: cleanSlug,
      permalink,
      content: renderedContent,
      created: pageRow.created || 0,
      allowComment,
      hasPassword,
      passwordVerified,
    },
    comments: commentTree,
    commentPagination: commentPage.pagination,
    commentOptions: { ...buildCommentOptions(options, securityToken), allowComment },
    gravatarMap,
  };
}

// ─── Archive (category / tag / author / search) ─────────────────────────

export async function prepareCategoryData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedCategory?: MetaRow | null,
): Promise<ThemeArchiveProps | Response> {
  const category = preloadedCategory === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'category')),
      })
    : preloadedCategory;
  if (!category) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `分类 ${category.name} 下的文章`,
    archiveType: 'category',
    baseUrl: buildCategoryLink(slug, ctx.urls.siteUrl, ctx.options.categoryPattern as string | undefined),
    joinMid: category.mid,
  });
}

export async function prepareTagData(
  ctx: RequestContext,
  slug: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedTag?: MetaRow | null,
): Promise<ThemeArchiveProps | Response> {
  const tag = preloadedTag === undefined
    ? await ctx.db.query.metas.findFirst({
        where: and(eq(schema.metas.slug, slug), eq(schema.metas.type, 'tag')),
      })
    : preloadedTag;
  if (!tag) return new Response('Not Found', { status: 404 });

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `标签 ${tag.name} 下的文章`,
    archiveType: 'tag',
    baseUrl: buildTagLink(slug, ctx.urls.siteUrl),
    joinMid: tag.mid,
  });
}

export async function prepareAuthorData(
  ctx: RequestContext,
  uidNum: number,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
  preloadedAuthor?: UserRow | null,
): Promise<ThemeArchiveProps | Response> {
  const author = preloadedAuthor === undefined
    ? await ctx.db.query.users.findFirst({ where: eq(schema.users.uid, uidNum) })
    : preloadedAuthor;
  if (!author) return new Response('Not Found', { status: 404 });

  // 生成作者的头像 URL
  const defaultAvatar = (ctx.options as any).defaultAvatar || '/img/avatar.png';
  let avatarUrl = defaultAvatar;
  if (author.mail) {
    const hash = createHash('md5').update(author.mail.trim().toLowerCase()).digest('hex');
    avatarUrl = `https://www.gravatar.com/avatar/${hash}?s=48&d=identicon`;
  }

  // 构造包含 avatarUrl 的 AuthorMap
  const authorMap: AuthorMap = new Map([[
    author.uid,
    { uid: author.uid, name: author.name, screenName: author.screenName, avatarUrl }
  ]]);

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `${author.screenName || author.name} 发布的文章`,
    archiveType: 'author',
    baseUrl: buildAuthorLink(uidNum, ctx.urls.siteUrl),
    extraWhere: eq(schema.contents.authorId, uidNum),
    authorOverride: authorMap,
  });
}

export async function prepareSearchData(
  ctx: RequestContext,
  keywords: string,
  requestUrl: string,
  locals: Record<string, unknown>,
  url: URL,
): Promise<ThemeArchiveProps> {
  const trimmed = keywords.trim().slice(0, 50);
  const isUsefulKeyword = trimmed.length >= 2;
  const terms = trimmed.split(/\s+/).filter(Boolean);
  const useFts = isUsefulKeyword
    && terms.length > 0
    && terms.every((term) => term.length >= FTS_MIN_CHARS)
    && isFtsAvailable();

  return prepareArchiveData(ctx, requestUrl, locals, url, {
    archiveTitle: `包含关键字 ${trimmed} 的文章`,
    archiveType: 'search',
    baseUrl: buildSearchLink(trimmed, ctx.urls.siteUrl),
    extraWhere: !isUsefulKeyword
      ? sql`1 = 0`
      : useFts
        ? undefined
        : sql`(${schema.contents.title} LIKE ${`%${trimmed}%`} OR ${schema.contents.text} LIKE ${`%${trimmed}%`})`,
    ftsMatch: useFts ? buildFtsMatchExpression(trimmed) : null,
  });
}

// ─── 404 Not Found ──────────────────────────────────────────────────────

export async function prepareNotFoundData(
  ctx: RequestContext,
  requestUrl: string,
): Promise<ThemeNotFoundProps> {
  const common = await loadCommon(ctx, requestUrl, false);
  return {
    ...common,
    statusCode: 404,
    errorTitle: '404 - 页面没找到',
  };
}