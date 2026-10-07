import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { applyFilter, type HookContext } from '@/lib/plugin';
import { escapeHtml as escapeHtmlShared } from '@/lib/escape';

// ─── HTML 转义辅助函数 ─────────────────────────────────────────────────────

/** @deprecated 请直接从 '@/lib/escape' 导入。 */
export function escapeHtml(str: string): string {
  return escapeHtmlShared(str);
}

// ─── 共享的 HTML 清理配置 ──────────────────────────────────────────────────

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'del', 'ins', 'details', 'summary', 'figure', 'figcaption',
    'video', 'audio', 'source', 'iframe', 'div', 'center',
  ]),
  allowedAttributes: {
    // 允许所有标签拥有 class, id, style
    '*': ['class', 'id', 'style'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    a: ['href', 'title', 'target', 'rel'],
    code: ['class'],
    pre: ['class'],
    td: ['align', 'valign'],
    th: ['align', 'valign'],
    iframe: ['src', 'width', 'height', 'frameborder', 'allowfullscreen'],
    video: ['src', 'controls', 'width', 'height', 'playsinline', 'muted', 'preload', 'class', 'style'],
    audio: ['src', 'controls'],
    source: ['src', 'type'],
    div: ['class', 'id', 'style' , 'align'],
  },
  allowedIframeHostnames: ['www.youtube.com', 'player.bilibili.com', 'player.vimeo.com'],
};

const COMMENT_MARKDOWN_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'pre', 'code']),
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    pre: ['class'],
  },
};

export interface CommentRenderOptions {
  markdown?: boolean;
  htmlTagAllowed?: string | null;
}

/**
 * 用于在 Markdown 渲染和清理过程中保留的唯一占位符。
 * Marked 会将独立的纯文本行包裹在 <p>…</p> 中，因此渲染后，
 * 占位符会显示为 <p>TYPECHO_MORE_0</p>，我们可以据此可靠地对其进行拆分。
 */
const MORE_PLACEHOLDER = 'TYPECHO_MORE_0';
const MORE_PLACEHOLDER_RE = /<p>\s*TYPECHO_MORE_0\s*<\/p>/;
const MORE_COMMENT_RE = /<!--more-->/g;
const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

// ─── 去除 <!--markdown--> 前缀 ────────────────────────────────────────────

const MARKDOWN_PREFIX = '<!--markdown-->';
const RENDER_CACHE_MAX_ENTRIES = 64;
const RENDER_CACHE_MAX_SOURCE_LENGTH = 100_000;

export interface RenderedContent {
  html: string;
  plainExcerpt: string;
}

const renderedContentCache = new Map<string, RenderedContent>();
const commentSanitizeOptionsCache = new Map<string, sanitizeHtml.IOptions>();
const COMMENT_SANITIZE_CACHE_MAX_ENTRIES = 32;

function stripMarkdownPrefix(text: string): string {
  return text.startsWith(MARKDOWN_PREFIX) ? text.slice(MARKDOWN_PREFIX.length) : text;
}

/**
 * 从内容中移除 Typecho 特有的标记：<!--markdown--> 前缀以及所有的 <!--more--> 标签。
 */
export function stripTypechoMarkers(text: string): string {
  return stripMarkdownPrefix(text).replace(MORE_COMMENT_RE, '');
}

/**
 * 去除所有 HTML 标签，并将空白字符折叠为单个空格。
 */
export function stripHtmlTags(html: string): string {
  return html.replace(HTML_TAG_RE, ' ').replace(WHITESPACE_RE, ' ').trim();
}

// ─── 辅助函数：计算 padding-top 百分比 ──────────────────────────────────────

function getPaddingTop(ratio: string): string {
  const parts = ratio.split('/').map(Number);
  if (parts.length !== 2 || parts.some(isNaN) || parts[0] === 0) {
    return '100%';
  }
  return `${(parts[1] / parts[0]) * 100}%`;
}

// ─── 自定义 marked 扩展：LivePhoto（实况照片） ───────────────────────────────

