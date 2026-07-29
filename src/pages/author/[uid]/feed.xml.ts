import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import { generateRss2 } from '@/lib/feed';
import { clampFeedItems, buildFeedItem, xmlResponse } from '@/lib/feed-helpers';
import { eq, and, desc, lte } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const GET: APIRoute = async ({ params }) => {
  const uid = parseInt(params.uid || '0', 10);
  if (!uid) return new Response('Not Found', { status: 404 });

  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));

  const author = await db.query.users.findFirst({ where: eq(schema.users.uid, uid) });
  if (!author) return new Response('Not Found', { status: 404 });

  const limit = clampFeedItems(options.feedItems);
  const nowSec = Math.floor(Date.now() / 1000);

  const posts = await db
    .select()
    .from(schema.contents)
    .where(
      and(
        eq(schema.contents.authorId, uid),
        eq(schema.contents.type, 'post'),
        eq(schema.contents.status, 'publish'),
        eq(schema.contents.allowFeed, '1'),
        lte(schema.contents.created, nowSec),
      ),
    )
    .orderBy(desc(schema.contents.created))
    .limit(limit);

  const items = [];
  for (const p of posts) {
    items.push(
      await buildFeedItem(p, urls.siteUrl, options.permalinkPattern as string | undefined, undefined, pluginCtx, !!(options.feedFullText)),
    );
  }

  const displayName = author.screenName || author.name || `用户${uid}`;
  const config = { title: `${options.title} - 作者：${displayName}`, link: `${urls.siteUrl}/author/${uid}/`, description: '', feedUrl: urls.siteUrl, language: 'zh-CN', lastBuildDate: items[0]?.date || new Date() };
  return xmlResponse(generateRss2(config, items), 'application/rss+xml; charset=utf-8');
};
