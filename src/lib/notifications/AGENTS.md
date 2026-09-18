# Notifications — AGENTS.md

"An event happened and someone should hear about it", as one data model for
self-hosted, High Availability and the store apps (decided 2026-09-18).

| File | Owns |
| --- | --- |
| `events.ts` | The catalogue: event codes, severity, scope, and the sentence each renders. **Only events with an emitter are listed** — add the code and the emitter in one commit. `NOTIFICATION_EVENTS` / `NOTIFICATION_RULE_EVENTS` / `NOTIFICATION_SEVERITIES` are pinned to the CHECKs in `schema.ts` by `src/lib/db/enum-checks.test.ts`. |
| `records.ts` | The four tables (`notification_channel`, `notification_rule`, `notification`, `notification_delivery`, migration `0002_notifications`). A channel `address` is a sealed `tpsecret` for every kind but `email`; `signing_secret` always is; both are a stage of the re-encrypt sweep (`notifications`, before `authproviders`). Vocabularies for scope / kind / delivery status live here. |
| `emit.ts` | `emitNotification` — fan-out and delivery, **never throws**. Inbox rows for every organization member (or every instance admin for an instance-scoped event); one `notification_delivery` row per routed channel, written before the send; one bounded attempt inline; `retryDueDeliveries` on both maintenance ticks (Workers `notification-retries` phase, Deno cleanup) with backoff 1/5/25/125 min and a cap of 5. An email channel's delivery is one `notification` job on the mail queue when the emitter was given one (`deps.email`: queue, from, console base URL — the Deno sweep and the request context pass theirs, the Workers cron resolves them per tick); push rows are left `pending` for the Expo transport. |
| `senders.ts` | One bounded, never-rejecting POST per kind: generic webhook (JSON body + `X-TurboPanel-Event` + HMAC `X-TurboPanel-Signature: sha256=…` over the raw body when the channel has a signing secret), Slack (`text`), Discord (`content`), Telegram (Bot API, address `<token>/<chat id>`). Errors are short codes or `http_<status>`, never the address or a body. |
| `audit-bridge.ts` | `recordAuditAndNotify` — the emitters for audit actions a teammate wants to hear about (`AUDIT_EVENTS`); the routes call it where they called `recordAudit`. |

Rules:

- **Routing scope.** An organization event reaches the organization's channels, its members' user channels and every instance channel; an instance event reaches instance channels only. A rule row is required for any channel (`*` or one code, with a severity floor); the inbox needs none.
- **Addresses are re-validated at send** through `outbound-url.ts`; the self-hosted runtime passes `allowPrivateTargets: true` (a LAN Alertmanager is legitimate there, decided 2026-09-18), hosted never does. Telegram is exempt — its host is `api.telegram.org`.
- **The legacy operator webhook** (`ALERT_WEBHOOK_URL` setting, `PUT /api/admin/v1/settings/alert-webhook`) is still honoured by `resolveAlertSender` beside the pipeline; folding it into an instance channel is the next step, not done.
- Workers-bundle safe: no `@std/*`, no `fetch` / `crypto` at module load.
- Tests: `events.hostfree.test.ts`, `senders.hostfree.test.ts` (pure), `emit.test.ts` (real Postgres, skipped without `TURBOPANEL_DATABASE_URL`) — all three in `scripts/test-coverage.sh`.
