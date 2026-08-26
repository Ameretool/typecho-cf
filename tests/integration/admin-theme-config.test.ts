/**
 * Integration tests for /api/admin/theme-config (GET + POST).
 *
 * Unlike the plugin-config tests, CSRF / Origin enforcement is exercised
 * through the real requireAdminAction() path (no mocks), matching the
 * admin-origin test pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { createTestDb, seedAdmin, disposeTestDb, makeAuthCookie, type TestDatabase } from '../helpers';
import { generateSecurityToken } from '@/lib/auth';
import { registerTheme } from '@/lib/theme';

let testDb: TestDatabase;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: (_d1: any) => testDb, schema: actual.schema };
});

import { GET, POST } from '@/pages/api/admin/theme-config';

const SITE = 'https://example.com';
const SECRET = 'theme-cfg-secret';
const AUTH = 'theme-cfg-auth';
const THEME = 'typecho-theme-config-api';

async function setUp() {
  testDb = await createTestDb();
  await testDb.insert(schema.options).values({ name: 'siteUrl', user: 0, value: SITE });
  await testDb.insert(schema.options).values({ name: 'installed', user: 0, value: '1' });
  await seedAdmin(testDb, { secret: SECRET, authCode: AUTH });
  registerTheme('typecho-theme-config-api', {
    id: THEME,
    name: 'Config API Fixture',
    config: {
      footerText: { type: 'text', label: 'Footer', default: 'default footer' },
      showSearch: { type: 'checkbox', label: 'Show Search', default: '1' },
      token: { type: 'password', label: 'Token', default: 'default-token' },
      providers: {
        type: 'repeatable',
        label: 'Providers',
        default: [],
        itemFields: { name: { type: 'text', label: 'Name', default: '' } },
      },
    },
  }, `/themes/${THEME}/style.css`);
}

afterEach(async () => {
  await disposeTestDb(testDb);
});

async function adminCookie() {
  const user = await testDb.query.users.findFirst();
  return await makeAuthCookie(testDb, user!.uid, AUTH, SECRET);
}

async function csrfToken() {
  const user = await testDb.query.users.findFirst();
  return await generateSecurityToken(SECRET, AUTH, user!.uid);
}

async function savedOption(): Promise<string | null> {
  const row = await testDb.query.options.findFirst({
    where: eq(schema.options.name, `theme:${THEME}`),
  });
  return row?.value ?? null;
}

describe('GET /api/admin/theme-config', () => {
  beforeEach(async () => { await setUp(); });

  it('returns 401 without auth', async () => {
    const req = new Request(`${SITE}/api/admin/theme-config?id=${THEME}`);
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(401);
  });

  it('returns defaults with masked secrets when nothing is saved', async () => {
    const cookie = await adminCookie();
    const req = new Request(`${SITE}/api/admin/theme-config?id=${THEME}`, {
      headers: { cookie },
    });
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      theme: string;
      name: string;
      values: Record<string, any>;
    };
    expect(body.theme).toBe(THEME);
    expect(body.name).toBe('Config API Fixture');
    expect(body.values.footerText).toBe('default footer');
    expect(body.values.showSearch).toBe('1');
    expect(body.values.token).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(body.values.providers).toEqual([]);
  });

  it('returns 404 for an unknown theme', async () => {
    const cookie = await adminCookie();
    const req = new Request(`${SITE}/api/admin/theme-config?id=no-such-theme`, {
      headers: { cookie },
    });
    const res = await GET({ request: req, url: new URL(req.url) } as any);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/theme-config', () => {
  beforeEach(async () => { await setUp(); });

  it('saves a JSON payload and returns masked settings', async () => {
    const cookie = await adminCookie();
    const token = await csrfToken();
    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: SITE,
          'x-csrf-token': token,
        },
        body: JSON.stringify({
          theme: THEME,
          settings: { footerText: 'custom footer', showSearch: '0', token: 'new-token' },
        }),
      }),
      locals: {},
    } as any);

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; settings: Record<string, any> };
    expect(body.success).toBe(true);
    expect(body.settings.footerText).toBe('custom footer');
    expect(body.settings.showSearch).toBe('0');
    expect(body.settings.token).toBe('__PLUGIN_CONFIG_SECRET__');
    expect(JSON.parse((await savedOption())!)).toEqual({
      footerText: 'custom footer',
      showSearch: '0',
      token: 'new-token',
      providers: [],
    });
  });

  it('saves a form payload and redirects back to the settings page', async () => {
    const cookie = await adminCookie();
    const token = await csrfToken();
    const body = new URLSearchParams({
      _: token,
      theme: THEME,
      footerText: 'from form',
      showSearch: '1',
      token: 'form-token',
      'providers[0][__typechoConfigRowId]': '0',
      'providers[0][name]': 'r2',
    }).toString();

    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
          origin: SITE,
        },
        body,
      }),
      locals: {},
    } as any);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/theme-config?id=${THEME}&saved=1`);
    const stored = JSON.parse((await savedOption())!);
    expect(stored.footerText).toBe('from form');
    expect(stored.showSearch).toBe('1');
    expect(stored.token).toBe('form-token');
    expect(stored.providers).toEqual([{ name: 'r2' }]);
  });

  it('drops undeclared keys (allowlist)', async () => {
    const cookie = await adminCookie();
    const token = await csrfToken();
    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: SITE,
          'x-csrf-token': token,
        },
        body: JSON.stringify({
          theme: THEME,
          settings: { footerText: 'x', evil: 'should-not-be-stored' },
        }),
      }),
      locals: {},
    } as any);

    expect(res.status).toBe(200);
    expect(JSON.parse((await savedOption())!)).not.toHaveProperty('evil');
  });

  it('preserves the stored secret when the placeholder is submitted', async () => {
    await testDb.insert(schema.options).values({
      name: `theme:${THEME}`,
      user: 0,
      value: JSON.stringify({ token: 'stored-secret', footerText: 'old' }),
    });
    const cookie = await adminCookie();
    const token = await csrfToken();

    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: SITE,
          'x-csrf-token': token,
        },
        body: JSON.stringify({
          theme: THEME,
          settings: { token: '__PLUGIN_CONFIG_SECRET__', footerText: 'updated' },
        }),
      }),
      locals: {},
    } as any);

    expect(res.status).toBe(200);
    const stored = JSON.parse((await savedOption())!);
    expect(stored.token).toBe('stored-secret');
    expect(stored.footerText).toBe('updated');
  });

  it('rejects a missing CSRF token', async () => {
    const cookie = await adminCookie();
    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: SITE,
        },
        body: JSON.stringify({ theme: THEME, settings: { footerText: 'x' } }),
      }),
      locals: {},
    } as any);
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin POSTs even with a valid token', async () => {
    const cookie = await adminCookie();
    const token = await csrfToken();
    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: 'https://evil.example',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ theme: THEME, settings: { footerText: 'x' } }),
      }),
      locals: {},
    } as any);
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown theme', async () => {
    const cookie = await adminCookie();
    const token = await csrfToken();
    const res = await POST({
      request: new Request(`${SITE}/api/admin/theme-config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: SITE,
          'x-csrf-token': token,
        },
        body: JSON.stringify({ theme: 'no-such-theme', settings: {} }),
      }),
      locals: {},
    } as any);
    expect(res.status).toBe(404);
  });
});
