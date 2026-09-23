import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { bumpTokenVersion, createUser, findUserByEmail } from '../repositories/users.ts';
import { hashPassword, verifyPassword } from '../services/auth.ts';
import { ownerOf } from '../plugins/authenticate.ts';

interface CredentialsBody {
  email: string;
  password: string;
}

const registerBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', description: 'Login identity.' },
    /* maxLength matters: scrypt hashes whatever it is handed, so an unbounded
     * password is free CPU for whoever sends it. */
    password: { type: 'string', minLength: 12, maxLength: 256 },
  },
} as const;

/* Login does not re-impose minLength — a password that predates a policy change
 * should fail with 401, not a confusing 400. */
const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', maxLength: 256 },
  },
} as const;

const tokenSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'Send as `Authorization: Bearer <token>`.' },
    expiresIn: { type: 'integer', description: 'Seconds until the token expires.' },
  },
} as const;

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } } as const;

/* A real hash of a throwaway secret, verified when the e-mail is unknown so a
 * login attempt costs the same either way and response time does not reveal
 * which addresses are registered. */
const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CredentialsBody }>('/auth/register', {
    schema: {
      tags: ['auth'],
      summary: 'Create an account',
      body: registerBodySchema,
      response: { 201: tokenSchema, 409: errorSchema },
    },
  }, async (request, reply) => {
    const user = await createUser(request.body.email, await hashPassword(request.body.password));
    if (!user) return reply.code(409).send({ error: 'email already registered' });

    return reply.code(201).send({
      token: app.jwt.sign({ sub: String(user.id), email: user.email, ver: user.tokenVersion }),
      expiresIn: config.auth.tokenTtlSeconds,
    });
  });

  app.post<{ Body: CredentialsBody }>('/auth/login', {
    schema: {
      tags: ['auth'],
      summary: 'Exchange credentials for a token',
      body: loginBodySchema,
      response: { 200: tokenSchema, 401: errorSchema },
    },
  }, async (request, reply) => {
    const user = await findUserByEmail(request.body.email);
    const matches = await verifyPassword(request.body.password, user?.passwordHash ?? DUMMY_HASH);

    /* One message for both failure modes — "no such user" tells an attacker
     * which e-mails exist. */
    if (!user || !matches) return reply.code(401).send({ error: 'invalid credentials' });

    return reply.send({
      token: app.jwt.sign({ sub: String(user.id), email: user.email, ver: user.tokenVersion }),
      expiresIn: config.auth.tokenTtlSeconds,
    });
  });
}

/* Registered inside the protected scope in app.ts, so it needs a valid token to
 * revoke one. */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/logout-all', {
    schema: {
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      summary: 'Revoke every token issued to this account',
      description:
        'Increments the account token version, so every token signed before ' +
        'this call stops verifying — including the one used to make it. Use ' +
        'after a suspected leak, and from a future password-change route.',
      response: {
        200: {
          type: 'object',
          properties: {
            tokenVersion: { type: 'integer', description: 'The new version; older tokens no longer verify.' },
          },
        },
        401: errorSchema,
      },
    },
  }, async (request, reply) => {
    const version = await bumpTokenVersion(ownerOf(request));
    if (version === null) return reply.code(401).send({ error: 'invalid or expired token' });

    return reply.send({ tokenVersion: version });
  });
}
