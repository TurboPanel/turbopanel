# TurboPanel mailer

Standalone Deno process that consumes email jobs from RabbitMQ (`turbopanel.email.send`) and delivers them via SMTP (Mailpit in local dev, real SMTP in production).

## How to run

From the `instance/` directory:

```bash
deno run --allow-net --allow-env --allow-read mailer/main.ts
```

## Deno permissions

| Flag | Purpose |
| --- | --- |
| `--allow-net` | AMQP broker + SMTP |
| `--allow-env` | Configuration env vars |
| `--allow-read` | Deno.env, Postgres Unix socket directory (`TURBOPANEL_DATABASE_URL`) |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TURBOPANEL_AMQP_URL` | RabbitMQ connection URL |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | Max emails per minute (token bucket); also accepts legacy `TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE` |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST` | Bucket capacity (defaults to rate) |
| `TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH` | AMQP prefetch for the mailer consumer (default 1) |
| `SMTP_HOST` | SMTP host override |
| `SMTP_PORT` | SMTP port override |
| `SMTP_USER` | SMTP auth user |
| `SMTP_PASS` | SMTP auth password |
| `SMTP_FROM` | Default From address (env) |
| `TURBOPANEL_SYSTEM_EMAIL_FROM` | System From address (env) |
| `TURBOPANEL_DATABASE_URL` | Postgres for DB-backed SMTP settings (`setting` table) |
| `MAILPIT_SMTP_PORT` | Mailpit SMTP port when no SMTP config |

## Dev defaults

- **AMQP:** `amqp://guest:guest@localhost:19828`
- **SMTP:** Mailpit at `localhost:1025` (when no SMTP host/port is configured)

## Rate limiting

Token-bucket limiter driven by the settings system.

- `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` (or legacy `TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE`): tokens added per minute (default 60).
- `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST`: bucket capacity (defaults to the per-minute rate when unset).

Effective capacity is the burst value (it may be lower than the refill rate). The mailer re-resolves settings on each consumed message (30s TTL cache) and hot-applies rate, burst, provider, and prefetch without restart. FROM address and SMTP/Mailgun transport settings are re-resolved inside the sender on each send.

`TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH` controls `channel.prefetch` at startup and when the resolved value changes (default 1).

## Queue topology

| Resource | Name | Options |
| --- | --- | --- |
| Exchange | `turbopanel.email` | topic, durable |
| Queue | `turbopanel.email.send` | durable |
| Routing key | `email.send` | bound to queue |

The instance publishes `EmailJob` payloads to the exchange with routing key `email.send`; this process consumes from the bound queue.
