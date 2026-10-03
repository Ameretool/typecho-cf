import { describe, expect, it } from 'vitest';
import { buildGravatarUrl, createGravatarHash } from '@/lib/gravatar';

describe('gravatar helpers', () => {
  it('hashes trimmed lowercase email addresses with MD5', async () => {
    await expect(createGravatarHash(' MyEmailAddress@example.com ')).resolves.toBe(
      '0bc83cb571cd1c50ba6f3e8a78ef1346',
    );
  });

  it('builds avatar URLs with the email hash in the path', async () => {
    const url = await buildGravatarUrl(' MyEmailAddress@example.com ', {
      defaultImage: 'identicon',
      size: 40,
      rating: 'G',
    });

    expect(url).toBe(
      'https://seccdn.libravatar.org/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?d=identicon&s=40&r=G',
    );
  });

  it('keeps the default avatar URL valid when no email exists', async () => {
    await expect(buildGravatarUrl('', { defaultImage: 'mp', size: 220 })).resolves.toBe(
      'https://seccdn.libravatar.org/avatar/?d=mp&s=220',
    );
  });
});
