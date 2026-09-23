import type { FastifyReply, FastifyRequest } from 'fastify';
import { currentTokenVersion } from '../repositories/users.ts';

/* onRequest hook. Returning the reply short-circuits the request, so a handler
 * inside the protected scope only ever runs with request.user set.
 *
 * jwtVerify() reads the Authorization header, checks the signature against the
 * secret registered in app.ts and rejects an expired exp, then runs formatUser
 * to produce request.user. */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (!request.headers.authorization) {
    return reply.code(401).send({ error: 'missing bearer token' });
  }

  try {
    await request.jwtVerify();
  } catch {
    /* Every other failure collapses into one message on purpose: telling the
     * caller a token is "expired" rather than "invalid" confirms that their
     * forged signature was otherwise well formed. */
    return reply.code(401).send({ error: 'invalid or expired token' });
  }

  /* A signature alone cannot be revoked, so the version the token was signed
   * with is compared against the current one. POST /auth/logout-all bumps it,
   * and a deleted user reads back as null. This is the one database round trip
   * that stateless verification otherwise avoids. */
  const current = await currentTokenVersion(request.user!.id);
  if (current === null || current !== request.user!.tokenVersion) {
    return reply.code(401).send({ error: 'invalid or expired token' });
  }

  return undefined;
}

/* request.user is optional in the type because public routes exist too. Inside
 * the protected scope the hook guarantees it, and this turns a wiring mistake
 * (a route registered outside that scope) into a loud failure instead of a
 * silently undefined owner reaching the SQL. */
export function ownerOf(request: FastifyRequest): number {
  if (!request.user) {
    throw new Error('route is not registered inside the authenticated scope');
  }
  return request.user.id;
}
