import { normalizeSlug } from '@/lib/input';

export class WriteFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteFilterError';
  }
}

const COMMENT_STATUSES = new Set(['approved', 'waiting', 'spam']);
const CONTENT_STATUSES = new Set(['publish', 'draft', 'hidden', 'private', 'waiting']);
const BINARY_FLAGS = new Set(['0', '1']);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WriteFilterError('插件必须返回对象');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string, max: number, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string') throw new WriteFilterError(`插件返回了无效的 ${field}`);
  if (value.length > max) throw new WriteFilterError(`插件返回的 ${field} 过长`);
  return value;
}

function integerField(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new WriteFilterError(`插件返回了无效的 ${field}`);
  }
  return value as number;
}

/**
 * Rebuild a comment row from the documented mutable fields. Protected fields
 * always come from the pre-filter record, so a plugin cannot redirect writes,
 * impersonate users, or alter ownership and threading relationships.
 */
export function validateFilteredComment(
  baseline: Record<string, unknown>,
  filtered: unknown,
): Record<string, unknown> {
  const value = record(filtered);
  const status = stringField(value.status, '评论状态', 16);
  if (!COMMENT_STATUSES.has(status!)) throw new WriteFilterError('插件返回了无效的评论状态');

  const result: Record<string, unknown> = {
    cid: baseline.cid,
    created: baseline.created,
    author: stringField(value.author, '评论作者', 200),
    authorId: baseline.authorId,
    ownerId: baseline.ownerId,
    mail: stringField(value.mail, '评论邮箱', 320),
    url: stringField(value.url, '评论网址', 2048),
    ip: baseline.ip,
    agent: baseline.agent,
    text: stringField(value.text, '评论内容', 10_000),
    type: baseline.type,
    status,
    parent: baseline.parent,
  };
  if (value._rejected !== undefined) {
    if (typeof value._rejected !== 'string') throw new WriteFilterError('插件返回了无效的拒绝原因');
    result._rejected = value._rejected.slice(0, 500);
  }
  return result;
}

/** Rebuild content data from the documented mutable contract and protected operation fields. */
export function validateFilteredContent(
  baseline: Record<string, unknown>,
  filtered: unknown,
): Record<string, unknown> {
  const value = record(filtered);
  const status = stringField(value.status, '内容状态', 16);
  if (!CONTENT_STATUSES.has(status!)) throw new WriteFilterError('插件返回了无效的内容状态');
  const flags = ['allowComment', 'allowPing', 'allowFeed'] as const;
  const validatedFlags = Object.fromEntries(flags.map((field) => {
    const flag = stringField(value[field], field, 1);
    if (!BINARY_FLAGS.has(flag!)) throw new WriteFilterError(`插件返回了无效的 ${field}`);
    return [field, flag];
  }));

  return {
    title: stringField(value.title, '标题', 255),
    slug: normalizeSlug(stringField(value.slug, 'slug', 150) || ''),
    created: integerField(value.created, '创建时间', 1, 8_640_000_000_000),
    modified: baseline.modified,
    text: stringField(value.text, '正文', 256 * 1024),
    order: integerField(value.order, '排序', -2_147_483_648, 2_147_483_647),
    authorId: baseline.authorId,
    template: stringField(value.template, '模板', 255, true),
    type: baseline.type,
    parent: baseline.parent,
    status,
    password: stringField(value.password, '密码', 255, true),
    ...validatedFlags,
  };
}
