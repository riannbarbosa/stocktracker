import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import type { JwtPayload } from '../../src/types/auth.ts';
import { hashPassword } from '../../src/services/auth.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';

const PASSWORD = 'a-long-enough-password';

function userRow(passwordHash: string) {
  return {
    id: '42',
    email: 'trader@example.test',
    password_hash: passwordHash,
    token_version: 0,
    created_at: new Date('2026-09-04T20:06:00.000Z'),
  };
}

describe('routes/auth', () => {
  let app: FastifyInstance;
  let pg: FakePool;
  let hash: string;

  beforeEach(async () => {
    pg = fakePool();
    app = await buildApp({ logger: false });
    await app.ready();
    hash = await hashPassword(PASSWORD);
  });

  afterEach(async () => {
    await app.close();
    pg.restore();
  });

  describe('POST /auth/register', () => {
    it('creates the account and returns a usable token', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 201);
      const body = response.json() as { token: string; expiresIn: number };
      assert.equal(body.expiresIn, 3600);

      /* app.jwt.verify returns the raw claims; formatUser only runs on
       * request.jwtVerify(), which is covered by the round trip below. */
      const claims = app.jwt.verify<JwtPayload>(body.token);
      assert.equal(claims.sub, '42');
      assert.equal(claims.email, 'trader@example.test');
    });

    /* The point of the whole flow: a token from register is accepted by a
     * protected route, and formatUser turns `sub` into the owner id the
     * repository is scoped by. */
    it('issues a token a protected route accepts, scoped to the new user', async () => {
      pg.handle((sql) => {
        if (sql.includes('INSERT INTO users')) return { rows: [userRow(hash)] };
        if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
        return { rows: [] };
      });

      const registered = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });
      const { token } = registered.json() as { token: string };

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        queryMatching(pg.queries, 'FROM watchlist')?.params,
        [42],
        'the query is scoped by the id carried in the token',
      );
    });

    it('never stores the password itself', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      const insert = queryMatching(pg.queries, 'INSERT INTO users');
      assert.ok(insert);
      assert.equal(insert.params[0], 'trader@example.test');
      assert.notEqual(insert.params[1], PASSWORD, 'the plaintext reached the database');
      assert.match(String(insert.params[1]), /^scrypt\$/);
    });

    it('lower-cases the address so it cannot be registered twice by casing', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'Trader@Example.TEST', password: PASSWORD },
      });

      assert.equal(queryMatching(pg.queries, 'INSERT INTO users')?.params[0], 'trader@example.test');
    });

    /* ON CONFLICT DO NOTHING returns no row; the route turns that into a 409
     * rather than sniffing SQLSTATE. */
    it('answers 409 when the address is taken', async () => {
      pg.results([{ rows: [] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: 'email already registered' });
    });

    it('rejects a short password and a malformed address', async () => {
      for (const payload of [
        { email: 'trader@example.test', password: 'short' },
        { email: 'not-an-email', password: PASSWORD },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/auth/register', payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(pg.queries.length, 0, 'nothing reached the database');
    });
  });

  describe('POST /auth/login', () => {
    it('returns a token for the right password', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 200);
      const claims = app.jwt.verify<JwtPayload>((response.json() as { token: string }).token);
      assert.equal(claims.sub, '42');
    });

    it('answers 401 for the wrong password', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'trader@example.test', password: 'not-the-password' },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid credentials' });
    });

    /* Same status and same body for an unknown address as for a wrong password,
     * so the endpoint cannot be used to discover which e-mails are registered. */
    it('answers 401 identically for an unknown address', async () => {
      pg.results([{ rows: [] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid credentials' });
    });
  });

  describe('POST /auth/logout-all', () => {
    function tokenFor(version: number): string {
      return app.jwt.sign({ sub: '42', email: 'trader@example.test', ver: version });
    }

    it('needs a token of its own', async () => {
      const response = await app.inject({ method: 'POST', url: '/auth/logout-all' });

      assert.equal(response.statusCode, 401);
      assert.equal(pg.queries.length, 0, 'nothing reached the database');
    });

    it('bumps the version and reports the new one', async () => {
      pg.handle((sql) =>
        sql.includes('UPDATE users')
          ? { rows: [{ token_version: 1 }] }
          : { rows: [{ token_version: 0 }] },
      );

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { tokenVersion: 1 });
      assert.deepEqual(queryMatching(pg.queries, 'UPDATE users')?.params, [42]);
    });

    /* The point of the whole mechanism: a signature that still verifies is no
     * longer enough once the stored version has moved on. */
    it('stops a still-unexpired token from working afterwards', async () => {
      pg.handle(() => ({ rows: [{ token_version: 1 }] }));

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid or expired token' });
      assert.equal(queryMatching(pg.queries, 'FROM watchlist'), undefined, 'the handler still ran');
    });

    it('keeps accepting a token signed with the current version', async () => {
      pg.handle((sql) =>
        sql.includes('token_version') ? { rows: [{ token_version: 1 }] } : { rows: [] },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(1)}` },
      });

      assert.equal(response.statusCode, 200);
    });

    /* A deleted account reads back as no row at all, which has to fail closed. */
    it('rejects a token belonging to a user that no longer exists', async () => {
      pg.handle(() => ({ rows: [] }));

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 401);
    });
  });

  describe('openapi spec', () => {
    it('leaves the auth routes public and marks the rest as bearer-protected', () => {
      const paths = app.swagger().paths ?? {};
      const security = (path: string, method: string) =>
        (paths[path] as Record<string, { security?: unknown[] }> | undefined)?.[method]?.security;

      assert.equal(security('/auth/login', 'post'), undefined, 'login must not require a token');
      assert.deepEqual(security('/alerts', 'get'), [{ bearerAuth: [] }]);
      assert.deepEqual(security('/watchlist', 'get'), [{ bearerAuth: [] }]);
    });
  });
});
