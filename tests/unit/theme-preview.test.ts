import { describe, expect, it } from 'vitest';
import { registerTheme } from '@/lib/theme';
import { getThemePreviewId, THEME_PREVIEW_QUERY_PARAM } from '@/lib/theme-preview';

const THEME_ID = 'typecho-theme-preview-test';
registerTheme('typecho-theme-preview-test', {
  id: THEME_ID,
  name: 'Preview test theme',
}, `/themes/${THEME_ID}/style.css`);

describe('theme preview resolution', () => {
  it('accepts an installed theme for administrators only', () => {
    const request = new Request(`https://example.com/?${THEME_PREVIEW_QUERY_PARAM}=${THEME_ID}`);
    expect(getThemePreviewId(request, true)).toBe(THEME_ID);
    expect(getThemePreviewId(request, false)).toBeNull();
  });

  it('rejects unknown theme ids', () => {
    const request = new Request(`https://example.com/?${THEME_PREVIEW_QUERY_PARAM}=unknown-theme`);
    expect(getThemePreviewId(request, true)).toBeNull();
  });
});
