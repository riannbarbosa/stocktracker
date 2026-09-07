/* The quote service talks to the redis singleton directly, so the tests shadow
 * the handful of commands it uses with own properties on that instance and put
 * the original descriptors back afterwards. Nothing ever connects. */

import { redisClient } from '../../src/redis/redis.ts';

export interface RecordedSet {
  key: string;
  value: string;
  options: { EX: number };
}

export interface FakeRedis {
  /** Seed with `cacheKey -> serialized quote` to prime cache hits. */
  stored: Map<string, string>;
  setCalls: RecordedSet[];
  mGetCalls: string[][];
  delCalls: string[];
  readonly execCount: number;
  setReady: (ready: boolean) => void;
  failMGet: (error: Error) => void;
  failExec: (error: Error) => void;
  failDel: (error: Error) => void;
  restore: () => void;
}

export function fakeRedis(): FakeRedis {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  const setCalls: RecordedSet[] = [];
  const mGetCalls: string[][] = [];
  const delCalls: string[] = [];
  let execCount = 0;
  let mGetError: Error | null = null;
  let execError: Error | null = null;
  let delError: Error | null = null;

  function shadow(key: string, value: unknown): void {
    if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(redisClient, key));
    Object.defineProperty(redisClient, key, { value, configurable: true, writable: true });
  }

  const tx = {
    set(key: string, value: string, options: { EX: number }) {
      setCalls.push({ key, value, options });
      return tx;
    },
    async exec() {
      execCount += 1;
      if (execError) throw execError;
      return [];
    },
  };

  shadow('isReady', true);
  shadow('mGet', async (keys: string[]) => {
    mGetCalls.push(keys);
    if (mGetError) throw mGetError;
    return keys.map((key) => stored.get(key) ?? null);
  });
  shadow('multi', () => tx);
  shadow('del', async (key: string) => {
    delCalls.push(key);
    if (delError) throw delError;
    return 1;
  });

  return {
    stored,
    setCalls,
    mGetCalls,
    delCalls,
    get execCount() {
      return execCount;
    },
    setReady(ready) {
      shadow('isReady', ready);
    },
    failMGet(error) {
      mGetError = error;
    },
    failExec(error) {
      execError = error;
    },
    failDel(error) {
      delError = error;
    },
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(redisClient, key, descriptor);
        else Reflect.deleteProperty(redisClient, key);
      }
      original.clear();
    },
  };
}
