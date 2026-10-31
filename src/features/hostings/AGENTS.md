# Hosting Options (`src/features/hostings/`)

### Tenant values in root-loaded configs

Any project member (`organization:manage`) can set hosting options, so they
are tenant input that the daemon writes into configs root-run engines parse
(hosting Caddyfile, Traefik labels, Apache `SetEnv`). `POST`/`PATCH /hostings`
refuse them with **400** `{ error: 'invalid_hosting_option', field, message }`
(`src/features/hostings/config-values.ts`, called from
`parseOptionalHostingOptions`); the message names the field, never the value.
Stored rows still parse leniently through `parseHostingOptions`, and the daemon
refuses the same values again in its renderers (its sink table:
`../turbopaneld/src/deploy/AGENTS.md`, "Tenant values in root-loaded configs").

| Field | Rule | Sink |
| --- | --- | --- |
| `options.proxy.stripPrefix` | `/` + segments of `[A-Za-z0-9._~-]`, no `//`, `.`, `..`, at most 200 | hosting Caddy `uri strip_prefix`, Traefik `stripprefix` |
| `options.pathPrefix` | same | hosting Caddy `handle`, Traefik `PathPrefix` |
| `options.hostnames[]` | `isValidHostname` | Caddy site address, Traefik `Host` |
| `options.web.env` keys | `[A-Za-z_][A-Za-z0-9_]*`, at most 128 | Apache `SetEnv`, site Caddy `env` |
| `options.web.env` values | no control character, NEL, U+2028/U+2029 | Apache `SetEnv`, site Caddy `env` |

Runtime variables (`forRuntime`) stay multi-line at the variables API (a PEM is
legitimate for containers). When one is merged into a site's web env, the
daemon refuses it for Apache (where it never rendered) and drops it for the
site Caddy, as before. PHP settings, cron and site roots were already
allowlisted (`php-settings.ts`, `features/deploy/cron.ts`,
`features/compose/site.ts`). There is no source-scan registry on this side: the
control plane renders no engine config, so the boundary check plus the
daemon's scan cover the sinks.
