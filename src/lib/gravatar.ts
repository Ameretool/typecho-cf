import { createHash } from 'node:crypto';

export interface GravatarUrlOptions {
  defaultImage?: string;
  size?: number;
  rating?: string;
}

/**
 * Gravatar / Libravatar 都通过「邮箱 trim + 小写 后的 MD5 哈希」定位头像。
 * Web Crypto（crypto.subtle.digest）不支持 MD5，因此使用 node:crypto
 * （项目已启用 nodejs_compat，page-data.ts 同样在用 createHash('md5')）。
 */
export async function createGravatarHash(email: string): Promise<string> {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

export async function buildGravatarUrl(
  email: string | null | undefined,
  { defaultImage = 'identicon', size = 40, rating }: GravatarUrlOptions = {},
): Promise<string> {
  const hash = email ? await createGravatarHash(email) : '';
  const params = new URLSearchParams();
  params.set('d', defaultImage);
  params.set('s', String(size));
  if (rating) params.set('r', rating);
  return `https://seccdn.libravatar.org/avatar/${hash}?${params.toString()}`;
}
