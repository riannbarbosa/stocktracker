# Stocktracker API

REST API serving B3 (Brazilian stock exchange) quotes, fetched from
[brapi.dev](https://brapi.dev) and cached in Redis, plus a watchlist and price
alerts stored in Postgres and delivered by webhook or email.

Built with Fastify 5 on Node 22, running the TypeScript sources directly via
native type stripping — there is no build step.

## Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node 22 (native `.ts` type stripping, no transpile step) |
| Framework | Fastify 5 + `@fastify/swagger` / `swagger-ui` |
| Cache | Redis 7 (`redis` v6 client) |  
| Database | Postgres 16 (`pg` pool) — alerts, watchlist, schema applied on boot |
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

> Postgres is **required**: `migrateDatabase()` applies `src/db/schema.sql` on
> every boot, and a failure there aborts startup — a boot without a schema is a
> broken deploy, not a degraded one. Redis is **not** required: `connectRedis()`
> is deliberately not awaited, so a cache outage costs latency, not availability.

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

### `GET /watchlist`

Tickers being tracked. There is no authentication and no per-user identity yet —
every caller shares the single `default` owner (`DEFAULT_OWNER` in
`src/routes/watchlist.ts`).

```bash
curl -X POST http://localhost:3000/watchlist \
  -H 'content-type: application/json' -d '{"symbol":"petr4"}'
curl http://localhost:3000/watchlist
curl -X DELETE http://localhost:3000/watchlist/PETR4
```

```json
[{ "id": 1, "symbol": "PETR4", "owner": "default", "createdAt": "2026-09-22T02:21:58.213Z" }]
```

Tickers are upper-cased on the way in. `POST` is idempotent — re-adding a ticker
returns the existing row rather than erroring.

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /watchlist` | 200 | Tracked tickers, one entry per row |
| `POST /watchlist` | 201 | Added (or already present) |
| `POST /watchlist` | 400 | `symbol` missing or not shaped like a B3 ticker |
| `DELETE /watchlist/:symbol` | 204 | Removed, empty body |
| `DELETE /watchlist/:symbol` | 404 | Ticker was not on the list |

### `GET /alerts`, `POST /alerts`, `GET /alerts/:id`, `DELETE /alerts/:id`

Price alerts. Each one names a ticker, a `direction` (`above` / `below`), a
`targetPrice`, and at least one delivery channel — `webhookUrl`, `email`, or
both. A request with neither is rejected with 400.

```bash
curl -X POST http://localhost:3000/alerts \
  -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":30,
       "webhookUrl":"https://hooks.example.test/petr4"}'
