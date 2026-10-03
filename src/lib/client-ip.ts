/**
 * Extract the client IP using Cloudflare's trusted header first, then the
 * first non-empty X-Forwarded-For entry.
 */
export function getClientIp(request?: Request): string {
  const cfIp = request?.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();

  const xff = request?.headers.get('x-forwarded-for');
  if (!xff) return '';
  for (const raw of xff.split(',')) {
    const ip = raw.trim();
    if (ip) return ip;
  }
  return '';
}
