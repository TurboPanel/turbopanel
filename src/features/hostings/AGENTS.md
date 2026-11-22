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
  that stays. A new name that the request gives no choice for is never stored
  as NULL: it gets what the site pin stands for when the existing names all
  follow that pin, otherwise the default of the choice table for a name no
  tunnel carries yet. A new `www` name that is not typed gets its typed name's
  choice. Every routing name, a `www` redirect-only name included, keeps its own
  choice.
- `hosting.tls_id` stays as the whole-site pin that older flows write
  (`pinHostingNames` copies it onto the names; `syncHostingPin` writes it back
  only when every name agrees). Nothing new should read it for a decision.
- `POST`/`PATCH /hostings` accept `names: [{ hostname, certificate, tlsId? }]`
  (`src/client/hostings/name-certificates-routes.ts`). Reads return each name's
  choice and `certificateOptions` (`name-certificate-options.ts`): every library
  certificate that covers the name, wildcards included.
- A name saved as `letsencrypt_http` with no pin gets its own managed Let's
  Encrypt row (`ensureNameHttpOrders`, `src/client/hostings/name-http-orders.ts`,
  run after `POST`/`PATCH /hostings` write the names): one row per name, found
  or created under the organization's Let's Encrypt lock with the same
  `managedCertificateFor` the whole-site button uses, then pinned with
  `hostname.tls_id`. The HTTP sweep picks up every automatic row a name pins, so
  the order, the daily cap and the rate-limit pause are the sweep's. It only
  runs for names that pass `httpReason`, never touches other names, and is a
  no-op for a name that already has a pin (a library pick, a Let's Encrypt row
  included, keeps renewing through that row). Moving a name to another choice
  drops its pin; the row is removed when its order never began, and an open
  order is ended by the sweep (it still picks up an unpinned open order, only to
  end it and tell the helpers), after which the row is cleaned up as usual. A
  per-name row never becomes `hosting.tls_id` (`syncHostingPin` skips it), so
  names added later and the whole-site flow never reach it.
- A name saved as `cloudflare_origin` with no pin gets its certificate from
  `ensureNameOriginCertificates` (`src/client/hostings/name-origin-certificates.ts`),
  the counterpart for the origin certificate. Unlike the Let's Encrypt order it
  calls the provider, so it runs after the save committed
  (`issueNameOriginCertificates`: `POST`/`PATCH /hostings`, and a doorway add
  that attaches the name to a tunnel). The provider call is made outside any
  transaction and without the lock; the advisory lock per organization is taken
  only to re-read the waiting names and pin, so a second caller that won the
  race makes the extra certificate be revoked at the provider (the manual
  route takes the same lock). Older tokens with a stale capability probe are
  re-checked once, as the manual route does. The POST and PATCH answers carry
  `names` with each name's state after the attempt.
  Names of one zone share one certificate: the organization's own carriers are
  searched, the longest matching zone wins, the token comes from `pickBadges`
  on its recorded certificate rights, and `ensureOriginCertificate` reuses a
  covering certificate or issues one (audit `origin_certificate.issue`, the
  same as the manual route). The name is then pinned with `hostname.tls_id` and
  the hostings-only apply is queued. A name that cannot get one (no token for
  the zone, a refusal, a provider failure) records why on `hosting.metadata`
  (`nameOriginIssues`, `name-origin-issues.ts`, one entry per name with
  `attempts` and `nextTryAt`; no table) and the hosting read shows it as
  `names[].originCertificateIssue`. A save or attach retries at once; the
  hourly Let's Encrypt tick (`sweepNameOriginCertificates`) retries names whose
  `nextTryAt` has passed (15 minutes with no token, else the doubling back-off
  of the origin sweep, or the provider's own wait, capped at 6 hours). The
  sweep picks due names in stored `nextTryAt` order (oldest first), so a
  backlog of failing names cannot starve the rest. The hostings-only apply
  after a pin measures the edit time from before the save when the save left
  the server facts (options, `ipId`) alone, so it is not skipped as
  `pending_changes`. A PATCH that also moves the whole-site `tlsId`
  goes live without a deploy for the same reason (the server facts are
  untouched); any other edit still waits for the next deploy. The entry goes when the
  name is pinned or leaves the choice. A compose-owned site is left alone.
- The library "in use" read and the delete guard look at `hostname.tls_id`
  (`certificateIdsPinnedBy`, `notPinnedBySiteCondition`).
- Deploy preparation (`src/client/environments/deploy-prepare.ts`) judges the
  names against each other (`name-tls-wire.ts`). Names that all resolve to one
  value send today's payload with no `nameTls`. Mixed names send the most common
  value at row level (first in names order on a tie) plus an entry for every name
  (served or `www` redirect) whose value differs from it; a name is never
  compared with its `www` partner. A
  mixed row needs the daemon feature `hosting-name-tls-v1`; a server without it
  is refused with 409 `name_certificates_need_update`, on the hostings-only
  apply path too. A name waiting for its Let's Encrypt via DNS pair goes as
  `internal`, never `acme`.
