import { createClient } from 'redis';
import { config } from '../config.ts';

type RedisClientType = ReturnType<typeof createClient>;

function reconnectStrategy(retries: number, cause: Error): number {
  const delay = Math.min(2 ** retries * 50, config.redis.reconnectMaxDelayMs);
  const retryIn = delay + Math.floor(Math.random() * 200);
  const reason = cause.message || (cause as NodeJS.ErrnoException).code || cause.name;
  console.warn(`Redis reconnect attempt ${retries + 1} in ${retryIn}ms: ${reason}`);
  return retryIn;
}

const client = createClient({
    url: config.redis.url,
    socket: {
        connectTimeout: config.redis.connectTimeoutMs,
        reconnectStrategy
    }
});

client.on('error', (err: Error) => {
    console.error('Redis Client Error:', err.message || (err as NodeJS.ErrnoException).code || err.name);
});


export async function connectRedis(): Promise<RedisClientType> {
  await client.connect();
  return client;
}

export function isRedisReady(): boolean {
  return client.isReady;
}

export async function disconnectRedis(): Promise<void> {
  if (!client.isOpen) return;
  await client.close();
}


export { client as redisClient };
