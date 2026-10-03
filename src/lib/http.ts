/**
 * Standardized error response helpers.
 *
 * Front-end HTML routes (comment posting, install, etc.) use plain-text
 * responses because they are consumed by browsers and rendered by
 * server error pages. Admin JSON APIs use `{ error: string }` shape so
 * client code can parse without content-negotiation.
 *
 * Use `textError(status, message)` for user-facing HTML flows.
 * Use `jsonError(status, message)` for admin/API JSON responses.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export function textError(status: number, message: string, extraHeaders?: HeadersInit): Response {
  return new Response(message, { status, headers: extraHeaders });
}

export function jsonError(status: number, message: string, extraHeaders?: Record<string, string>): Response {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export function jsonOk<T>(body: T, extraHeaders?: Record<string, string>): Response {
  const headers = extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS;
  return new Response(JSON.stringify(body), { status: 200, headers });
}
