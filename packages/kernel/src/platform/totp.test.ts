import { describe, expect, it } from 'vitest';

import { base32Decode, base32Encode, totpCodeAt, verifyTotp } from './totp';

/**
 * RFC 6238 Appendix B, which is why this is implemented rather than depended
 * on: the algorithm is fixed and publicly tested, so a local implementation can
 * be proved correct against the specification instead of trusted.
 *
 * The published vectors are 8 digits; this generates 6, so the last six of each
 * are compared — truncation is the final step of the algorithm, so a 6-digit
 * code is the low 6 digits of the 8-digit one.
 */
describe('TOTP', () => {
  const seed = Buffer.from('12345678901234567890', 'ascii');
  const secret = base32Encode(seed);

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    // Past 2038, which is where a 32-bit counter silently starts lying.
    [20000000000, '65353130'],
  ])('matches the RFC vector at t=%i', (seconds, expected) => {
    expect(totpCodeAt(secret, seconds * 1000)).toBe(expected.slice(-6));
  });

  it('accepts one step of clock drift either way, and no more', () => {
    const now = Date.now();
    expect(verifyTotp(secret, totpCodeAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpCodeAt(secret, now + 30_000), now)).toBe(true);
    // Two steps out. Phone clocks drift; they do not drift a minute.
    expect(verifyTotp(secret, totpCodeAt(secret, now - 90_000), now)).toBe(false);
  });

  it('refuses anything that is not six digits', () => {
    // The shape check runs before the comparison, so a malformed code can never
    // reach `timingSafeEqual` with a mismatched length and throw.
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad)).toBe(false);
    }
  });

  it('round-trips base32, including padding and lowercase', () => {
    expect(base32Decode(base32Encode(seed)).equals(seed)).toBe(true);
    expect(base32Decode(secret.toLowerCase()).equals(seed)).toBe(true);
    expect(base32Decode(`${secret}======`).equals(seed)).toBe(true);
  });
});
