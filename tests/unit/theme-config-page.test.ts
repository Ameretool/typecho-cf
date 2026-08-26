import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const themesPage = readFileSync(join(process.cwd(), 'src/pages/admin/themes.astro'), 'utf-8');
const configPage = readFileSync(join(process.cwd(), 'src/pages/admin/theme-config.astro'), 'utf-8');
const configForm = readFileSync(join(process.cwd(), 'src/components/admin/ConfigForm.astro'), 'utf-8');
const themeModule = readFileSync(join(process.cwd(), 'src/lib/theme.ts'), 'utf-8');
const defaultThemeManifest = JSON.parse(readFileSync(join(process.cwd(), 'src/themes/typecho-theme-minimal/theme.json'), 'utf-8')) as Record<string, unknown>;

describe('theme config admin UI', () => {
  it('does not expose configuration for the built-in default theme', () => {
    expect(defaultThemeManifest.config).toBeUndefined();
  });

  it('shows a settings entry only for themes that declare config', () => {
    expect(themesPage).toContain('themeHasConfig(theme.id)');
    expect(themesPage).toContain('/admin/theme-config?id=${theme.id}');
  });

  it('renders the shared form targeting the theme-config API with the theme id', () => {
    expect(configPage).toContain('action="/api/admin/theme-config"');
    expect(configPage).toContain('entityName="theme"');
    expect(configPage).toContain('entityId={themeId}');
    expect(configForm).toContain('name={entityName} value={entityId}');
  });

  it('redirects to the themes list when the theme has no config', () => {
    expect(configPage).toContain("Astro.redirect('/admin/themes')");
    expect(configPage).toContain('!theme || !themeHasConfig(themeId)');
  });

  it('keeps the admin menu and back link on the themes section', () => {
    expect(configPage).toContain('activeMenu="themes"');
    expect(configPage).toContain('backHref="/admin/themes"');
  });

  it('initializes the theme registry for API entrypoints without page-ssr', () => {
    expect(themeModule).toContain("from 'virtual:typecho-theme-registry'");
    expect(themeModule).toContain('for (const entry of themeRegistryEntries)');
  });

  it('keeps the repeatable-row machinery in the shared form component', () => {
    expect(configForm).toContain('CONFIG_ROW_ID');
    expect(configForm).toContain('function renumberRepeatableItems(root)');
    expect(configForm).toContain("legend.textContent = label + ' #' + String(index + 1)");
    expect(configForm.match(/renumberRepeatableItems\(root\)/g)).toHaveLength(3);
  });

  it('keeps R2 binding options in the shared form and secret masking in the view', () => {
    expect(configForm).toContain("typeof (value as any).list === 'function'");
    expect(configPage).toContain('getThemeConfigurationView');
  });
});
