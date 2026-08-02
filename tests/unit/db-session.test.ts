import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';

describe('getDb D1 Sessions API integration', () => {
  it('creates a fresh unconstrained session for every request bootstrap', () => {
    const sessions = [
      { prepare: vi.fn(), batch: vi.fn() },
      { prepare: vi.fn(), batch: vi.fn() },
    ] as unknown as D1Database[];
    const binding = {
      withSession: vi.fn(() => sessions.shift()!),
    } as unknown as D1Database;

    const first = getDb(binding);
    const second = getDb(binding);

    expect(first).not.toBe(second);
    expect(binding.withSession).toHaveBeenCalledTimes(2);
    expect(binding.withSession).toHaveBeenNthCalledWith(1, 'first-unconstrained');
    expect(binding.withSession).toHaveBeenNthCalledWith(2, 'first-unconstrained');
  });
});