const LIVE_PHOTO_REGEX = /^\[LivePhoto\s+photo="([^"]+)"\s+video="([^"]+)"(?:\s+ratio="([^"]+)")?\s*\]/;

marked.use({
  extensions: [
    {
      name: 'livephoto',
      level: 'block',
      start(src: string) {
        return src.match(/\[LivePhoto/)?.index;
      },
      tokenizer(src: string) {
        const match = src.match(LIVE_PHOTO_REGEX);
        if (match) {
          const [, photo, video, ratio = '3/4'] = match;
          return {
            type: 'livephoto',
            raw: match[0],
            photo,
            video,
            ratio,
          };
        }
        return undefined;
      },
      renderer(token: any) {
        const { photo, video, ratio } = token;
        const safePhoto = escapeHtml(photo);
        const safeVideo = escapeHtml(video);
        const paddingTop = getPaddingTop(ratio);
        const id = `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const containerStyle = `position:relative; width:100%; padding-top:${paddingTop};`;
        const innerStyle = `position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover;`;
        return `<div style="${containerStyle}" class="live-photo live-photo-wrapper" id="${id}">
    <img class="live-photo-img" src="${safePhoto}" alt="Live Photo" style="${innerStyle}">
    <video class="live-photo-video" playsinline muted preload="auto" style="${innerStyle}">
        <source src="${safeVideo}" type="video/mp4">
    </video>
</div>`;
      },
    },
  ],
});

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 将 Markdown 渲染为 HTML（同步，无插件钩子）
 */
export function renderMarkdown(text: string): string {
  return renderContent(text).html;
}

/**
 * 一次性解析并清理内容，同时派生出完整的 HTML 和纯文本摘要。
 * 一个小的有限缓存可以让归档和 Feed 渲染复用相同的结果，而无需保留任意大的文章。
 */
export function renderContent(text: string, maxExcerptLength = 200): RenderedContent {
  if (!text) return { html: '', plainExcerpt: '' };

  const cacheable = maxExcerptLength === 200 && text.length <= RENDER_CACHE_MAX_SOURCE_LENGTH;
  const cached = cacheable ? renderedContentCache.get(text) : undefined;
  if (cached) {
    // 刷新插入顺序以进行 LRU 淘汰。
    renderedContentCache.delete(text);
    renderedContentCache.set(text, cached);
    return cached;
  }

  const content = stripMarkdownPrefix(text).replace(MORE_COMMENT_RE, '');
  const parsed = marked.parse(content, { async: false }) as string;
  const html = sanitizeHtml(parsed, SANITIZE_OPTIONS);
  const plain = stripHtmlTags(parsed);
  const plainExcerpt = plain.length <= maxExcerptLength
    ? plain
    : `${plain.substring(0, maxExcerptLength)}...`;
  const rendered = { html, plainExcerpt };

  if (cacheable) {
    renderedContentCache.set(text, rendered);
    if (renderedContentCache.size > RENDER_CACHE_MAX_ENTRIES) {
      const oldest = renderedContentCache.keys().next().value;
      if (oldest !== undefined) renderedContentCache.delete(oldest);
    }
  }
  return rendered;
}

export function renderCommentText(text: string, options: CommentRenderOptions = {}): string {
  if (!text) return '';

  const sanitizeOptions = buildCommentSanitizeOptions(options.htmlTagAllowed, !!options.markdown);
  if (options.markdown) {
    const html = marked.parse(stripMarkdownPrefix(text), { async: false }) as string;
    return sanitizeHtml(html, sanitizeOptions);
  }

  const sanitized = sanitizeHtml(text, sanitizeOptions);
  return autop(sanitized);
}

/**
 * 使用插件过滤钩子将 Markdown 渲染为 HTML（异步）
 * 用于内容展示，以便插件可以进行拦截
 */
export async function renderMarkdownFiltered(ctx: HookContext, text: string): Promise<string> {
  if (!text) return '';

  let content = stripMarkdownPrefix(text);
  // 从全文渲染中移除 <!--more--> —— 它仅对列表/摘要视图有意义，
  // 该视图使用 renderContentExcerpt() 代替。
  content = content.replace(MORE_COMMENT_RE, '');

  // 应用 content:markdown 过滤器 —— 插件可以修改原始 Markdown
  content = await applyFilter(ctx, 'content:markdown', content);

  const html = marked.parse(content, { async: false }) as string;
  let sanitized = sanitizeHtml(html, SANITIZE_OPTIONS);

  // 应用 content:content 过滤器 —— 插件可以修改渲染后的 HTML
  sanitized = await applyFilter(ctx, 'content:content', sanitized);

  return sanitized;
}

// ─── 摘要提取核心逻辑（供下方两个 API 复用，避免重复） ────────────

/**
 * 内部辅助函数：提取摘要的核心逻辑，供 renderContentExcerpt 和 renderExcerptHtml 复用
 */
function buildExcerptBase(
  text: string,
  maxPlainLength: number
): { html: string; isExcerpt: boolean } {
  if (!text) return { html: '', isExcerpt: false };
  const content = stripMarkdownPrefix(text);

  // 情况一：有 <!--more-->，按 more 截取
  if (content.includes('<!--more-->')) {
    const withPlaceholder = content.replace(MORE_COMMENT_RE, '\n\n' + MORE_PLACEHOLDER + '\n\n');
    const html = marked.parse(withPlaceholder, { async: false }) as string;
    const sanitized = sanitizeHtml(html, SANITIZE_OPTIONS);
    return { html: sanitized.split(MORE_PLACEHOLDER_RE)[0], isExcerpt: true };
  }

  // 情况二：没有 <!--more-->，渲染全文后按纯文本长度判断
  const parsed = marked.parse(content, { async: false }) as string;
  const sanitized = sanitizeHtml(parsed, SANITIZE_OPTIONS);
  const plain = stripHtmlTags(sanitized);

  // 内容短：直接返回完整 HTML
  if (plain.length <= maxPlainLength) {
    return { html: sanitized, isExcerpt: false };
  }

  // 内容长：截取前 maxPlainLength 个字符 + 省略号
  const truncated = plain.substring(0, maxPlainLength) + '...';
  return { html: `<p>${escapeHtml(truncated)}</p>`, isExcerpt: true };
}

/**
 * 渲染带 <!--more--> 支持的摘要内容，并附带「阅读剩余部分」链接。
 *
 * ─── 本次修改点 ─────────────────────────────
 * 原来：没有 <!--more--> 时返回全文 HTML，首页超长
 * 现在：没有 <!--more--> 时自动截取前 maxPlainLength 个纯文本字符
 *
 * 后期想调字数：改 maxPlainLength = 100 里的数字即可
 * ─────────────────────────────────────────────
 */
export function renderContentExcerpt(
  text: string,
  moreText = '- 阅读剩余部分 -',
  permalink = '#',
  maxPlainLength = 100
): string {
  const { html } = buildExcerptBase(text, maxPlainLength);
  if (!html) return '';

  const moreLink = `<p class="more"><a href="${escapeHtml(permalink)}" title="${escapeHtml(moreText)}">${escapeHtml(moreText)}</a></p>`;
  return `${html}${moreLink}`;
}

/**
 * 只渲染摘要部分（HTML 格式），不含"阅读更多"链接。
 * 用于预渲染缓存，列表页使用。
 *
 * ─── 本次修改点 ─────────────────────────────
 * 原来：没有 <!--more--> 时返回全文 HTML
 * 现在：没有 <!--more--> 时自动截取前 maxPlainLength 个纯文本字符
 *
 * 后期想调字数：改 maxPlainLength = 100 里的数字即可
 * ─────────────────────────────────────────────
 */
export function renderExcerptHtml(text: string, maxPlainLength = 100): string {
  return buildExcerptBase(text, maxPlainLength).html;
}

/**
 * 从内容中生成纯文本摘要
 */
export function generateExcerpt(text: string, maxLength = 200): string {
  return renderContent(text, maxLength).plainExcerpt;
}

/**
 * 自动段落辅助函数。按空行拆分，并将每个段落包裹在 <p>...</p> 中，
 * 除非它以可识别的块级元素开头。段落内的单个换行符变为 <br />。
 *
 * 包裹已包含 <p> / <div> / <h1> 等的块会产生无效的 HTML（<p><div>...</div></p>）；
 * 浏览器可以容忍，但输出会破坏后续的清理器和 CSS 选择器。
 */
const BLOCK_OPEN_RE = /^\s*<(p|div|section|article|aside|header|footer|nav|figure|figcaption|blockquote|pre|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|th|td|h[1-6]|hr|details|summary|form|fieldset)\b/i;

export function autop(text: string): string {
  if (!text) return '';
  text = text.replace(/\r\n|\r/g, '\n');
  text = text.replace(/\n\n+/g, '\n\n');
  const paragraphs = text.split('\n\n');
  return paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      if (BLOCK_OPEN_RE.test(p)) return p;
      return `<p>${p.replace(/\n/g, '<br />')}</p>`;
    })
    .join('\n');
}

function buildCommentSanitizeOptions(htmlTagAllowed?: string | null, markdown = false): sanitizeHtml.IOptions {
  const cacheKey = `${markdown ? '1' : '0'}\0${htmlTagAllowed || ''}`;
  const cached = commentSanitizeOptionsCache.get(cacheKey);
  if (cached) return cached;

  const parsed = parseAllowedHtmlTags(htmlTagAllowed);
  let result: sanitizeHtml.IOptions;
  if (!parsed) {
    result = markdown ? COMMENT_MARKDOWN_OPTIONS : {
      allowedTags: [],
      allowedAttributes: {},
    };
  } else if (!markdown) {
    result = {
      allowedTags: parsed.allowedTags,
      allowedAttributes: parsed.allowedAttributes,
      // 将默认方案传递进来，以便链接能在清理器中存活。
      allowedSchemes: sanitizeHtml.defaults.allowedSchemes,
    };
  } else {
    result = {
      ...COMMENT_MARKDOWN_OPTIONS,
      allowedTags: [...new Set([...COMMENT_MARKDOWN_OPTIONS.allowedTags as string[], ...parsed.allowedTags])],
      allowedAttributes: mergeAllowedAttributes(COMMENT_MARKDOWN_OPTIONS.allowedAttributes || {}, parsed.allowedAttributes),
    };
  }

  commentSanitizeOptionsCache.set(cacheKey, result);
  if (commentSanitizeOptionsCache.size > COMMENT_SANITIZE_CACHE_MAX_ENTRIES) {
    const oldest = commentSanitizeOptionsCache.keys().next().value;
    if (oldest !== undefined) commentSanitizeOptionsCache.delete(oldest);
  }
  return result;
}

function parseAllowedHtmlTags(htmlTagAllowed?: string | null): {
  allowedTags: string[];
  allowedAttributes: Record<string, string[]>;
} | null {
  if (!htmlTagAllowed?.trim()) return null;

  const allowedTags: string[] = [];
  const allowedAttributes: Record<string, string[]> = {};
  const tagRe = /<\s*([a-zA-Z0-9]+)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(htmlTagAllowed)) !== null) {
    const tag = match[1].toLowerCase();
    allowedTags.push(tag);

    // 匹配 `name=` 或裸属性名（例如 `<a href>`）。
    const attrs = [...match[2].matchAll(/([a-zA-Z0-9:-]+)(?=\s*=|\s|\/?>|$)/g)]
      .map(attr => attr[1].toLowerCase())
      .filter(attr => isSafeAttributeName(tag, attr));
    if (attrs.length > 0) {
      allowedAttributes[tag] = [...new Set([...(allowedAttributes[tag] || []), ...attrs])];
    }
  }

  return {
    allowedTags: [...new Set(allowedTags)],
    allowedAttributes,
  };
}

/**
 * 拒绝无论出现在哪个标签上都不安全的属性名。
 * 尽管 sanitize-html 本身通常会过滤内联事件处理器，
 * 但评论表单路径允许管理员通过 options.commentsHTMLTagAllowed 声明自定义 HTML 允许列表——
 * 那里出现一个笔误就可能重新启用 XSS 攻击面。
 *
 * 该集合故意偏向于过度拒绝。如果需要，调用者可以通过插件过滤器恢复更广泛的集合。
 */
const ATTRIBUTE_GLOBAL_DENYLIST = new Set([
  'style', 'srcset', 'sandbox', 'allow', 'allowfullscreen',
  'formaction', 'action', 'background', 'dynsrc', 'lowsrc', 'ping',
  'poster', 'data',
]);

function isSafeAttributeName(tag: string, attr: string): boolean {
  if (attr.startsWith('on')) return false;
  if (attr.startsWith('xlink:') || attr.startsWith('xmlns')) return false;
  if (ATTRIBUTE_GLOBAL_DENYLIST.has(attr)) return false;
  // src 仅对少数标签有意义；在其他地方拒绝。
  if (attr === 'src' && !['img', 'audio', 'video', 'source', 'iframe'].includes(tag)) return false;
  // href 同样仅限于锚点和（旧版）链接标签。
  if (attr === 'href' && !['a', 'link', 'area'].includes(tag)) return false;
  return true;
}

function mergeAllowedAttributes(
  base: sanitizeHtml.IOptions['allowedAttributes'],
  extra: Record<string, string[]>,
): sanitizeHtml.IOptions['allowedAttributes'] {
  const merged: Record<string, string[]> = {};
  for (const [tag, attrs] of Object.entries(base || {})) {
    merged[tag] = Array.isArray(attrs) ? attrs.map(String) : [];
  }
  for (const [tag, attrs] of Object.entries(extra)) {
    merged[tag] = [...new Set([...(merged[tag] || []), ...attrs])];
  }
  return merged;
}