```

```json
{
  "id": 1, "symbol": "PETR4", "direction": "below", "targetPrice": 30,
  "webhookUrl": "https://hooks.example.test/petr4", "email": null,
  "active": true, "firedAt": null, "lastPrice": null, "lastCheckedAt": null,
  "createdAt": "2026-09-22T02:22:28.381Z", "updatedAt": "2026-09-22T02:22:28.381Z"
}
```

Read that as **"tell me when PETR4 drops to 30 or below"**. That request is the
whole job — you do not poll, acknowledge or close anything afterwards.

Of the twelve fields that come back, you send four. `id`, `active`, `createdAt`
and `updatedAt` come from the database, and `firedAt`, `lastPrice` and
`lastCheckedAt` are the poller's, written as it works. See
[Worked example](#worked-example-an-alert-end-to-end) for the full lifecycle
with real output.

Alerts have no owner column, so `GET /alerts` returns every alert in the
database and `DELETE /alerts/:id` deletes by id alone.

| Route | Status | Meaning |
| --- | --- | --- |
| `GET /alerts` | 200 | Every alert, most recently created first |
| `POST /alerts` | 201 | Created |
| `POST /alerts` | 400 | Schema validation failed, or no delivery channel given |
| `GET /alerts/:id` | 200 / 404 | The alert, or not found |
| `DELETE /alerts/:id` | 204 / 404 | Deleted (empty body), or not found |

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

## How an alert fires

`src/workers/alertPoller.ts` runs **in the same process as the API**, started
from `src/server.ts` when `ALERTS_POLLER_ENABLED` is on. Every
`ALERTS_POLL_INTERVAL_MS`:

1. It takes `pg_try_advisory_lock(ALERTS_LOCK_KEY)`. If another instance holds
   it the cycle is skipped, so running several replicas does not notify twice.
2. It reads up to `ALERTS_BATCH_SIZE` active alerts, oldest-checked first.
3. It resolves the distinct symbols through the **same cache-aside path as
   `/quotes`**, so the poller warms and reuses the quote cache.
4. `evaluateAlert()` (`src/services/alerts.ts`) decides per alert. It is pure, so
   the whole rule is unit-testable with no database and no market feed:

   | State | Condition | Outcome |
   | --- | --- | --- |
   | armed (`firedAt` null) | met | **trigger** — notify once, set `fired_at` |
   | fired | no longer met | **rearm** — clear `fired_at`, stay quiet |
   | anything else | | **noop** — just record the observed price |

   The re-arm branch is what stops a price hovering on the target from
   notifying on every interval.
5. Triggered alerts go to `src/services/notifier.ts`: a JSON `POST` to
   `webhookUrl` and/or an email via `SMTP_URL`. A delivery failure is logged and
   swallowed — it never kills the cycle, and the interval always survives.

`nodemailer` is imported lazily and is **not** in `package.json`, so the email
channel throws `nodemailer is not installed` until you `yarn add nodemailer`.
The webhook channel works out of the box.

## Worked example: an alert end to end

Real output from a local run. Three settings make it fast and deterministic —
a 3s cycle instead of 60s, a price pinned in the cache so the run does not
depend on brapi, and the private-network escape hatch because the receiver is
on localhost:

```bash
docker compose up -d redis postgres
docker compose exec redis redis-cli set quote:PETR4 \
  '{"symbol":"PETR4","price":48,"name":null,"currency":"BRL","dayHigh":49,"dayLow":47,"change":0,"changePercent":0,"time":null,"marketCap":null,"volume":null,"logoUrl":null,"fetchedAt":"2026-09-22T02:00:00.000Z"}' EX 900

ALERTS_POLL_INTERVAL_MS=3000 \
WEBHOOK_ALLOW_PRIVATE=true WEBHOOK_ALLOWED_SCHEMES=https,http yarn dev
```

**1. Create the alert.** PETR4 is at 48, so a `below 50` alert is already
satisfied and fires on the next cycle:

```bash
curl -X POST http://localhost:3000/alerts -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":50,
       "webhookUrl":"http://localhost:3099/hook"}'
```

```json
{ "id": 6, "symbol": "PETR4", "direction": "below", "targetPrice": 50,
  "active": true, "firedAt": null, "lastPrice": null, "lastCheckedAt": null }
```

**2. It fires**, 2.3 seconds later. What arrives at the webhook is an event, not
the alert row:

```
[03:27:03] {"event":"alert.triggered","alertId":6,"symbol":"PETR4",
            "direction":"below","targetPrice":50,"price":48,
            "triggeredAt":"2026-09-22T03:27:03.354Z"}
```

```
id=6  firedAt=2026-09-22T03:27:03.348Z  lastPrice=48  lastCheckedAt=...03.348Z
```

**3. Three more cycles, price still 48 — nothing is sent.** The condition is
still met every cycle, but `firedAt` is set, so the alert stays quiet. Without
that rule you would get one webhook per interval, forever:

```
deliveries: 1        firedAt: 2026-09-22T03:27:03.348Z
```

**4. Price rises to 60 — the alert re-arms, silently.** `firedAt` goes back to
null and **nothing is delivered**; re-arming is not an event:

```
deliveries: 1        firedAt: null        lastPrice: 60
```

**5. Price falls to 45 — it fires again.** The alert watches the *crossing*, not
the value, so it is reusable:

```
[03:27:03] ... "price":48 ...
[03:27:39] ... "price":45 ...
```

```
created (firedAt null) ──price crosses──> notify once, set firedAt
                                               │
                             price goes back ──┘
                             (re-arm, silent, firedAt -> null)
                                               │
                             price crosses ──> notify again
