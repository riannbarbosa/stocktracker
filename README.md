# Stocktracker API

REST API serving B3 (Brazilian stock exchange) quotes, fetched from
[brapi.dev](https://brapi.dev) and cached in Redis.

Built with Fastify 5 on Node 22, running the TypeScript sources directly via
native type stripping — there is no build step.

## Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node 22 (native `.ts` type stripping, no transpile step) |
| Framework | Fastify 5 + `@fastify/swagger` / `swagger-ui` |
| Cache | Redis 7 (`redis` v6 client) |  
| Database | Postgres 16 (`pg` pool, used by the readiness probe) |
| Upstream | brapi.dev |
| Package manager | Yarn 4 (PnP locally, node-modules in the image) |
| Tests | `node --test` |

## Quick start

### Docker (recommended)

```bash
cp .env.example .env    # then edit if you have a brapi token
make up                 # docker compose up --build -d
```

The API listens on `http://localhost:3000`, Swagger UI on
`http://localhost:3000/docs`.

If Docker isn't installed, `make docker-install` handles it on Debian/Ubuntu
(apt) and Fedora (dnf).

### Local (without containers)

Redis and Postgres still need to be reachable — the easiest path is to start
just those two from compose:

```bash
docker compose up -d redis postgres
cp .env.example .env
```

Then point `.env` at localhost (`REDIS_URL=redis://localhost:6379`,
`DATABASE_URL=postgres://postgres:postgres@localhost:5433/stocktracker` — note
port **5433**, which is what compose publishes) and run:

```bash
yarn install
yarn dev        # watch mode
```

> The process exits on startup if it cannot connect to Redis.

## Endpoints

### `GET /quotes/:symbols`

Comma-separated symbols, up to `QUOTE_MAX_SYMBOLS` (default 10). Symbols are
uppercased and de-duplicated; results come back in request order.

```bash
curl -i http://localhost:3000/quotes/PETR4,VALE3
```

```json
[
  {
    "symbol": "PETR4",
    "name": "PETROBRAS   PN",
    "currency": "BRL",
    "price": 31.42,
    "dayHigh": 31.8,
    "dayLow": 31.05,
    "change": 0.22,
    "changePercent": 0.7,
    "time": "2026-09-15T20:06:00.000Z",
    "marketCap": 410000000000,
    "volume": 38215400,
    "logoUrl": "https://icons.brapi.dev/icons/PETR4.svg",
    "fetchedAt": "2026-09-15T20:07:11.412Z"
  }
]
```

The `x-cache` response header reports `HIT`, `MISS`, or `PARTIAL` for the batch.
`time` is the provider's quote timestamp; `fetchedAt` is when this API produced
the value.

| Status | Meaning |
| --- | --- |
| 200 | Quotes resolved |
| 400 | Symbol list failed schema validation (bad ticker shape, or too many) |
| 404 | brapi does not know one of the symbols |
| 502 | brapi unavailable after retries |

### `GET /healthz`

Liveness. Always 200 while the process is serving; checks no dependencies.

### `GET /readyz`

Readiness. Pings Postgres and reports Redis connection state. Returns **503**
when the database is unreachable. A down Redis is reported in `checks.redis`
but does **not** fail the probe — quotes still resolve from brapi without the
cache.

```json
{ "status": "ready", "checks": { "database": true, "redis": true } }
```

### `GET /docs`

Swagger UI, generated from the route schemas (OpenAPI 3.1). The raw spec is
served at `GET /docs/json`.

## How a quote is resolved

1. Symbols are normalized (trimmed, uppercased, de-duplicated).
2. A single `MGET` looks up `quote:<SYMBOL>` for all of them.
3. Misses are fetched from brapi concurrently, one request per symbol, each with
   up to `BRAPI_RETRY_COUNT` attempts. Only 5xx and 429 are retried, with
   exponential backoff plus jitter.
4. Fresh quotes are written back in a `MULTI` with `EX = QUOTE_CACHE_TTL`.

Redis is treated as optional throughout: a failed read logs a warning and falls
through to brapi, and a failed write is swallowed. A cache entry that fails to
parse counts as a miss and gets overwritten.

## Configuration

Every variable has a default in `src/config.ts`, so `.env` only needs the ones
you want to change. `.env.example` documents the full set.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Bound on `0.0.0.0` |
| `LOG_LEVEL` | `info` | Pino level |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` inside compose |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stocktracker` | compose overrides this for the `api` service |
| `BRAPI_BASE_URL` | `https://brapi.dev/api` | |
| `BRAPI_TOKEN` | *(none)* | Optional; the free tier works unauthenticated but is heavily rate limited. Get one at <https://brapi.dev/dashboard> |
| `BRAPI_TIMEOUT_MS` | `5000` | Per-request `AbortSignal.timeout` |
| `BRAPI_RETRY_COUNT` | `3` | Total attempts, not extra retries |
| `QUOTE_CACHE_TTL` | `60` | Seconds |
| `QUOTE_CACHE_PREFIX` | `quote:` | |
| `QUOTE_MAX_SYMBOLS` | `10` | Enforced by the route's regex, so the failure is a 400 |

Two details worth knowing when editing `.env`:

- `docker-compose.yml` sets `BRAPI_BASE_URL` and `DATABASE_URL` for the `api`
  service, and those **override** what `.env` says. The `.env` values are what
  `yarn dev` uses outside Docker.
- `POSTGRES_PORT` (default `5433`) is the *host* port compose publishes;
  inside the network Postgres is still on 5432.

The `ALERTS_*` variables are read into `config.alerts` but nothing consumes
them yet — a price-alert poller is planned, not implemented.

## Scripts

```bash
yarn dev          # watch mode
yarn start        # run once
yarn test         # node --test over tests/**/*.test.ts
yarn test:watch
yarn typecheck    # tsc --noEmit (tsc never emits; Node runs the sources)
yarn lint
yarn lint:fix
```

Tests stub `fetch` and shadow the Redis singleton's commands
(`tests/helpers/`), so nothing connects — the suite runs with no services up.

## Make targets

| Target | What it does |
| --- | --- |
| `make up` (alias `make build`) | `docker compose up --build -d` |
| `make start` | Start existing containers |
| `make down` | `down -v` — removes the Postgres volume |
| `make nuke` | `down -v --rmi all --remove-orphans` |
| `make docker-install` / `docker-uninstall` | Install/remove Docker on apt or dnf systems |

## Project layout

```
src/
  server.ts          entrypoint: connects Redis, listens, handles SIGTERM/SIGINT
  app.ts             buildApp() — Fastify instance, swagger, route registration
  config.ts          env parsing, all defaults
  routes/            quotes.ts, health.ts, alerts.ts (+ JSON schemas for docs & serialization)
  services/
    brapi.ts         upstream client: retries, BrapiError, normalization
    quotes.ts        cache-aside orchestration over brapi.ts
  redis/redis.ts     singleton client with reconnect strategy
  db/pool.ts         pg pool + pingDatabase()
  lib/symbols.ts     ticker regex, normalization
  types/brapi.ts     upstream + normalized shapes
tests/
  services/          brapi and quotes unit tests
  helpers/           fetch stub, fake redis
```

Response schemas in `src/routes/` double as Fastify's serializer — **a field
missing from the schema is silently dropped from the payload**, so adding a
field to `StockQuote` means adding it in `src/routes/quotes.ts` too.
