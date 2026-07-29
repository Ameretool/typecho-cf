/**
 * Mock for `astro:middleware` — vitest can't resolve Astro virtual modules.
 * defineMiddleware is a transparent wrapper: it returns the handler fn as-is.
 */
export function defineMiddleware(fn: (...args: any[]) => any) {
  return fn;
}
