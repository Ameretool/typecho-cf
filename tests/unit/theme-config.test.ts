/**
 * Unit tests for theme config declaration + reading.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTheme,
  themeHasConfig,
  getThemeConfigDefaults,
  loadThemeConfig,
} from '@/lib/theme';

const THEME = 'typecho-theme-config-unit';

beforeEach(() => {
  registerTheme('typecho-theme-config-unit', {
    id: THEME,
    name: 'Config Unit',
    config: {
      footerText: { type: 'text', label: 'Footer', default: 'default footer' },
      showSearch: { type: 'checkbox', label: 'Show Search', default: '1' },
      token: { type: 'password', label: 'Token', default: 'secret-default' },
      providers: { type: 'repeatable', label: 'Providers', default: [] },
    },
  }, `/themes/${THEME}/style.css`);
});

describe('themeHasConfig()', () => {
  it('is true when the manifest declares a non-empty config', () => {
    expect(themeHasConfig(THEME)).toBe(true);
  });

  it('is false for unknown themes or empty config', () => {
    expect(themeHasConfig('no-such-theme')).toBe(false);
    registerTheme('typecho-theme-config-empty', {
      id: 'typecho-theme-config-empty',
      name: 'Empty',
      config: {},
    }, '/themes/typecho-theme-config-empty/style.css');
    expect(themeHasConfig('typecho-theme-config-empty')).toBe(false);
  });
});

describe('getThemeConfigDefaults()', () => {
  it('resolves per-field defaults', () => {
    expect(getThemeConfigDefaults(THEME)).toEqual({
      footerText: 'default footer',
      showSearch: '1',
      token: 'secret-default',
      providers: [],
    });
  });

  it('returns {} for themes without config', () => {
    expect(getThemeConfigDefaults('no-such-theme')).toEqual({});
  });
});

describe('loadThemeConfig()', () => {
  it('falls back to manifest defaults when nothing is saved', () => {
    expect(loadThemeConfig({}, THEME)).toEqual({
      footerText: 'default footer',
      showSearch: '1',
      token: 'secret-default',
      providers: [],
    });
  });

  it('merges saved JSON over defaults and keeps missing keys', () => {
    const options = {
      [`theme:${THEME}`]: JSON.stringify({ footerText: 'custom footer' }),
    };
    expect(loadThemeConfig(options, THEME)).toEqual({
      footerText: 'custom footer',
      showSearch: '1',
      token: 'secret-default',
      providers: [],
    });
  });

  it('tolerates corrupt saved JSON', () => {
    const options = { [`theme:${THEME}`]: '{not json' };
    expect(loadThemeConfig(options, THEME).footerText).toBe('default footer');
  });

  it('accepts raw object option values', () => {
    const options = { [`theme:${THEME}`]: { footerText: 'object value' } };
    expect(loadThemeConfig(options, THEME).footerText).toBe('object value');
  });
});
