/**
 * TOTP (RFC 6238), implemented rather than depended on.
 *
 * Forty lines of HMAC and base32 against a new supply-chain dependency in the
 * one place where a compromised package would be worst: the second factor
 * guarding every customer's data. The algorithm has not changed since 2011 and
 * every authenticator app implements the same defaults (SHA-1, 6 digits, 30
 * seconds) — SHA-1 here is not a security weakness but a compatibility
 * requirement, since HMAC-SHA1 is unaffected by SHA-1's collision problems and
 * the alternatives are not universally supported by the apps people actually
 * have on their phones.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One, so a code is valid for at most 90 seconds. Phone clocks drift and people
 * type slowly; zero tolerance produces "the code is wrong" for a correct code,
 * which teaches people to distrust the second factor. Wider than one starts
 * meaningfully extending the window a shoulder-surfed code stays usable.
 */
const DRIFT_STEPS = 1;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The issuer appears twice — as a label prefix and as a parameter — which looks
 * redundant and is not: older apps read only the prefix, newer ones only the
 * parameter, and an account that shows up as a bare email address among a
 * dozen others is one nobody can identify later.
 */
export function totpUri(secret: string, account: string, issuer = 'Aerolith Platform'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function totpCodeAt(secret: string, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  const key = base32Decode(secret);

  // The counter as a 64-bit big-endian integer. `writeBigUInt64BE` rather than
  // two 32-bit halves, which is the usual source of a subtle bug past 2038.
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();
  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks
  // where to read the 4-byte window from.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Whether `code` is valid now, allowing for clock drift.
 *
 * Compared with `timingSafeEqual`. A string `===` leaks, through timing, how
 * many leading digits were right — which turns a 1-in-a-million guess into a
 * six-times-ten guess for an attacker who can measure it.
 */
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const candidate = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;

  let matched = false;
  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step += 1) {
    const expected = totpCodeAt(secret, now + step * PERIOD_SECONDS * 1000);
    // No early return: comparing every step regardless keeps the work constant
    // whether the match was the first candidate or the last.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) matched = true;
  }
  return matched;
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  // Padding and lowercase are both common in secrets people paste in by hand.
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`"${character}" is not valid base32.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
