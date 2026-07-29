import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { parseResetToken, hashPassword, generateRandomString } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request }) => {
  // Origin check — prevent CSRF
  const origin = request.headers.get('origin');
  if (!origin) return new Response('Forbidden', { status: 403 });
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.origin !== requestUrl.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  } catch { return new Response('Forbidden', { status: 403 }); }

  const formData = await request.formData();
  const token = formData.get('token')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';

  if (!token || !password) {
    return new Response('参数不完整', { status: 400 });
  }

  if (password.length < 6) {
    return new Response('密码至少需要 6 位', { status: 400 });
  }

  const db = getDb(env.DB);
  const parsed = await parseResetToken(token, db);

  if (!parsed.valid || !parsed.uid) {
    const msg = parsed.error === 'expired' ? '链接已过期' : '链接无效或已被使用';
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>重置失败</title></head><body><p>${msg}</p><p><a href="/admin/login">返回登录</a></p></body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  // Hash new password + generate fresh authCode (invalidates all sessions, decision #4)
  const newHash = await hashPassword(password);
  const newAuthCode = generateRandomString(32);

  await db.update(schema.users).set({
    password: newHash,
    authCode: newAuthCode,
  }).where(eq(schema.users.uid, parsed.uid));

  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login?reset=success' },
  });
};
