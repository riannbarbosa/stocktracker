import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashPassword, verifyPassword } from '../../src/services/auth.ts';

describe('services/auth password hashing', () => {
  it('verifies the password it hashed', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  /* A random salt per hash is what stops two users with the same password from
   * sharing a value, and stops a precomputed table from working. */
  it('produces a different hash every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);

    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same password', a), true);
    assert.equal(await verifyPassword('same password', b), true);
  });

  it('tags the stored value with its scheme, so a later algorithm can be told apart', async () => {
    const hash = await hashPassword('whatever');
    const [scheme, salt, derived] = hash.split('$');

    assert.equal(scheme, 'scrypt');
    assert.ok(salt && derived, 'salt and hash are both present');
  });

  it('returns false instead of throwing on a stored value it cannot parse', async () => {
    for (const stored of ['', 'garbage', 'scrypt$onlysalt', 'argon2$salt$hash']) {
      assert.equal(await verifyPassword('whatever', stored), false, `stored: ${stored}`);
    }
  });
});
