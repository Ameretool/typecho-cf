import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { parseResetToken, hashPassword, generateRandomString, hashResetToken } from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { and, eq, gte, sql } from 'drizzle-orm';
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

  if (password.length < PASSWORD_MIN_LENGTH) {
    return new Response(`密码至少需要 ${PASSWORD_MIN_LENGTH} 位`, { status: 400 });
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
  const tokenHash = await hashResetToken(token);
  const nowSec = Math.floor(Date.now() / 1000);

  const [updated] = await db.batch([
    db.update(schema.users).set({
      password: newHash,
      authCode: newAuthCode,
    }).where(and(
      eq(schema.users.uid, parsed.uid),
      sql`EXISTS (
        SELECT 1 FROM ${schema.passwordResetRequests}
        WHERE ${schema.passwordResetRequests.uid} = ${parsed.uid}
          AND ${schema.passwordResetRequests.tokenHash} = ${tokenHash}
          AND ${schema.passwordResetRequests.expiresAt} >= ${nowSec}
      )`,
    )).returning({ uid: schema.users.uid }),
    db.update(schema.passwordResetRequests).set({
      tokenHash: null,
      expiresAt: null,
    }).where(and(
      eq(schema.passwordResetRequests.uid, parsed.uid),
      eq(schema.passwordResetRequests.tokenHash, tokenHash),
      gte(schema.passwordResetRequests.expiresAt, nowSec),
    )),
  ] as const);

  if (!updated.length) {
    return new Response('链接无效或已被使用', { status: 400 });
  }

  return new Response(null, {
    status: 302,
    headers: { Location: '/admin/login?reset=success' },
  });
};
