import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import { generateRss2, generateAtom } from '@/lib/feed';
import { clampFeedItems, buildFeedItem, xmlResponse } from '@/lib/feed-helpers';
import { eq, and, desc, lte } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug || '';
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));

  const cat = await db.query.metas.findFirst({
    where: and(eq(schema.metas.type, 'category'), eq(schema.metas.slug, slug)),
  });
  if (!cat) return new Response('Not Found', { status: 404 });

  const limit = clampFeedItems(options.feedItems);
  const nowSec = Math.floor(Date.now() / 1000);

  const rows = await db
    .select({ contents: schema.contents })
    .from(schema.contents)
    .innerJoin(schema.relationships, eq(schema.contents.cid, schema.relationships.cid))
    .where(
      and(
        eq(schema.relationships.mid, cat.mid),
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        eq(schema.contents.allowFeed, '1'),
        lte(schema.contents.created, nowSec),
      ),
    )
    .orderBy(desc(schema.contents.created))
    .limit(limit);

  const items = [];
  for (const { contents: p } of rows) {
    items.push(
      await buildFeedItem(p, urls.siteUrl, options.permalinkPattern as string | undefined, undefined, pluginCtx, !!(options.feedFullText)),
    );
  }

  const isAtom = params.slug?.startsWith('atom-');
  const config = { title: `${options.title} - 分类：${cat.name}`, link: `${urls.siteUrl}/category/${slug}/`, description: '', feedUrl: urls.siteUrl, language: 'zh-CN', lastBuildDate: items[0]?.date || new Date() };
  const xml = isAtom ? generateAtom(config, items) : generateRss2(config, items);
  return xmlResponse(xml, isAtom ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8');
};
