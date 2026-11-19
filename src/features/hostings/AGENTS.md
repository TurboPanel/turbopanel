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

| Field                       | Rule                                                                 | Sink                                                    |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `options.proxy.stripPrefix` | `/` + segments of `[A-Za-z0-9._~-]`, no `//`, `.`, `..`, at most 200 | hosting Caddy `uri strip_prefix`, Traefik `stripprefix` |
| `options.pathPrefix`        | same                                                                 | hosting Caddy `handle`, Traefik `PathPrefix`            |
| `options.hostnames[]`       | `isValidHostname`                                                    | Caddy site address, Traefik `Host`                      |
| `options.web.env` keys      | `[A-Za-z_][A-Za-z0-9_]*`, at most 128                                | Apache `SetEnv`, site Caddy `env`                       |
| `options.web.env` values    | no control character, NEL, U+2028/U+2029                             | Apache `SetEnv`, site Caddy `env`                       |

Runtime variables (`forRuntime`) stay multi-line at the variables API (a PEM is
legitimate for containers). When one is merged into a site's web env, the
daemon refuses it for Apache (where it never rendered) and drops it for the
site Caddy, as before. PHP settings, cron and site roots were already
allowlisted (`php-settings.ts`, `features/deploy/cron.ts`,
`features/compose/site.ts`). There is no source-scan registry on this side: the
control plane renders no engine config, so the boundary check plus the
daemon's scan cover the sinks.

## Certificate choice per name

Each served name has its own certificate choice, stored on its `hostname` row:
`certificate` (`cloudflare_origin`, `letsencrypt_http`, `letsencrypt_dns`,
`self_signed`, `library`; vocabulary in `name-certificate-vocabulary.ts`) and
`tls_id` (the library row, set null when that row is deleted). A NULL
`certificate` means "follow `hosting.tls_id`". Rows cover the routing names:
the typed names plus the `www` names the www mode adds (`hostingRoutingNames`).

- `replaceHostingHostnames` is a diff, so a save keeps the choice of every name
  that stays; a new name gets none. A `www` name defaults to its typed name's
  choice.
- `hosting.tls_id` stays as the whole-site pin that older flows write
  (`pinHostingNames` copies it onto the names; `syncHostingPin` writes it back
  only when every name agrees). Nothing new should read it for a decision.
- `POST`/`PATCH /hostings` accept `names: [{ hostname, certificate, tlsId? }]`
  (`src/client/hostings/name-certificates-routes.ts`). Reads return each name's
  choice and `certificateOptions` (`name-certificate-options.ts`): every library
  certificate that covers the name, wildcards included.
- The library "in use" read and the delete guard look at `hostname.tls_id`
  (`certificateIdsPinnedBy`, `notPinnedBySiteCondition`).
- Deploy preparation (`src/client/environments/deploy-prepare.ts`) judges the
  names against each other (`name-tls-wire.ts`). Names that all resolve to one
  value send today's payload with no `nameTls`. Mixed names send the most common
  value at row level (first in names order on a tie) plus `nameTls` entries. A
  mixed row needs the daemon feature `hosting-name-tls-v1`; a server without it
  is refused with 409 `name_certificates_need_update`, on the hostings-only
  apply path too. A name waiting for its Let's Encrypt via DNS pair goes as
  `internal`, never `acme`.
