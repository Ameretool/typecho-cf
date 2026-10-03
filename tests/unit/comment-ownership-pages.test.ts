import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('Comment Ownership admin queries', () => {
  it.each([
    'src/pages/admin/manage-comments.astro',
    'src/pages/admin/profile.astro',
    'src/pages/admin/index.astro',
  ])('%s scopes authorization/statistics through current content author', (path) => {
    const contents = source(path);
    expect(contents).toContain('schema.contents.authorId');
    expect(contents).not.toMatch(/where\(eq\(schema\.comments\.ownerId/);
    expect(contents).not.toMatch(/conditions\.push\(eq\(schema\.comments\.ownerId/);
  });

  it('scopes every non-admin comment status total to current content ownership', () => {
    const contents = source('src/pages/admin/manage-comments.astro');
    // The three per-status count(*) queries were consolidated into one
    // GROUP BY status scan; the non-admin authorId scoping must survive.
    expect(contents.match(/!isAdmin \? \[eq\(schema\.contents\.authorId, user!\.uid\)\]/g))
      .toHaveLength(1);
  });
});
