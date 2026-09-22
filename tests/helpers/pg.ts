/* The repositories and the poller talk to the pg pool singleton directly, so the
 * tests shadow the two entry points they use (`query`, and `connect` for the
 * advisory-lock client) and put the original descriptors back afterwards.
 * Nothing ever connects. Mirrors the approach in ./redis.ts. */

import { pool } from '../../src/db/pool.ts';

export interface RecordedQuery {
  sql: string;
  params: unknown[];
  /** Whether it went through the pool or a client checked out with connect(). */
  via: 'pool' | 'client';
}

export interface QueryResult {
  rows?: unknown[];
  rowCount?: number;
}

export type QueryHandler = (sql: string, params: unknown[], index: number) => QueryResult;

export interface FakePool {
  /** Every query issued while the fake was installed, in order. */
  queries: RecordedQuery[];
  /** How many times a checked-out client was released. */
  readonly releaseCount: number;
  /** Reply with one queued result per query; the last entry repeats. */
  results: (queued: QueryResult[]) => void;
  /** Full control: derive the result from the sql, params and call index. */
  handle: (handler: QueryHandler) => void;
  failQuery: (error: Error) => void;
  failConnect: (error: Error) => void;
  restore: () => void;
}

/** Finds the first recorded query whose sql contains `needle`. */
export function queryMatching(queries: RecordedQuery[], needle: string): RecordedQuery | undefined {
  return queries.find((query) => query.sql.includes(needle));
}

export function fakePool(): FakePool {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const queries: RecordedQuery[] = [];
  let releaseCount = 0;
  let handler: QueryHandler = () => ({ rows: [] });
  let queryError: Error | null = null;
  let connectError: Error | null = null;

  function shadow(key: string, value: unknown): void {
    if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(pool, key));
    Object.defineProperty(pool, key, { value, configurable: true, writable: true });
  }

  function run(via: 'pool' | 'client', sql: string, params: unknown[]): QueryResult {
    queries.push({ sql, params, via });
    if (queryError) throw queryError;
    const result = handler(sql, params, queries.length - 1);
    const rows = result.rows ?? [];
    return { rows, rowCount: result.rowCount ?? rows.length };
  }

  shadow('query', async (sql: string, params: unknown[] = []) => run('pool', sql, params));
  shadow('connect', async () => {
    if (connectError) throw connectError;
    return {
      query: async (sql: string, params: unknown[] = []) => run('client', sql, params),
      release: () => {
        releaseCount += 1;
      },
    };
  });

  return {
    queries,
    get releaseCount() {
      return releaseCount;
    },
    results(queued) {
      handler = (_sql, _params, index) => queued[Math.min(index, queued.length - 1)] ?? {};
    },
    handle(next) {
      handler = next;
    },
    failQuery(error) {
      queryError = error;
    },
    failConnect(error) {
      connectError = error;
    },
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(pool, key, descriptor);
        else Reflect.deleteProperty(pool, key);
      }
      original.clear();
    },
  };
}
