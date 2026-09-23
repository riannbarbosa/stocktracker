export interface User {
  id: number;
  email: string;
  tokenVersion: number;
  createdAt: string;
}

/* What the authenticate hook puts on the request. Deliberately does not carry
 * the password hash — the only function that returns it is findUserByEmail, and
 * only the login path calls it. */
export interface AuthenticatedUser {
  id: number;
  email: string;
  /* Checked against the database on every request; a mismatch means the token
   * was revoked. */
  tokenVersion: number;
}

/* The claims this API signs. `sub` is the user id as a string, per JWT
 * convention; @fastify/jwt adds `iat` and `exp` itself. */
export interface JwtPayload {
  sub: string;
  email: string;
  ver: number;
}

/* Teaches @fastify/jwt what this API signs and what request.user becomes. The
 * `user` shape is produced by the formatUser option in app.ts, so the two must
 * stay in step. */
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: AuthenticatedUser;
  }
}
