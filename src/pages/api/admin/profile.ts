import type { APIRoute } from 'astro';
import { schema } from '@/db';
import {
  clearAuthCookieHeaders,
  generateRandomString,
  hashPassword,
  verifyPassword,
} from '@/lib/auth';
import { PASSWORD_MIN_LENGTH } from '@/lib/constants';
import { isAdminActionResponse, requireAdminAction } from '@/lib/admin-auth';
import { normalizeHttpUrl } from '@/lib/url';
import { eq, and, ne } from 'drizzle-orm';

export const POST: APIRoute = async ({ request, locals }) => {
  const auth = await requireAdminAction(request, 'visitor');
  if (isAdminActionResponse(auth)) return auth;

  const formData = await request.formData();
  const screenName = formData.get('screenName')?.toString()?.trim() || auth.user.name;
  const mail = formData.get('mail')?.toString()?.trim() || '';
  const url = formData.get('url')?.toString()?.trim() || '';
  const password = formData.get('password')?.toString() || '';
  const passwordConfirm = formData.get('passwordConfirm')?.toString() || '';
  const currentPassword = formData.get('currentPassword')?.toString() || '';

  if (!mail) return new Response('邮箱不能为空', { status: 400 });

  // Basic email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return new Response('邮箱格式不正确', { status: 400 });
  }

  // Check email uniqueness (exclude current user)
  const existingMail = await auth.db.query.users.findFirst({
    where: and(eq(schema.users.mail, mail), ne(schema.users.uid, auth.uid)),
  });
  if (existingMail) {
    return new Response('邮箱已被其他用户使用', { status: 409 });
  }

  const updateData: Record<string, unknown> = {
    screenName,
    mail,
    url: null,
  };

  if (url) {
    const normalizedUrl = normalizeHttpUrl(url);
    if (normalizedUrl === null) {
      return new Response('个人主页地址格式不正确', { status: 400 });
    }
    updateData.url = normalizedUrl;
  }

  if (password) {
    if (!currentPassword) {
      return new Response('请输入当前密码', { status: 400 });
    }
    if (!auth.user.password || await verifyPassword(currentPassword, auth.user.password) !== true) {
      return new Response('当前密码不正确', { status: 403 });
    }
    if (password !== passwordConfirm) {
      return new Response('两次输入的密码不一致', { status: 400 });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return new Response(`密码长度至少${PASSWORD_MIN_LENGTH}位`, { status: 400 });
    }
    updateData.password = await hashPassword(password);
    updateData.authCode = generateRandomString(32);
  }

  await auth.db.update(schema.users).set(updateData).where(eq(schema.users.uid, auth.uid));

  if (password) {
    const headers = new Headers({ Location: '/admin/login?password=changed' });
    for (const cookie of clearAuthCookieHeaders(request)) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 302, headers });
  }

  return new Response(null, { status: 302, headers: { Location: '/admin/profile' } });
};
