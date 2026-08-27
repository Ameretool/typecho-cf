import { getTheme } from '@/lib/theme';

/** Query parameter that carries a read-only admin theme preview across routes. */
export const THEME_PREVIEW_QUERY_PARAM = '__typechoPreviewTheme';

/** Request-local option key consumed by Base.astro to preserve preview navigation. */
export const THEME_PREVIEW_OPTION = 'themePreview';

/**
 * Resolve a previewed theme only when the caller has already authenticated an
 * administrator. The query parameter alone never changes a visitor's theme.
 */
export function getThemePreviewId(request: Request, isAdministrator: boolean): string | null {
  if (!isAdministrator) return null;

  const themeId = new URL(request.url).searchParams.get(THEME_PREVIEW_QUERY_PARAM)?.trim();
  if (!themeId) return null;

  return getTheme(themeId)?.id ?? null;
}
