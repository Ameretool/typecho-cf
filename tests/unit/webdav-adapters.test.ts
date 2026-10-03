import { describe, it, expect } from 'vitest';
import { safeParseJSON, canonicalQuery, shortDate, amzDate } from '@/plugins/typecho-plugin-webdav/adapters';

describe('safeParseJSON', () => {
  it('wraps large integers in double quotes to preserve precision', () => {
    const input = '{"id":12345678901234567890,"name":"test"}';
    const result = safeParseJSON(input);
    expect(typeof result.id).toBe('string');
    expect(result.id).toBe('12345678901234567890');
    expect(result.name).toBe('test');
  });

  it('preserves small integers as numbers', () => {
    const result = safeParseJSON('{"count":42,"name":"x"}');
    expect(typeof result.count).toBe('number');
    expect(result.count).toBe(42);
  });

  it('handles negative large integers', () => {
    const input = '{"val":-98765432109876543210}';
    const result = safeParseJSON(input);
    expect(result.val).toBe('-98765432109876543210');
  });

  it('handles integers in arrays', () => {
    const input = '{"ids":[12345678901234567890, 98765432109876543210]}';
    const result = safeParseJSON(input);
    expect(Array.isArray(result.ids)).toBe(true);
    const ids = result.ids as string[];
    expect(typeof ids[0]).toBe('string');
    expect(ids[0]).toBe('12345678901234567890');
  });

  it('does not wrap numbers under 16 digits', () => {
    const input = '{"x":999999999999999}';
    const result = safeParseJSON(input);
    expect(typeof result.x).toBe('number');
  });

  it('passes through normal JSON unchanged', () => {
    const input = '{"name":"hello","nested":{"key":"value"}}';
    expect(safeParseJSON(input)).toEqual({ name: 'hello', nested: { key: 'value' } });
  });

  it('handles large integers followed by closing bracket', () => {
    const input = '{"ids":[12345678901234567890]}';
    const result = safeParseJSON(input);
    const ids = result.ids as string[];
    expect(ids[0]).toBe('12345678901234567890');
  });
});

describe('canonicalQuery', () => {
  it('returns empty string for empty params', () => {
    expect(canonicalQuery({})).toBe('');
  });

  it('sorts keys alphabetically', () => {
    expect(canonicalQuery({ b: '2', a: '1' })).toBe('a=1&b=2');
  });

  it('encodes special characters via encodePathSegment', () => {
    const result = canonicalQuery({ key: 'hello world' });
    expect(result).toContain('hello%20world');
  });

  it('handles multiple params', () => {
    const result = canonicalQuery({ 'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-date': '20240101T000000Z' });
    expect(result).toContain('AWS4-HMAC-SHA256');
    expect(result).toContain('20240101T000000Z');
  });
});

describe('shortDate', () => {
  it('formats as YYYYMMDD', () => {
    const d = new Date('2024-06-15T12:30:00Z');
    expect(shortDate(d)).toBe('20240615');
  });

  it('pads single-digit months and days', () => {
    const d = new Date('2024-01-05T00:00:00Z');
    expect(shortDate(d)).toBe('20240105');
  });
});

describe('amzDate', () => {
  it('formats as YYYYMMDDTHHMMSSZ', () => {
    const d = new Date('2024-06-15T12:30:45Z');
    expect(amzDate(d)).toBe('20240615T123045Z');
  });

  it('pads hours/minutes/seconds', () => {
    const d = new Date('2024-01-01T01:02:03Z');
    expect(amzDate(d)).toBe('20240101T010203Z');
  });
});
