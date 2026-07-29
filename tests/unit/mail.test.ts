import { describe, it, expect, vi } from 'vitest';
import { sendMail, type MailPayload, type MailContext, type MailResult } from '@/lib/mail';

// mock plugin.ts applyFilterSafely — the mail module delegates to it
vi.mock('@/lib/plugin', () => ({
  applyFilterSafely: vi.fn(),
}));

import { applyFilterSafely } from '@/lib/plugin';

function makeCtx(overrides: Partial<Record<string, unknown>> = {}): { ctx: MailContext; pluginCtx: any } {
  return {
    pluginCtx: { activatedPlugins: new Set<string>() },
    ctx: {
      options: { mailEnabled: true, mailFrom: 'blog@example.com', ...overrides },
      reason: 'test',
    },
  };
}

const payload: MailPayload = {
  to: 'user@example.com',
  subject: 'Test',
  html: '<p>Hello</p>',
};

describe('sendMail', () => {
  it('returns disabled when mailEnabled=0', async () => {
    const { pluginCtx, ctx } = makeCtx({ mailEnabled: false });
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toContain('mailEnabled');
  });

  it('returns invalid-from when from is missing', async () => {
    const { pluginCtx, ctx } = makeCtx({ mailFrom: undefined });
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toContain('from');
  });

  it('returns invalid-from when from is not an email', async () => {
    const { pluginCtx, ctx } = makeCtx({ mailFrom: 'not-an-email' });
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toContain('from');
  });

  it('returns no-adapter when no plugin handles mail:send', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterSafely).mockResolvedValue(null);
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toBe('no-adapter');
  });

  it('returns sent:true when a plugin handles successfully', async () => {
    const { pluginCtx, ctx } = makeCtx();
    const adapterResult: MailResult = { sent: true, provider: 'resend' };
    vi.mocked(applyFilterSafely).mockResolvedValue(adapterResult);
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(true);
    expect(r.provider).toBe('resend');
  });

  it('passes payload and ctx to the plugin filter', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterSafely).mockResolvedValue(null);
    await sendMail(pluginCtx, { ...payload, replyTo: 'noreply@x.com' }, ctx);
    expect(applyFilterSafely).toHaveBeenCalledWith(
      pluginCtx,
      'mail:send',
      null,
      expect.objectContaining({
        payload: expect.objectContaining({ replyTo: 'noreply@x.com' }),
        ctx: expect.objectContaining({ reason: 'test' }),
      }),
    );
  });

  it('forwards error from failing adapter', async () => {
    const { pluginCtx, ctx } = makeCtx();
    vi.mocked(applyFilterSafely).mockResolvedValue({ sent: false, provider: 'resend', error: 'rate-limited' });
    const r = await sendMail(pluginCtx, payload, ctx);
    expect(r.sent).toBe(false);
    expect(r.error).toBe('rate-limited');
  });
});
