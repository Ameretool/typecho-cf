import type { APIRoute } from 'astro';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import { getRequestCoreContextFromLocals, getClientIp } from '@/lib/context';
import { parseActivatedPlugins, setActivatedPlugins } from '@/lib/plugin';
import { saveIncomingFeedback } from '@/lib/incoming-feedback';
import { buildPermalink } from '@/lib/content';
import { env } from 'cloudflare:workers';
import { InputError, readBoundedText } from '@/lib/input';
import { REQUEST_BODY_LIMITS } from '@/lib/constants';

function xmlParams(xml: string): string[] {
  const pattern = /<param>\s*<value>(?:<string>)?([\s\S]*?)(?:<\/string>)?<\/value>\s*<\/param>/gi;
  return [...xml.matchAll(pattern)]
    .map(match => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

export const POST: APIRoute = async ({ request, locals }) => {
  const core = getRequestCoreContextFromLocals(locals);
  const db = core?.db ?? getDb(env.DB);
  const options = core?.options ?? await loadOptions(db);
  const pluginCtx = core?.pluginCtx ?? { activatedPlugins: new Set<string>() };
  if (!core) await setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));
  let xml: string;
  try { xml = await readBoundedText(request, REQUEST_BODY_LIMITS.publicForm); }
  catch (error) { return new Response(error instanceof Error ? error.message : 'invalid', { status: error instanceof InputError ? error.status : 400 }); }
  const [source, target] = xmlParams(xml);
  if (!source || !target) return new Response('invalid', { status: 400 });
  const rows = await db.select().from(schema.contents).where(and(inArray(schema.contents.type, ['post', 'page']), eq(schema.contents.status, 'publish'))).limit(1000);
  const content = rows.find(row => (row.type === 'post' || row.type === 'page') && row.status === 'publish' && buildPermalink(row, options.siteUrl || '', options.permalinkPattern as string | undefined, options.pagePattern as string | undefined) === target);
  if (!content) return new Response('target-not-found', { status: 404 });
  const result = await saveIncomingFeedback(db, pluginCtx, options, {
    cid: content.cid, author: source, url: source, text: `Pingback from ${source}`,
    type: 'pingback', ip: getClientIp(request), agent: request.headers.get('user-agent') || '',
  });
  if (result instanceof Response) return result;
  return new Response('<methodResponse><params><param><value><string>OK</string></value></param></params></methodResponse>', { headers: { 'content-type': 'text/xml; charset=utf-8' } });
};
