import { afterEach, describe, expect, it, vi } from 'vitest';
import init, {
  PLUGIN_ID,
  PROVIDER,
  normalizeConfig,
  buildMailerOptions,
  buildEmailOptions,
} from './index';

// ── External mocks ──
vi.mock('@workermailer/smtp', () => ({
  WorkerMailer: { send: vi.fn() },
}));

vi.mock('@/lib/mail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mail')>();
  return { ...actual, sendMail: vi.fn() };
});

import { WorkerMailer } from '@workermailer/smtp';
import { sendMail, isValidEmail } from '@/lib/mail';

// ── Helpers ──
function collectHooks() {
  const hooks = new Map<string, Function>();
  init({
    pluginId: PLUGIN_ID,
    HookPoints: {} as any,
    addHook: (point: string, _pluginId: string, handler: Function) => {
      hooks.set(point, handler);
    },
  });
  return hooks;
}

/** 构造插件运行时读取的 options 对象（插件配置 + 站点级选项）。 */
function makeOptions(
  settings: Record<string, unknown>,
  site: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ['plugin:' + PLUGIN_ID]: JSON.stringify(settings),
    ...site,
  };
}

const fullSettings = {
  host: 'smtp.example.com',
  port: '465',
  secure: '1',
  startTls: '0',
  username: 'sender@example.com',
  password: 'secret',
  authType: 'plain',
  socketTimeoutMs: '15000',
  responseTimeoutMs: '20000',
};

const validPayload = {
  to: 'recipient@example.com',
  subject: 'Test subject',
  html: '<p>Hello</p>',
  text: 'Hello',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('hook registration', () => {
  it('registers all expected hooks', () => {
    const hooks = collectHooks();
    expect([...hooks.keys()].sort()).toEqual([
      'admin:footer',
      'admin:page',
      'mail:send',
      'plugin:config:beforeSave',
      'plugin:' + PLUGIN_ID + ':action',
      'plugin:' + PLUGIN_ID + ':action:auth',
    ].sort());
  });
});

describe('mail:send adapter', () => {
  const mailSend = () => collectHooks().get('mail:send')!;

  it('returns not-configured and does not call WorkerMailer when host is missing', async () => {
    const handler = mailSend();
    const result = await handler(null, {
      payload: validPayload,
      ctx: { options: makeOptions({}) },
    });
    expect(result).toEqual({ sent: false, provider: PROVIDER, error: 'not-configured' });
    expect(WorkerMailer.send).not.toHaveBeenCalled();
  });

  it('returns invalid-payload when payload is missing required fields', async () => {
    const handler = mailSend();
    const result = await handler(null, {
      payload: { to: 'a@b.com' },
      ctx: { options: makeOptions(fullSettings) },
    });
    expect(result).toEqual({ sent: false, provider: PROVIDER, error: 'invalid-payload' });
    expect(WorkerMailer.send).not.toHaveBeenCalled();
  });

  it('sends via WorkerMailer and returns sent:true with mapped options', async () => {
    vi.mocked(WorkerMailer.send).mockResolvedValue(undefined as any);
    const handler = mailSend();
    const result = await handler(null, {
      payload: { ...validPayload, replyTo: 'noreply@example.com', headers: { 'X-Custom': '1' } },
      ctx: {
        options: makeOptions(fullSettings, {
          mailFrom: 'blog@example.com',
          mailFromName: 'My Blog',
        }),
      },
    });

    expect(result).toEqual({ sent: true, provider: PROVIDER });
    expect(WorkerMailer.send).toHaveBeenCalledTimes(1);
    const [mailerOpts, emailOpts] = vi.mocked(WorkerMailer.send).mock.calls[0];
    expect(mailerOpts).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      startTls: false,
      authType: 'plain',
      credentials: { username: 'sender@example.com', password: 'secret' },
      socketTimeoutMs: 15000,
      responseTimeoutMs: 20000,
    });
    expect(emailOpts).toEqual({
      from: { name: 'My Blog', email: 'blog@example.com' },
      to: 'recipient@example.com',
      subject: 'Test subject',
      html: '<p>Hello</p>',
      text: 'Hello',
      reply: 'noreply@example.com',
      headers: { 'X-Custom': '1' },
    });
  });

  it('omits credentials when username is empty and from stays a plain string without fromName', async () => {
    vi.mocked(WorkerMailer.send).mockResolvedValue(undefined as any);
    const handler = mailSend();
    await handler(null, {
      payload: validPayload,
      ctx: {
        options: makeOptions({ host: 'smtp.example.com', port: '587', username: '' }),
      },
    });
    const [mailerOpts, emailOpts] = vi.mocked(WorkerMailer.send).mock.calls[0];
    expect(mailerOpts.credentials).toBeUndefined();
    expect(mailerOpts).toMatchObject({ host: 'smtp.example.com', port: 587, secure: true, startTls: false });
    expect(emailOpts.from).toBe('');
  });

  it('returns sent:false with error message when WorkerMailer.send rejects', async () => {
    vi.mocked(WorkerMailer.send).mockRejectedValue(new Error('connection refused'));
    const handler = mailSend();
    const result = await handler(null, {
      payload: validPayload,
      ctx: { options: makeOptions(fullSettings) },
    });
    expect(result).toEqual({ sent: false, provider: PROVIDER, error: 'connection refused' });
  });

  it('tolerates missing ctx/options (empty config path)', async () => {
    const handler = mailSend();
    const result = await handler(null, undefined);
    expect(result).toEqual({ sent: false, provider: PROVIDER, error: 'not-configured' });
  });
});

