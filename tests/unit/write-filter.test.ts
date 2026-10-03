import { describe, expect, it } from 'vitest';
import { validateFilteredComment, validateFilteredContent, WriteFilterError } from '@/lib/write-filter';

describe('write Filter validation', () => {
  const comment = {
    cid: 1, created: 2, author: 'A', authorId: 3, ownerId: 4,
    mail: 'a@example.com', url: '', ip: '127.0.0.1', agent: 'test',
    text: 'before', type: 'comment', status: 'approved', parent: 0,
  };

  it('allows documented comment transformations and restores protected fields', () => {
    const result = validateFilteredComment(comment, {
      ...comment, text: 'after', status: 'waiting', cid: 999, ownerId: 999, type: 'pingback',
    });
    expect(result).toMatchObject({ cid: 1, ownerId: 4, type: 'comment', text: 'after', status: 'waiting' });
  });

  it('rejects invalid comment status and overlong text', () => {
    expect(() => validateFilteredComment(comment, { ...comment, status: 'root' })).toThrow(WriteFilterError);
    expect(() => validateFilteredComment(comment, { ...comment, text: 'x'.repeat(10_001) })).toThrow(WriteFilterError);
  });

  const content = {
    title: 'Before', slug: 'before', created: 10, modified: 20, text: 'Body', order: 0,
    authorId: 3, template: null, type: 'post', status: 'publish', password: null,
    allowComment: '1', allowPing: '0', allowFeed: '1',
  };

  it('allows documented content transformations and restores protected fields', () => {
    const result = validateFilteredContent(content, {
      ...content, title: 'After', slug: ' Unsafe / Slug ', authorId: 99, type: 'attachment', modified: 999,
    });
    expect(result).toMatchObject({
      title: 'After', slug: 'unsafe-slug', authorId: 3, type: 'post', modified: 20,
    });
  });

  it('rejects invalid content enums, flags, and numbers', () => {
    expect(() => validateFilteredContent(content, { ...content, status: 'root' })).toThrow(WriteFilterError);
    expect(() => validateFilteredContent(content, { ...content, allowFeed: 'yes' })).toThrow(WriteFilterError);
    expect(() => validateFilteredContent(content, { ...content, order: Number.NaN })).toThrow(WriteFilterError);
  });
});
