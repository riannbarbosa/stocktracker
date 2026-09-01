function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    connectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000,
    reconnectMaxDelayMs: Number(process.env.REDIS_RECONNECT_MAX_DELAY_MS) || 3000
  },

  postgres: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stocktracker",
    poolMax: num(process.env.PG_POOL_MAX, 10),
    connectionTimeoutMs: num(process.env.PG_CONNECTION_TIMEOUT_MS, 5000),
    idleTimeoutMs: num(process.env.PG_IDLE_TIMEOUT_MS, 30000),
    startupRetries: num(process.env.PG_STARTUP_RETRIES, 10),
    startupRetryDelayMs: num(process.env.PG_STARTUP_RETRY_DELAY_MS, 1000),
  },
  brapi: {
    baseUrl: process.env.BRAPI_BASE_URL ?? "https://brapi.dev/api/v2" ,
    token: process.env.BRAPI_TOKEN ?? null,
    timeoutMs: Number(process.env.BRAPI_TIMEOUT_MS) || 5000,
    retryCount: Number(process.env.BRAPI_RETRY_COUNT) || 3,
    retryBaseDelayMs: Number(process.env.BRAPI_RETRY_BASE_DELAY_MS) || 1000
  },
  alerts : {
    pollerEnabled: bool(process.env.ALERTS_POLLER_ENABLED, true),
    pollerIntervalMs: Number(process.env.ALERTS_POLLER_INTERVAL_MS) || 60000, // 1 minute
    batchSize: Number(process.env.ALERTS_BATCH_SIZE) || 100,
    lockKey: process.env.ALERTS_LOCK_KEY ?? "alerts_poller_lock",
  },
  db: {
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stocktracker",
    maxPoolSize: Number(process.env.DB_MAX_POOL_SIZE) || 10,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30000,
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 5000,
  },
  quoteCacheTTL: Number(process.env.QUOTE_CACHE_TTL) ||  60 // 1 hour
};
