import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';

describe('getDb D1 Sessions API integration', () => {
  it('creates one unconstrained session per binding for read-replica routing', () => {
    const session = { prepare: vi.fn(), batch: vi.fn() } as unknown as D1Database;
    const binding = {
      withSession: vi.fn(() => session),
    } as unknown as D1Database;

    const first = getDb(binding);
    const second = getDb(binding);

    expect(first).toBe(second);
    expect(binding.withSession).toHaveBeenCalledOnce();
    expect(binding.withSession).toHaveBeenCalledWith('first-unconstrained');
  });
});
