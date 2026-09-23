/* Password hashing only. Token signing lives with @fastify/jwt on the app
 * instance, which keeps this module free of any framework import and unit
 * testable on its own. */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/* Stored as scheme$salt$hash so a later move to argon2 is detected by the
 * prefix instead of guessed, and existing hashes keep verifying meanwhile. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(plain, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const derived = await scrypt(plain, Buffer.from(salt, 'base64url'), KEY_LENGTH);
  const expectedBytes = Buffer.from(expected, 'base64url');

  /* timingSafeEqual throws on a length mismatch, so that is checked first. */
  if (derived.length !== expectedBytes.length) return false;
  return timingSafeEqual(derived, expectedBytes);
}
