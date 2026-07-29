import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions, computeUrls } from '@/lib/options';
import { generateResetToken } from '@/lib/auth';
import { sendMail } from '@/lib/mail';
import { trackSlidingWindow } from '@/lib/login-rate-limit';
import { getClientIp } from '@/lib/context';
import { setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

export const POST: APIRoute = async ({ request }) => {
  // Origin check — prevent CSRF. Missing origin is rejected outright
  // because browsers send Origin on cross-origin form POSTs; anonymous
  // tools can't bypass without explicit opt-in.
  const origin = request.headers.get('origin');
  if (!origin) return new Response('Forbidden', { status: 403 });
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (originUrl.origin !== requestUrl.origin) {
      return new Response('Forbidden', { status: 403 });
    }
  } catch { return new Response('Forbidden', { status: 403 }); }

  const ip = getClientIp(request);
  if (!trackSlidingWindow(`forgot-pw:${ip}`, { windowSeconds: 3600, maxRequests: 3 })) {
    return new Response('请求过于频繁，请稍后再试', { status: 429, headers: { 'Retry-After': '3600' } });
  }

  const formData = await request.formData();
  const email = formData.get('email')?.toString()?.trim() || '';

  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const urls = computeUrls(options);

  // Always return the same success page — don't leak whether email exists
  const successPage = new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>密码重置</title></head><body><p>如果该邮箱已注册，我们已发送重置链接。请检查收件箱。</p><p><a href="/admin/login">返回登录</a></p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );

  if (!email) return successPage;

  // Per-email throttle (1 per hour)
  const throttleRow = await db.query.passwordResetThrottle.findFirst({
    where: eq(schema.passwordResetThrottle.email, email),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  if (throttleRow && nowSec - throttleRow.lastSentAt < 3600) return successPage;

  const user = await db.query.users.findFirst({
    where: eq(schema.users.mail, email),
    columns: { uid: true, mail: true },
  });
  if (!user) return successPage;

  // Generate token → write authCode → overwrites existing sessions (by design, decision #4)
  const token = generateResetToken();
  await db.update(schema.users).set({ authCode: token }).where(eq(schema.users.uid, user.uid));

  // Throttle
  if (throttleRow) {
    await db.update(schema.passwordResetThrottle).set({ lastSentAt: nowSec }).where(eq(schema.passwordResetThrottle.email, email));
  } else {
    await db.insert(schema.passwordResetThrottle).values({ email, lastSentAt: nowSec });
  }

  // Send mail — best-effort; if no adapter is installed, mail will fail silently
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  setActivatedPlugins(pluginCtx, parseActivatedPlugins(options.activatedPlugins as string | undefined));

  const resetUrl = `${urls.siteUrl}/admin/reset-password?token=${encodeURIComponent(token)}`;
  await sendMail(pluginCtx, {
    to: email,
    subject: `${options.title || 'Typecho'} - 密码重置`,
    html: `<p>您好，</p><p>我们收到了重置密码的请求。请点击以下链接设置新密码（1小时内有效）：</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>如果您未请求此操作，请忽略此邮件。</p>`,
    text: `您好，\n\n请访问以下链接重置密码（1小时内有效）：\n${resetUrl}\n\n如果您未请求此操作，请忽略此邮件。`,
  }, { request, options, reason: 'password-reset' });

  return successPage;
};
