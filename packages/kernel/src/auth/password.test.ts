import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  PasswordError,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  parseHash,
  verifyPassword,
} from './password';

// The KDF is deliberately slow, so these run at a low cost factor. What is
// under test is the encoding, the dispatch and the policy — not that scrypt
// works, which is Node's problem.
const FAST = { ln: 12, r: 8, p: 1 };

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('the same password twice', FAST);
    const b = await hashPassword('the same password twice', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('the same password twice', a)).toBe(true);
    expect(await verifyPassword('the same password twice', b)).toBe(true);
  });

  it('stores the algorithm and parameters with the hash, which is what makes them raisable', async () => {
    const hash = await hashPassword('a sufficiently long password', { ln: 12, r: 8, p: 2 });
    expect(hash).toMatch(/^\$scrypt\$ln=12,r=8,p=2\$/);

    const parsed = parseHash(hash);
    expect(parsed.algorithm).toBe('scrypt');
    expect(parsed.params).toEqual({ ln: 12, r: 8, p: 2 });
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.hash).toHaveLength(32);
  });

  it('verifies against the parameters in the hash, not the current policy', async () => {
    // The whole point of PHC encoding: a hash made under old parameters keeps
    // working after the policy is raised. Without this, raising the cost factor
    // locks every existing user out.
    const old = await hashPassword('an old but valid password', { ln: 12, r: 8, p: 1 });
    expect(await verifyPassword('an old but valid password', old)).toBe(true);
    expect(needsRehash(old, { ln: 15, r: 8, p: 3 })).toBe(true);
  });

  it('does not ask to rehash a hash that already meets policy', async () => {
    const current = await hashPassword('a current policy password', DEFAULT_PARAMS);
    expect(needsRehash(current, DEFAULT_PARAMS)).toBe(false);
  });

  it('treats an unparseable stored hash as a failed verification, not a crash', async () => {
    // A corrupt row must fail one login, not take the endpoint down for everyone.
    expect(await verifyPassword('anything', 'not-a-phc-string')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
    expect(await verifyPassword('anything', '$scrypt$ln=x,r=y,p=z$aa$bb')).toBe(false);
    expect(needsRehash('not-a-phc-string')).toBe(true);
  });

  it('rejects a bcrypt hash rather than pretending to understand it', async () => {
    const bcrypt = '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ';
    expect(await verifyPassword('anything', bcrypt)).toBe(false);
    expect(() => parseHash(bcrypt)).toThrow(PasswordError);
  });
});

describe('algorithm migration', () => {
  // The reason the hash carries its algorithm rather than being bare bytes: a
  // tenant migrated in from a system that used Argon2 signs in normally, and is
  // converted to this deployment's KDF on the way past. Nobody resets anything.
  const ARGON2 =
    '$argon2id$v=19$m=256,t=1,p=1$JD/nSpJqDvDGKDvIMKwuXQ$Rc2N1AKrqfWkNo2Ur4l4Qb3WjqQTErKUD9zW3vsOd1E';

  it('still verifies an argon2id hash', async () => {
    const parsed = parseHash(ARGON2);
    expect(parsed.algorithm).toBe('argon2id');

    // Built here rather than hardcoded, so the assertion is about dispatch
    // rather than about a magic string surviving a copy-paste.
    const { argon2idAsync } = await import('@noble/hashes/argon2.js');
    const salt = Buffer.from('a fixed sixteen!');
    const digest = Buffer.from(
      await argon2idAsync('an imported password', salt, { m: 256, t: 1, p: 1, dkLen: 32 }),
    );
    const encoded =
      `$argon2id$v=19$m=256,t=1,p=1$` +
      `${salt.toString('base64').replace(/=+$/, '')}$` +
      `${digest.toString('base64').replace(/=+$/, '')}`;

    expect(await verifyPassword('an imported password', encoded)).toBe(true);
    expect(await verifyPassword('the wrong password', encoded)).toBe(false);
  });

  it('flags every argon2id hash for upgrade, whatever its cost factor', async () => {
    // Not because argon2 is weak — it is stronger — but because this deployment
    // hashes with scrypt, and a hash it cannot produce is one it should replace
    // the moment it legitimately can.
    expect(needsRehash(ARGON2)).toBe(true);
  });

  it('hashes new passwords with scrypt, not with the legacy algorithm', async () => {
    const fresh = await hashPassword('a brand new password', FAST);
    expect(fresh.startsWith('$scrypt$')).toBe(true);
    expect(needsRehash(fresh, FAST)).toBe(false);
  });
});

describe('password policy', () => {
  it('requires length and nothing else', () => {
    // Composition rules push people towards `Password1!`; NIST stopped
    // recommending them for good reason. Length is what costs an attacker.
    expect(() => assertPasswordAcceptable('all lowercase and no symbols at all')).not.toThrow();
    expect(() => assertPasswordAcceptable('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects a password below the minimum length', () => {
    expect(() => assertPasswordAcceptable('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      PasswordError,
    );
  });

  it('caps the length, because a KDF on unbounded input is free server work', () => {
    expect(() => assertPasswordAcceptable('x'.repeat(1025))).toThrow(PasswordError);
  });

  it('enforces the policy at hash time, not only at the call site', async () => {
    await expect(hashPassword('too short')).rejects.toThrow(PasswordError);
  });
});
