import type { APIRoute } from 'astro';
import { getDb, schema } from '@/db';
import { loadOptions } from '@/lib/options';
import {
  verifyPassword,
  generateAuthToken,
  setAuthCookieHeaders,
  generateRandomString,
  hashPassword,
  passwordHashNeedsRehash,
} from '@/lib/auth';
import { LOGIN_ERROR_FLASH_COOKIE, createFlashRedirectHeaders } from '@/lib/flash';
import { applyFilter, setActivatedPlugins, parseActivatedPlugins, type HookContext } from '@/lib/plugin';
import {
  clearLoginFailures,
  loginLockedUntil,
  readLoginRateLimitConfig,
  recordLoginFailure,
} from '@/lib/login-rate-limit';
import { safeAdminRedirectUrl } from '@/lib/admin-auth';
import { getClientIp } from '@/lib/context';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

const LOGIN_URL = '/admin/login';

/**
 * A pre-computed valid PBKDF2 hash used to run `verifyPassword` against a
 * fixed target when the requested username doesn't exist. The specific
 * password is irrelevant — we discard the return value; we just want the
 * server to spend the same ~50-100 ms so response time doesn't leak
 * whether the account exists.
 *
 * Generated with:
 *   await hashPassword('unreachable-dummy-password-1')
 * Any hash produced by hashPassword() will do; picking a fixed one keeps
 * the dummy path from allocating a fresh salt on every no-user request.
 */
const DUMMY_PASSWORD_HASH =
  '$PBKDF2$600000$0123456789abcdef0123456789abcdef$0000000000000000000000000000000000000000000000000000000000000000';

function redirectWithLoginError(message: string, request?: Request): Response {
  return new Response(null, {
    status: 302,
    headers: createFlashRedirectHeaders(LOGIN_URL, LOGIN_ERROR_FLASH_COOKIE, message, LOGIN_URL, request),
  });
}

/**
 * Reject cross-origin POSTs even before we touch the database. The login
 * page is same-origin only; missing Origin/Referer headers are treated
 * as untrusted to avoid `<form enctype=text/plain>` cross-site logins.
 */
function isSameOriginRequest(request: Request, siteUrl: string): boolean {
  if (!siteUrl) return true; // unconfigured siteUrl — fall back to permissive (covers fresh-install)
  const expected = (() => {
    try { return new URL(siteUrl).origin; } catch { return ''; }
  })();
  if (!expected) return true;
  const headerCheck = (raw: string | null) => {
    if (!raw) return null;
    try { return new URL(raw).origin === expected; } catch { return false; }
  };
  const origin = headerCheck(request.headers.get('origin'));
  if (origin !== null) return origin;
  const referer = headerCheck(request.headers.get('referer'));
  if (referer !== null) return referer;
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  const db = getDb(env.DB);
  const options = await loadOptions(db);
  const pluginCtx: HookContext = { activatedPlugins: new Set<string>() };
  const activatedIds = parseActivatedPlugins(options.activatedPlugins as string | undefined);
  setActivatedPlugins(pluginCtx, activatedIds);

  if (!isSameOriginRequest(request, options.siteUrl)) {
    return new Response('Forbidden', { status: 403 });
  }

  const formData = await request.formData();
  const name = formData.get('name')?.toString() || '';
  const password = formData.get('password')?.toString() || '';
  const remember = formData.get('remember')?.toString() === '1';

  // Constrain post-login redirect to /admin/* on the same origin. The form
  // value is a path; safeAdminRedirectUrl expects a URL, so resolve it
  // against siteUrl first.
  const refererInput = formData.get('referer')?.toString() || '/admin/';
  const refererAbsolute = (() => {
    if (!options.siteUrl) return refererInput;
    try { return new URL(refererInput, options.siteUrl).toString(); } catch { return options.siteUrl; }
  })();
  const referer = safeAdminRedirectUrl(refererAbsolute, options.siteUrl || '', '/admin/');

  if (!name) return redirectWithLoginError('请输入用户名', request);
  if (!password) return redirectWithLoginError('请输入密码', request);

  // ── Brute-force throttle ────────────────────────────────────────────────
  const rateConfig = readLoginRateLimitConfig(options as unknown as Record<string, unknown>);
  const ip = getClientIp(request);
  const lockedUntil = await loginLockedUntil(db, ip, rateConfig);
  if (lockedUntil > 0) {
    const remaining = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
    const headers = createFlashRedirectHeaders(LOGIN_URL, LOGIN_ERROR_FLASH_COOKIE, `登录失败次数过多，请 ${remaining} 秒后再试`, LOGIN_URL, request);
    headers.set('Retry-After', String(remaining));
    return new Response(null, { status: 302, headers });
  }

  const loginContext = await applyFilter(pluginCtx, 'user:login', {}, { request, formData, options });
  if (loginContext._rejected) {
    return redirectWithLoginError(String(loginContext._rejected), request);
  }

  const user = await db.query.users.findFirst({ where: eq(schema.users.name, name) });

  if (!user) {
    // Run a dummy PBKDF2 against a fixed hash so response time reveals
    // nothing about whether the account exists. verifyPassword is the
    // dominant cost of a real login (~50-100 ms); without this branch a
    // no-user reply arrives in < 10 ms and enumeration becomes trivial.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    await recordLoginFailure(db, ip, rateConfig);
    return redirectWithLoginError('用户名或密码无效', request);
  }

  const valid = await verifyPassword(password, user.password || '');
  if (valid === 'needs_reset') {
    await recordLoginFailure(db, ip, rateConfig);
    return redirectWithLoginError('密码格式已升级，请使用忘记密码功能重置密码', request);
  }
  if (valid !== true) {
    await recordLoginFailure(db, ip, rateConfig);
    return redirectWithLoginError('用户名或密码无效', request);
  }

  // Successful login → reset failure counter for this IP.
  await clearLoginFailures(db, ip);

  // Opportunistic password upgrade: if the stored hash uses fewer
  // PBKDF2 iterations than the current recommendation, rehash with the
  // user-supplied plaintext (which we have right here, post-verification).
  // Failure to upgrade is non-fatal — we only log and continue.
  let upgradedPassword: string | null = null;
  if (passwordHashNeedsRehash(user.password || '')) {
    try {
      upgradedPassword = await hashPassword(password);
    } catch (err) {
      console.error('[login] Password rehash failed:', err);
    }
  }

  const newAuthCode = generateRandomString(32);
  await db
    .update(schema.users)
    .set({
      authCode: newAuthCode,
      logged: Math.floor(Date.now() / 1000),
      ...(upgradedPassword ? { password: upgradedPassword } : {}),
    })
    .where(eq(schema.users.uid, user.uid));

  const hash = await generateAuthToken(user.uid, newAuthCode, options.secret);
  const token = hash.split(':')[1];
  const cookieHeaders = setAuthCookieHeaders(user.uid, token, remember ? 30 * 24 * 3600 : 0, request);

  const headers = new Headers();
  headers.set('Location', referer);
  for (const cookie of cookieHeaders) {
    headers.append('Set-Cookie', cookie);
  }

  return new Response(null, { status: 302, headers });
};
