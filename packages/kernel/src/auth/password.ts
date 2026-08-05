/**
 * Password hashing.
 *
 * **scrypt, from Node's own crypto module.** This file originally used pure-JS
 * Argon2id, and the choice was changed after measuring it rather than after
 * arguing about it:
 *
 * | Implementation                    | Cost per hash | Blocks the event loop |
 * |-----------------------------------|---------------|-----------------------|
 * | argon2id, pure JS, 19 MiB         | 483 ms        | **yes**               |
 * | scrypt, Node native, 32 MiB       | 246 ms        | no                    |
 *
 * The blocking is the part that matters. `crypto.scrypt` is C, and it runs on
 * the libuv threadpool: sixteen concurrent hashes finish in about a second of
 * wall time and the API keeps serving everyone else meanwhile. The pure-JS
 * alternative stalls the whole process for half a second per attempt, which
 * turns the one unauthenticated endpoint in the system into a denial-of-service
 * amplifier — on the free-tier single box this is deployed to, that is not
 * theoretical.
 *
 * Argon2id is the stronger primitive and OWASP prefers it, but that comparison
 * assumes a NATIVE argon2. A native binding needs a toolchain or prebuilt
 * binaries on every platform this runs on, and a password hash that fails to
 * build is an authentication system that will not start. scrypt is on OWASP's
 * approved list, ships inside Node, and needs nothing installed.
 *
 * Hashes are PHC strings, so the ALGORITHM AND PARAMETERS TRAVEL WITH THE HASH:
 *
 *     $scrypt$ln=15,r=8,p=3$<salt>$<hash>
 *
 * That is what makes the cost raisable later, and it is why `verifyPassword`
 * still understands `$argon2id$`: if a native binding becomes acceptable, or a
 * tenant is migrated in from a system that used Argon2, those hashes keep
 * working and are silently upgraded on the owner's next successful sign-in.
 * Without the encoding, changing anything invalidates every stored password, so
 * in practice nobody ever changes anything.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { argon2idAsync } from '@noble/hashes/argon2.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. Memory used is roughly 128 * 2^ln * r bytes. */
  ln: number;
  /** Block size. */
  r: number;
  /** Parallelism. */
  p: number;
}

/**
 * OWASP's scrypt baseline, in the 32 MiB variant.
 *
 * Their configurations — 2^17/8/1, 2^16/8/2, **2^15/8/3**, 2^14/8/5 — are
 * considered equivalent work. The 32 MiB one is chosen over the 128 MiB one
 * deliberately: memory is the scarce resource on the target box, and a login
 * storm that allocates 128 MiB per attempt is a denial of service against
 * yourself no matter how fast each hash is.
 */
export const DEFAULT_PARAMS: ScryptParams = { ln: 15, r: 8, p: 3 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** Node refuses a scrypt call whose working set exceeds maxmem, so it is set
 *  generously above the largest parameters this file will ever produce. */
const MAX_MEM = 512 * 1024 * 1024;

export class PasswordError extends Error {
  override readonly name = 'PasswordError';
}

const b64 = (buffer: Uint8Array): string =>
  Buffer.from(buffer).toString('base64').replace(/=+$/, '');

const unb64 = (value: string): Buffer => Buffer.from(value, 'base64');

/**
 * The minimum this system will accept.
 *
 * Length only, deliberately. Composition rules ("one uppercase, one symbol")
 * measurably push people towards `Password1!` and NIST no longer recommends
 * them; length is what actually costs an attacker anything.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  // The KDF is unbounded in input length, and an unbounded input is a cheap way
  // to make the server do arbitrary work on an unauthenticated endpoint.
  if (password.length > 1024) {
    throw new PasswordError('Password must be at most 1024 characters.');
  }
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  assertPasswordAcceptable(password);

  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, HASH_BYTES, {
    N: 2 ** params.ln,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });

  return `$scrypt$ln=${params.ln},r=${params.r},p=${params.p}$${b64(salt)}$${b64(hash)}`;
}

export type ParsedHash =
  | { algorithm: 'scrypt'; params: ScryptParams; salt: Buffer; hash: Buffer }
  | {
      algorithm: 'argon2id';
      params: { m: number; t: number; p: number };
      version: number;
      salt: Buffer;
      hash: Buffer;
    };

const SCRYPT_RE = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const ARGON2_RE =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function parseHash(encoded: string): ParsedHash {
  const scryptMatch = SCRYPT_RE.exec(encoded);
  if (scryptMatch) {
    return {
      algorithm: 'scrypt',
      params: {
        ln: Number(scryptMatch[1]),
        r: Number(scryptMatch[2]),
        p: Number(scryptMatch[3]),
      },
      salt: unb64(scryptMatch[4]!),
      hash: unb64(scryptMatch[5]!),
    };
  }

  const argonMatch = ARGON2_RE.exec(encoded);
  if (argonMatch) {
    return {
      algorithm: 'argon2id',
      version: Number(argonMatch[1]),
      params: {
        m: Number(argonMatch[2]),
        t: Number(argonMatch[3]),
        p: Number(argonMatch[4]),
      },
      salt: unb64(argonMatch[5]!),
      hash: unb64(argonMatch[6]!),
    };
  }

  throw new PasswordError('Stored password hash is not in a recognised PHC format.');
}

/**
 * Verifies a password against a stored hash, whichever algorithm made it.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupt row
 * must fail that one login, not take the endpoint down for everyone. The
 * comparison is timing-safe, though the far larger timing signal — whether the
 * user exists at all — is handled by the login service, not here.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(encoded);
  } catch {
    return false;
  }

  let computed: Buffer;
  if (parsed.algorithm === 'scrypt') {
    computed = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: 2 ** parsed.params.ln,
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: MAX_MEM,
    });
  } else {
    computed = Buffer.from(
      await argon2idAsync(password, parsed.salt, {
        m: parsed.params.m,
        t: parsed.params.t,
        p: parsed.params.p,
        dkLen: parsed.hash.length,
      }),
    );
  }

  if (computed.length !== parsed.hash.length) return false;
  return timingSafeEqual(computed, parsed.hash);
}

/**
 * True when a stored hash is behind current policy and should be replaced.
 *
 * Any Argon2 hash qualifies, because this deployment hashes with scrypt — that
 * is how a migrated tenant's passwords are converted without ever asking anyone
 * to reset one. Checked on every successful login, the only moment the plaintext
 * is available to re-hash with; any other upgrade strategy needs a password
 * reset, which is why systems that skip it never raise their cost factor.
 */
export function needsRehash(encoded: string, params: ScryptParams = DEFAULT_PARAMS): boolean {
  try {
    const parsed = parseHash(encoded);
    if (parsed.algorithm !== 'scrypt') return true;
    return (
      parsed.params.ln < params.ln ||
      parsed.params.r < params.r ||
      parsed.params.p < params.p
    );
  } catch {
    // Unparseable means it cannot be trusted and must be replaced.
    return true;
  }
}
