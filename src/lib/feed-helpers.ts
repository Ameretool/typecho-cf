/**
 * Shared utilities for feed generation — used by the main feed route and
 * sub-channel feeds (category / tag / author).
 */

import type { FeedItem } from '@/lib/feed';
import { buildPermalink } from '@/lib/content';
import { generateRss2, generateAtom, generateRss1 } from '@/lib/feed';
import { renderMarkdown, generateExcerpt } from '@/lib/markdown';
import { applyFilterSafely, type HookContext } from '@/lib/plugin';
import { getDb } from '@/db';

export const FEED_ITEMS_DEFAULT = 10;
export const FEED_ITEMS_MIN = 5;
export const FEED_ITEMS_MAX = 50;

export function clampFeedItems(rawValue: unknown): number {
  const n = parseInt(String(rawValue ?? FEED_ITEMS_DEFAULT), 10) || FEED_ITEMS_DEFAULT;
  return Math.min(FEED_ITEMS_MAX, Math.max(FEED_ITEMS_MIN, n));
}

export async function buildFeedItem(
  post: { cid: number; slug: string | null; type: string; created: number; title: string | null; text?: string | null },
  siteUrl: string,
  permalinkPattern: string | undefined,
  pagePattern: string | undefined,
  pluginCtx: HookContext,
  feedFullText?: boolean,
): Promise<FeedItem> {
  const excerpt = generateExcerpt(post.text || '');
  const fullContent = feedFullText ? renderMarkdown(post.text || '') : '';
  const link = buildPermalink(post, siteUrl, permalinkPattern, pagePattern);

  let item: FeedItem = {
    title: post.title || '无标题',
    link,
    content: fullContent,
    excerpt,
    date: new Date((post.created || 0) * 1000),
  };

  item = await applyFilterSafely(pluginCtx, 'feed:item', item);
  return item;
}

export function xmlResponse(xml: string, contentType: string): Response {
  return new Response(xml, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, s-maxage=1800',
    },
  });
}
