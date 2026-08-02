import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(join(process.cwd(), 'src/pages/admin', name), 'utf8');
}

describe('bounded admin list filters', () => {
  it.each(['manage-posts.astro', 'manage-comments.astro', 'manage-users.astro', 'manage-medias.astro'])(
    '%s uses shared bounded pagination and query preservation',
    (name) => {
      const contents = source(name);
      expect(contents).toContain('parsePageNumber(');
      expect(contents).toContain('withQueryParams(');
    },
  );

  it('applies administrator uid scope and carries it through post filtering', () => {
    const contents = source('manage-posts.astro');
    expect(contents).toContain('eq(schema.contents.authorId, requestedUid)');
    expect(contents).toContain('name="uid"');
    expect(contents).toContain('uid: requestedUid');
  });
});