describe('plugin:config:beforeSave', () => {
  const validate = () => collectHooks().get('plugin:config:beforeSave')!;

  it('accepts valid config and normalizes settings', () => {
    const result = validate()({ success: true, settings: { ...fullSettings } }, {
      pluginId: PLUGIN_ID,
      settings: { ...fullSettings },
    });
    expect(result.success).toBe(true);
    expect(result.settings).toMatchObject({
      host: 'smtp.example.com',
      port: '465',
      secure: '1',
      startTls: '0',
      authType: 'plain',
      socketTimeoutMs: '15000',
      responseTimeoutMs: '20000',
    });
  });

  it('rejects empty host', () => {
    const result = validate()({ success: true, settings: { ...fullSettings, host: '  ' } }, {
      pluginId: PLUGIN_ID,
      settings: { ...fullSettings, host: '  ' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SMTP 服务器');
  });

  it('rejects invalid ports (0, 70000, non-numeric)', () => {
    for (const port of ['0', '70000', 'abc']) {
      const result = validate()({ success: true, settings: { ...fullSettings, port } }, {
        pluginId: PLUGIN_ID,
        settings: { ...fullSettings, port },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('端口');
    }
  });

  it('rejects unsupported authType', () => {
    const result = validate()({ success: true, settings: { ...fullSettings, authType: 'xoauth2' } }, {
      pluginId: PLUGIN_ID,
      settings: { ...fullSettings, authType: 'xoauth2' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('认证方式');
  });

  it('rejects negative timeout', () => {
    const result = validate()({ success: true, settings: { ...fullSettings, socketTimeoutMs: '-5' } }, {
      pluginId: PLUGIN_ID,
      settings: { ...fullSettings, socketTimeoutMs: '-5' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('ignores other plugins config', () => {
    const input = { success: true, settings: { whatever: 'x' } };
    const result = validate()(input, { pluginId: 'typecho-plugin-other', settings: { whatever: 'x' } });
    expect(result).toBe(input);
  });
});

describe('admin:page', () => {
  const page = () => collectHooks().get('admin:page')!;

  it('returns input html for unrelated slug', () => {
    const result = page()('<div>base</div>', { slug: 'other', csrfToken: 't', options: {} });
    expect(result).toBe('<div>base</div>');
  });

  it('renders config summary and test-send form for own slug', () => {
    const result = page()('', {
      slug: 'smtp-mailer',
      csrfToken: 'csrf-token',
      options: makeOptions(fullSettings),
    }) as string;
    expect(result).toContain('SMTP Mailer 设置');
    expect(result).toContain('smtp-test-send');
    expect(result).toContain('smtp.example.com');
    expect(result).toContain('csrf-token');
    expect(result).toContain('/api/admin/plugin-action');
    expect(result).toContain('已设置'); // password summary
  });

  it('escapes user-controlled config values', () => {
    const result = page()('', {
      slug: 'smtp-mailer',
      csrfToken: 't',
      options: makeOptions({ ...fullSettings, host: '"><script>alert(1)</script>' }),
    }) as string;
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>alert(1)</script>');
  });
});

describe('admin:footer', () => {
  const footer = () => collectHooks().get('admin:footer')!;

  it('injects nav item script', () => {
    const result = footer()('<div>base</div>', { activeMenu: 'smtp-mailer', user: { group: 'administrator' } }) as string;
    expect(result).toContain('nav-smtp-mailer');
    expect(result).toContain('/admin/plugin/smtp-mailer');
  });
});

describe('plugin action: test-send', () => {
  const actionAuth = () => collectHooks().get('plugin:' + PLUGIN_ID + ':action:auth')!;
  const action = () => collectHooks().get('plugin:' + PLUGIN_ID + ':action')!;

  it('declares administrator as the required role', () => {
    expect(actionAuth()('contributor', { action: 'test-send' })).toBe('administrator');
  });

  it('leaves unrelated actions unhandled', async () => {
    const input = { handled: false };
    const result = await action()(input, { action: 'other' });
    expect(result).toBe(input);
  });

  it('rejects invalid recipient email', async () => {
    const result = await action()({ handled: false }, { action: 'test-send', payload: { to: 'not-an-email' } });
    expect(result).toEqual({ handled: true, success: false, error: '收件邮箱格式不正确' });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends a test mail through sendMail and reports success', async () => {
    vi.mocked(sendMail).mockResolvedValue({ sent: true, provider: 'smtp-mailer' });
    const result = await action()({ handled: false }, {
      action: 'test-send',
      payload: { to: 'admin@example.com' },
      options: makeOptions(fullSettings, { title: 'My Blog' }),
      request: new Request('https://example.com/api/admin/plugin-action'),
    });

    expect(result).toEqual({ handled: true, success: true, sent: true, provider: 'smtp-mailer' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [pluginCtx, payload, ctx] = vi.mocked(sendMail).mock.calls[0];
    expect(pluginCtx).toEqual({ activatedPlugins: new Set([PLUGIN_ID]) });
    expect(payload).toMatchObject({ to: 'admin@example.com' });
    expect(payload.subject).toContain('测试邮件');
    expect(ctx).toMatchObject({ reason: 'test' });
    expect(ctx.options).toMatchObject({ title: 'My Blog' });
  });

  it('reports failure when sendMail returns sent:false', async () => {
    vi.mocked(sendMail).mockResolvedValue({ sent: false, provider: 'smtp-mailer', error: 'auth failed' });
    const result = await action()({ handled: false }, {
      action: 'test-send',
      payload: { to: 'admin@example.com' },
      options: makeOptions(fullSettings),
    });
    expect(result).toEqual({ handled: true, success: false, sent: false, provider: 'smtp-mailer', error: 'auth failed' });
  });
});

describe('helpers', () => {
  it('normalizeConfig applies defaults for missing keys', () => {
    const cfg = normalizeConfig(undefined);
    expect(cfg.host).toBe('');
    expect(cfg.port).toBe(465);
    expect(cfg.secure).toBe(true);
    expect(cfg.startTls).toBe(false);
    expect(cfg.authType).toBe('plain');
  });

  it('normalizeConfig coerces string values', () => {
    const cfg = normalizeConfig({
      host: ' smtp.qq.com ',
      port: '587',
      secure: '0',
      startTls: '1',
      username: 'u',
      password: 'p',
      authType: 'login',
    });
    expect(cfg.host).toBe('smtp.qq.com');
    expect(cfg.port).toBe(587);
    expect(cfg.secure).toBe(false);
    expect(cfg.startTls).toBe(true);
    expect(cfg.authType).toBe('login');
  });

  it('buildMailerOptions / buildEmailOptions map fields correctly', () => {
    const cfg = normalizeConfig(fullSettings);
    const mailer = buildMailerOptions(cfg);
    expect(mailer).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      startTls: false,
      credentials: { username: 'sender@example.com', password: 'secret' },
    });
    const email = buildEmailOptions(
      { to: 'a@b.com', toName: 'Alice', subject: 'S', replyTo: 'r@x.com', html: '<b>x</b>', text: 'x' },
      'from@x.com',
      'Sender',
    );
    expect(email).toEqual({
      from: { name: 'Sender', email: 'from@x.com' },
      to: { name: 'Alice', email: 'a@b.com' },
      subject: 'S',
      html: '<b>x</b>',
      text: 'x',
      reply: 'r@x.com',
    });
  });
});
