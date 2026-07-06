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

Email settings use the hierarchical `TURBOPANEL_SYSTEM_EMAIL__*` prefix (see `src/lib/settings/email-settings.ts`).

| Variable | Purpose |
| --- | --- |
| `TURBOPANEL_AMQP_URL` | RabbitMQ connection URL |
| `TURBOPANEL_SYSTEM_EMAIL__PROVIDER` | `smtp`, `mailgun`, or `mailpit` (dev) |
| `TURBOPANEL_SYSTEM_EMAIL__FROM` | Default From address |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE` | Max emails per minute (token bucket; default 60) |
| `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST` | Bucket capacity (defaults to rate) |
| `TURBOPANEL_SYSTEM_EMAIL__QUEUE_PREFETCH` | AMQP prefetch for the mailer consumer (default 1) |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_HOST` | SMTP host |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT` | SMTP port |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_USER` | SMTP auth user |
| `TURBOPANEL_SYSTEM_EMAIL__SMTP_PASS` | SMTP auth password |
| `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_API_KEY` | Mailgun API key |
| `TURBOPANEL_SYSTEM_EMAIL__MAILGUN_DOMAIN` | Mailgun sending domain |
| `TURBOPANEL_DATABASE_URL` | Postgres for DB-backed email settings (`setting` table) |
| `MAILPIT_API_URL` | Mailpit HTTP API base URL when provider is `mailpit` |

## Dev defaults

- **AMQP:** `amqp://guest:guest@localhost:19828`
- **Mailpit:** HTTP API at `http://127.0.0.1:8025` when `TURBOPANEL_SYSTEM_EMAIL__PROVIDER=mailpit`

## Rate limiting

Token-bucket limiter driven by the settings system.

- `TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE`: tokens added per minute (default 60).
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
