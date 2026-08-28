import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Paperline code highlighting', () => {
  it('does not emit whitespace nodes between block-level code lines', () => {
    const component = readFileSync(
      join(process.cwd(), 'src/themes/typecho-theme-paperline/components/CodeHighlight.astro'),
      'utf8',
    );

    expect(component).toContain(".join('')");
    expect(component).not.toContain(".join('\\n')");
  });
});