```

An alert is never "used up" — it fires every time the price crosses the target.
To stop one, `DELETE /alerts/6`.

### Reproducing it without the local receiver

The quickest path with `make up` already running is [webhook.site](https://webhook.site),
which gives you a public `https` URL and shows the payload as it lands — no
escape hatch needed, since the destination is public:

```bash
curl http://localhost:3000/quotes/PETR4          # pick a target that will fire
curl -X POST http://localhost:3000/alerts -H 'content-type: application/json' \
  -d '{"symbol":"PETR4","direction":"below","targetPrice":999,"webhookUrl":"https://webhook.site/YOUR-ID"}'
curl http://localhost:3000/alerts                # watch firedAt/lastPrice fill in
```

Pinning the cached price by hand, as in step 4 above, is how you force a re-arm
without waiting for the market to move.

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
| `PG_STARTUP_RETRIES` | `10` | Boot waits this many times for Postgres before giving up |
| `PG_STARTUP_RETRY_DELAY_MS` | `1000` | Delay between those attempts |
| `DB_MAX_POOL_SIZE` | `10` | `pg` pool size |
| `ALERTS_POLLER_ENABLED` | `true` | Set `false` to run the API without the poller |
| `ALERTS_POLL_INTERVAL_MS` | `60000` | Cycle interval — note: **not** `ALERTS_POLLER_INTERVAL_MS` |
| `ALERTS_BATCH_SIZE` | `100` | Alerts evaluated per cycle |
| `ALERTS_LOCK_KEY` | `alerts_poller_lock` | Folded into a bigint for `pg_try_advisory_lock` |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-delivery `AbortSignal.timeout` |
| `WEBHOOK_ALLOWED_SCHEMES` | `https` | Accepts `https` or `https:`; comma-separated |
| `WEBHOOK_ALLOWED_HOSTS` | *(empty)* | When set, **only** these hosts are accepted, and they skip the private-range check |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Dev escape hatch — skips the private/loopback check |
| `SMTP_URL` | *(none)* | Required for the email channel |
| `EMAIL_FROM` | `stocktracker@localhost` | `From:` on alert mail |

Two details worth knowing when editing `.env`:

- `docker-compose.yml` sets `BRAPI_BASE_URL` and `DATABASE_URL` for the `api`
  service, and those **override** what `.env` says. The `.env` values are what
  `yarn dev` uses outside Docker.
- `POSTGRES_PORT` (default `5433`) is the *host* port compose publishes;
  inside the network Postgres is still on 5432.

Two `config.alerts` keys look alike: the poller reads **`pollIntervalMs`**
(`ALERTS_POLL_INTERVAL_MS`). `pollerIntervalMs` (`ALERTS_POLLER_INTERVAL_MS`,
the one `.env.example` lists) is not read by anything.

## Security posture

Reviewed on this branch. One real finding, two things that are posture rather
than bugs — worth knowing before exposing this to anything but localhost.

### Webhook destinations are validated (SSRF, fixed)

`webhookUrl` is caller-chosen and the poller POSTs to it from inside the
deployment network, so `format: 'uri'` is not a control — it admits any scheme
and any host, including loopback, RFC1918 and the link-local `169.254.169.254`
that carries cloud instance metadata. `src/lib/webhookUrl.ts` vets every
destination instead, in two places:

- **On write**, in `POST /alerts`, so a bad URL is a 400 with a reason rather
  than a delivery that silently fails a minute later.
- **On send**, in `sendWebhook`, because a stored row may predate a config
  change or have been inserted out of band.

What it rejects, by default: any scheme other than `https`; embedded
credentials; and hosts that resolve into the loopback, link-local, RFC1918,
CGNAT, unspecified, multicast or reserved ranges, for IPv4 and IPv6 alike.
IPv4-mapped IPv6 (`::ffff:169.254.169.254`) is unwrapped and judged as IPv4, and
a name answering with several addresses is rejected if *any* of them is blocked.
Deliveries also run with `redirect: 'manual'`, so a 3xx cannot move the request
to a host that was never validated.

Two operator overrides, both off by default: `WEBHOOK_ALLOWED_HOSTS` is the
supported way to reach an internal collector (when set, only those hosts are
accepted, and they skip the range check), and `WEBHOOK_ALLOW_PRIVATE=true` is
the development escape hatch that lets a local receiver work.

**Residual risk worth knowing:** validation resolves the hostname, then `fetch`
resolves it again, so a DNS entry that changes between the two could still point
the request somewhere else (DNS rebinding). Closing that requires pinning the
validated address with a custom undici dispatcher, which is not implemented.
`WEBHOOK_ALLOWED_HOSTS` is not affected, since it never resolves at all.

### Posture, not a bug: there is no authentication

`/quotes`, `/watchlist`, `/alerts` and `/docs` are all open, and there is no user
model at all — `alerts` has no owner column and the watchlist's `owner` is the
constant `'default'`. That means `GET /alerts` returns every alert and
`DELETE /alerts/:id` deletes by id alone, but it is not privilege escalation:
anyone who can read can already write and delete. It is a single-user
self-hosted service today.

If auth is ever added, **`alerts` is the table that breaks.** It needs an `owner`
column, and `listAlerts`, `findAlert` and `deleteAlert` all need the
`WHERE owner = $1` predicate that `repositories/watchlists.ts` already has.
Doing both at the same time avoids introducing a real IDOR later.

### Robustness: database errors reach the client verbatim

No handler wraps its queries and there is no `setErrorHandler`, so a `pg` failure
surfaces through Fastify's default handler with the driver's message and
SQLSTATE — e.g. `POST /alerts` with `targetPrice: -1` returns
`{"statusCode":500,"code":"23514","message":"... violates check constraint
\"alerts_target_price_check\""}`, leaking table and constraint names. Row data,
query text and stack traces are *not* included, and `/docs` already publishes the
schema, so the confidentiality impact is negligible — this is a consistency and
UX gap, not an exploit. `src/routes/quotes.ts` already shows the pattern: log the
real error, return a generic one. A single `app.setErrorHandler` covers every
route, and `exclusiveMinimum: 0` on `targetPrice` would turn that particular 500
into a clean 400.

### What is solid

Every SQL statement is parameterized (`$n` throughout `src/repositories/`,
including the `UNNEST($1::bigint[])` bulk update) — no injection path. Nothing
builds SQL from request data; `COLUMNS` is a module constant. `SYMBOL_PATTERN` is
anchored and enforced on every route that takes a ticker, and `brapi.ts` also
applies `encodeURIComponent`. `format: 'email'` is enforced and admits no CR/LF,
so there is no SMTP header injection. `src/db/migrate.ts` reads its schema path
from `import.meta.dirname`, never from input.

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

Tests stub `fetch` and shadow the Redis and pg singletons' commands
(`tests/helpers/`), so nothing connects — the suite runs with no services up,
including the route tests, which drive the real Fastify instance through
`app.inject()`.

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
  server.ts          entrypoint: migrates, connects Redis, starts the poller,
                     listens, handles SIGTERM/SIGINT
  app.ts             buildApp() — Fastify instance, swagger, route registration
  config.ts          env parsing, all defaults
  routes/            quotes.ts, health.ts, alerts.ts, watchlist.ts
                     (+ JSON schemas for docs & serialization)
  services/
    brapi.ts         upstream client: retries, BrapiError, normalization
    quotes.ts        cache-aside orchestration over brapi.ts
    alerts.ts        evaluateAlert() — the pure trigger/rearm/noop rule
    notifier.ts      webhook + email delivery
  repositories/      alerts.ts, watchlists.ts — all SQL lives here
  workers/
    alertPoller.ts   in-process interval, advisory-locked
  redis/redis.ts     singleton client with reconnect strategy
  db/
    pool.ts          pg pool + pingDatabase()
    migrate.ts       waits for Postgres, applies schema.sql on boot
    schema.sql       idempotent DDL: watchlist + alerts
  lib/symbols.ts     ticker regex, normalization
  types/             brapi.ts, alerts.ts — upstream + normalized shapes
tests/
  services/          brapi, quotes, alerts, notifier
  repositories/      watchlists
  routes/            watchlist (through app.inject)
  workers/           alertPoller
  helpers/           fetch stub, fake redis, fake pg pool
docs/
  structure-map.excalidraw   architecture map (open at excalidraw.com)
```

Note the split: **`repositories/` owns every SQL statement**, routes own
validation and status codes, and `services/` holds logic with no SQL in it.
`evaluateAlert()` is deliberately pure so the alert rule can be tested without a
database or a market feed.

Response schemas in `src/routes/` double as Fastify's serializer — **a field
missing from the schema is silently dropped from the payload**, so adding a
field to `StockQuote` means adding it in `src/routes/quotes.ts` too.
