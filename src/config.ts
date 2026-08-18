export const config = {
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  redisURL: process.env.REDIS_URL ?? "redis://localhost:6379",
  brapi: {
    baseUrl: process.env.BRAPI_BASE_URL ?? "https://brapi.dev/api/v2" ,
    token: process.env.BRAPI_TOKEN ?? null,
    timeoutMs: Number(process.env.BRAPI_TIMEOUT_MS) || 5000,
    retryCount: Number(process.env.BRAPI_RETRY_COUNT) || 3
  },
  quoteCacheTTL: Number(process.env.QUOTE_CACHE_TTL) || 60 * 60 * 1000 // 1 hour
};