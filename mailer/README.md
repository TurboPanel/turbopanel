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
| `TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE` | Max emails per minute (token bucket) |
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
- **SMTP:** Mailpit at `localhost:19825` (when no SMTP host/port is configured)

## Rate limiting

Token-bucket limiter; default **60 emails/min**. Set `TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE` to override.

## Queue topology

| Resource | Name | Options |
| --- | --- | --- |
| Exchange | `turbopanel.email` | topic, durable |
| Queue | `turbopanel.email.send` | durable |
| Routing key | `email.send` | bound to queue |

The instance publishes `EmailJob` payloads to the exchange with routing key `email.send`; this process consumes from the bound queue.
