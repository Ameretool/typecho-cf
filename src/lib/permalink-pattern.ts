export type PermalinkPatternKind = 'post' | 'page' | 'category';

/** Preset default patterns. Single source of truth for all modules. */
export const DEFAULT_PERMALINK_PATTERNS = {
  post: '/archives/{cid}/',
  page: '/{slug}',
  category: '/category/{slug}/',
} as const;

export interface PermalinkValues {
  cid?: string | number | null;
  slug?: string | null;
  category?: string | null;
  mid?: string | number | null;
  year?: string | number | null;
  month?: string | number | null;
  day?: string | number | null;
}

const TOKENS: Record<PermalinkPatternKind, readonly string[]> = {
  post: ['cid', 'slug', 'category', 'year', 'month', 'day'],
  page: ['cid', 'slug'],
  category: ['mid', 'slug'],
};

const CAPTURES: Record<string, string> = {
  cid: '\\d+',
  mid: '\\d+',
  slug: '[^/]+',
  category: '[^/]+',
  year: '\\d{4}',
  month: '\\d{1,2}',
  day: '\\d{1,2}',
};

const patternCache = new Map<string, RegExp | null>();

function tokensIn(pattern: string): string[] {
  return [...pattern.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
}

function isValidPattern(pattern: string, kind: PermalinkPatternKind): boolean {
  if (!pattern.startsWith('/')) return false;
  const tokens = tokensIn(pattern);
  if (tokens.some(token => !TOKENS[kind].includes(token))) return false;
  if (new Set(tokens).size !== tokens.length) return false;
  if (kind === 'post' || kind === 'page') {
    return tokens.includes('cid') || tokens.includes('slug');
  }
  return tokens.includes('mid') || tokens.includes('slug');
}

/** Render and match use the same token grammar, preventing one-way URLs. */
export function renderPermalinkPattern(
  pattern: string,
  kind: PermalinkPatternKind,
  values: PermalinkValues,
): string | null {
  if (!isValidPattern(pattern, kind)) return null;
  let result = pattern;
  for (const token of tokensIn(pattern)) {
    const value = values[token as keyof PermalinkValues];
    if (value === null || value === undefined || value === '') return null;
    result = result.replace(`{${token}}`, String(value));
  }
  return result;
}

export function compilePermalinkPattern(
  pattern: string,
  kind: PermalinkPatternKind,
): RegExp | null {
  const cacheKey = `${kind}:${pattern}`;
  if (patternCache.has(cacheKey)) return patternCache.get(cacheKey) ?? null;
  if (!isValidPattern(pattern, kind)) {
    patternCache.set(cacheKey, null);
    return null;
  }

  let source = '';
  let cursor = 0;
  for (const match of pattern.matchAll(/\{([^{}]+)\}/g)) {
    const index = match.index ?? 0;
    source += pattern.slice(cursor, index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source += `(?<${match[1]}>${CAPTURES[match[1]]})`;
    cursor = index + match[0].length;
  }
  source += pattern.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (source.endsWith('/')) source = `${source.slice(0, -1)}/?`;

  try {
    const regex = new RegExp(`^${source}$`);
    patternCache.set(cacheKey, regex);
    return regex;
  } catch {
    patternCache.set(cacheKey, null);
    return null;
  }
}
