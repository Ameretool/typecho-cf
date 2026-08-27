import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const previewPage = readFileSync(join(process.cwd(), 'src/pages/admin/theme-preview.astro'), 'utf8');
const themesPage = readFileSync(join(process.cwd(), 'src/pages/admin/themes.astro'), 'utf8');

describe('live theme preview', () => {
  it('renders the requested theme using request-local options', () => {
    expect(previewPage).toContain("searchParams.get('theme')");
    expect(previewPage).toContain('const previewCtx =');
    expect(previewPage).toContain('theme: theme.id');
    expect(previewPage).toContain('urls: computeUrls');
    expect(previewPage).toContain('prepareIndexData(previewCtx');
    expect(previewPage).toContain('themeTemplates[theme.id]');
    expect(previewPage).toContain('preparePageData');
    expect(previewPage).toContain("frontPage?.startsWith('page:')");
    expect(previewPage).toContain('const PageComponent =');
  });

  it('requires an authenticated administrator', () => {
    expect(previewPage).toContain('requireAuth(ctx)');
    expect(previewPage).toContain("hasPermission(ctx.user!.group || 'visitor', 'administrator')");
  });

  it('passes the selected theme id from the admin card', () => {
    expect(themesPage).toContain('href={`${urls.adminUrl}theme-preview?theme=${encodeURIComponent(theme.id)}`}');
  });
});
