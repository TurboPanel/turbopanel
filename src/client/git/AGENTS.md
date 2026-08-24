# Git provider webhooks — AGENTS.md

Inbound webhook surfaces for Git providers: **GitHub** and **GitLab**, one route
file each, both running the identical five-step gate.

## Why this lives outside `CLIENT_API_PREFIX`

Every other write surface in this codebase authenticates a *caller we enrolled*:
a browser with a session cookie, or a daemon with a JWT. A webhook has neither.
The caller is the Git provider, and its only credential is one it presents in
the request itself. So the routes are mounted on the **top-level app** at
`GITHUB_WEBHOOK_PATH` (`/api/git/v1/github/webhook`) and `GITLAB_WEBHOOK_PATH`
(`/api/git/v1/gitlab/webhook`, both in `src/surfaces.ts`) rather than under
`CLIENT_API_PREFIX`:

- session middleware would reject every delivery;
- the cross-origin write gate (`src/browser-write-protection.ts`) only guards
  cookie-authenticated prefixes, and this surface is not one — including it would
  add nothing and would have to be special-cased for an `Origin`-less caller.

Registration therefore happens in the entrypoints (`src/deno-server.ts`,
`src/workers.ts`) next to `registerDaemonApiRoutes`, **not** inside
`registerClientRoutes`.

## The two surfaces, and the one difference that matters

GitLab **does not sign deliveries.** GitHub MACs the exact bytes it sent
(`X-Hub-Signature-256`); GitLab echoes the configured secret back verbatim in
`X-Gitlab-Token`. That is a weaker contract, and it is GitLab's, not a shortcut
taken here:

| | GitHub | GitLab |
| --- | --- | --- |
| Credential | HMAC-SHA256 over the raw body | static shared token in a header |
| Body authenticated? | yes | **no** — only possession of the token |
| Compared by | `crypto.subtle.verify` on the tag | `crypto.subtle.verify` on digests of both sides (`timingSafeSecretEquals`) |
| Delivery id | `X-GitHub-Delivery`, always present | `X-Gitlab-Event-UUID` when present, else a SHA-256 of the body |
| Dispatch key | `X-GitHub-Event` | payload `object_kind` (the header is a display name whose spelling has drifted) |
| Installation named on the delivery? | yes | **no** — see "Trigger resolution" |
| Suite-level CI signal | `check_suite` (or a `check_run` whose suite is green) | `pipeline` (never a `Job Hook`) |
| Installation lifecycle events | `installation`, `installation_repositories` | none — a revoked grant surfaces as a failing token refresh |

The GitLab token is not itself a MAC, so a naive `===` on it would be a timing
oracle. `timingSafeSecretEquals` MACs both sides under one ephemeral
per-isolate key and compares the two fixed-length tags, which is the same
primitive GitHub's path leans on applied to a value that did not arrive as a
tag. That key is minted on first use — never at module load — because
Cloudflare Workers reject `crypto.getRandomValues` (and async SubtleCrypto)
in isolate global scope (error 10021), and `src/workers.ts` imports this
module on boot.

## The gate, in order

`registerGithubWebhookRoutes` and `registerGitlabWebhookRoutes` run the same
fixed sequence, and the order is load-bearing:

1. **Rate limit** (`GITHUB_WEBHOOK_RATE_LIMITER` / `GITLAB_WEBHOOK_RATE_LIMITER`,
   or the Deno Redis limiters). Cheapest check first — it is what protects the
   verification below. Keyed per peer address, the one place in
   `src/daemon/rate-limit/keys.ts` that does so, because the caller has no
   identity until step 3 succeeds. **Separate buckets per provider**, so a
   pipeline-hook flood from one cannot start dropping the other's deliveries.
2. **Raw bytes** — `c.req.arrayBuffer()`, never `c.req.json()`. GitHub's
   signature covers the exact bytes it sent; parsing and re-encoding changes key
   order and escapes and breaks the MAC. GitLab reads the same bytes at the same
   point, both to keep the two surfaces structurally identical and because the
   fallback delivery id is a digest of them.
3. **Verify** — GitHub: HMAC-SHA256 against the sealed webhook secret from
   `getGithubAppConfig(...).webhookSecret`. GitLab: the sealed
   `getGitlabOauthConfig(...).webhookSecret`, compared in constant time. No
   secret configured → `503`, never an unauthenticated accept. Bad or missing
   credential → `401`, before any database write.
4. **Delivery claim** — the delivery id is claimed once in the `delivery` table
   (`claimWebhookDelivery`, keyed on `(provider, external_delivery_id)`). A
   redelivery answers `204` without re-running side effects. Claiming *after*
   verification is deliberate: otherwise an unauthenticated request could burn
   the id a genuine redelivery needs.
5. **Parse and dispatch** — on `X-GitHub-Event`, or on GitLab's `object_kind`.

Everything answers fast and answers 2xx unless the instance itself is at fault.
A provider reads a non-2xx as "retry me", and retrying will not conjure a server
placement or re-arm a disabled source.

**When the instance *is* at fault, that distinction is the recovery path.** A
command queue that is down, or a deploy the shared pipeline answered 5xx to, is
a delivery this instance lost — nothing else will ever bring that commit back.
Those answer `503`, and they **release the delivery claim** first
(`releaseWebhookDelivery`): the provider retries with the *same* delivery id
(and GitLab's body-digest fallback recomputes to the same value), so a claim
left behind would turn the retry into the `204` of step 4. Callers
that answer 2xx must never release, or a genuine redelivery would enqueue a
second deploy. `dispatchDelivery` returns `{ retry, result }` and
`triggerSummaryNeedsRetry` decides it from the trigger summary's `failed` count;
a `checks_passed` SHA that was cleared before a failed enqueue is put back on
`source.options.pendingChecks` so the redelivery has something to release.

**Checks are a suite-level signal.** `check_run` describes one job — a repository
with lint, unit, and e2e sends three — so releasing on the first green run would
deploy a commit whose other jobs are still queued, which is exactly what
`autoDeploy: 'checks_passed'` exists to prevent. `successfulCheckSha` therefore
takes a completed successful `check_suite`, or a `check_run` whose nested
`check_suite` has itself concluded `success`. GitLab's `pipeline` is the exact
analogue — one pipeline covers every job in the ref — so `Job Hook` is
deliberately not honored.

## Events

| Event | Handling |
| --- | --- |
| `push` | `resolveGithubPushTrigger` — branch + head SHA → deploys |
| `push` (branch delete) | dropped: the all-zero `after` SHA / `deleted: true` is not a deploy trigger |
| `check_suite` / `check_run` | **suite**-level success only; releases a SHA parked by `autoDeploy: 'checks_passed'` |
| `installation` | `suspend` / `deleted` set `suspended_at`; `unsuspend` / `created` / `new_permissions_accepted` clear it |
| `installation_repositories` | logged only — no `source` row is mutated |
| anything else | `204` |

GitLab's table is shorter, because its webhook vocabulary is:

| `object_kind` | Handling |
| --- | --- |
| `push` | `resolvePushTrigger` with `provider: 'gitlab'` |
| `push` (branch delete) | dropped: a null `checkout_sha` / all-zero `after` is not a deploy trigger |
| `pipeline` | **pipeline**-level `success` only; releases a SHA parked by `autoDeploy: 'checks_passed'` |
| anything else | `204` |

There is deliberately **no installation case**. GitLab has no
installation-lifecycle webhook: an operator revoking the OAuth grant surfaces as
a failing token refresh at deploy time (a `source_ref_unresolved` prepare error),
not as a delivery this surface could record.

Installation **deletion is recorded as suspension**, not a row delete: the
`source` rows referencing it survive, so reinstalling the App restores every
repository binding instead of orphaning it.

## Providers

Everything provider-specific — listing repositories, resolving a ref to a commit,
minting a clone credential, verifying a delivery, parsing a payload — sits behind
the `GitProvider` interface in `src/lib/git/git-provider.ts`, with one
implementation per `source.provider` value (`github`, `gitlab`, and `git`, the
degenerate generic-SSH one). `resolveGitProvider(row.provider)` is the single
dispatch; deploy-prepare and the repository picker call it rather than testing
the column. Adding a third hosted provider is a new implementation plus a row in
that registry, not another branch in four files.

The two GitLab clone lanes are worth knowing about, because they are what keeps
deploy-prepare down to two cases rather than four:

- **OAuth connection** (`source.installation_id`) — an access token is minted per
  deploy from the sealed pair on the installation row and sealed straight into
  the payload. GitLab **rotates the refresh token on every use**, so
  `mintGitlabAccessToken` writes the new pair back before returning; that write
  is the one place GitLab's token lifecycle is not stateless like GitHub's.
- **Deploy key** (`source.credential_id`) — a generated read-only Ed25519 key,
  the same lane `provider: 'git'` uses. `POST /sources/gitlab/deploy-keys` mints
  it, seals the private half, and returns the public half **once**. That is the
  recommended non-human path: the key belongs to the project, so no individual
  leaving the organization breaks its deploys.

Exactly one of the two, never both — `assertProviderAuthShape` rejects the
ambiguous pair at the write boundary rather than letting deploy-prepare guess.

### Instance-wide provider credentials

Neither hosted provider works until an instance admin registers its application,
and each has one admin route pair:

| Provider | Route | Setting row | Notes |
| --- | --- | --- | --- |
| GitHub | `GET`/`PUT` `/api/admin/v1/instance/github-app` | `TURBOPANEL_GITHUB_APP` | App id, slug, client id, private key, webhook secret |
| GitLab | `GET`/`PUT` `/api/admin/v1/instance/gitlab-oauth` | `TURBOPANEL_GITLAB_OAUTH` | Client id, client secret, `baseUrl` (self-managed origin), redirect URI, webhook token |

Both `PUT`s are partial: an omitted key keeps its stored value, so a body that
does not mention the secret keeps the sealed one, and an explicit `null` clears
a nullable field. Both `GET`s report **presence only** — sealed material is
never returned. Without the GitLab row, `/sources/gitlab/oauth`, repository
discovery, and webhook verification each answer with a configuration error, so
this route is the supported way to turn the provider on; the GitLab path is
documented in the admin OpenAPI spec (`src/admin/openapi/index.ts`).

### Write-boundary compatibility

Ownership is not the only thing `POST`/`PATCH /sources` checks about a named
`installationId` or `credentialId` — the row also has to belong to the lane the
source is on:

- `installation.provider` must equal `source.provider`. A GitLab source pointing
  at a GitHub connection is unclonable: deploy-prep dispatches on
  `source.provider`, so `mintGitlabAccessToken` would be handed a row with no
  `oauth_envelope`.
- `credential.provider` must be `git_deploy_key`, and only `git` / `gitlab`
  sources may name a credential at all. `credential` is one table for every
  sealed secret the organization holds, so an org-owned S3 or SFTP credential
  passes the ownership test and is still nothing a clone can use.

Both answer `400` with a specific code (`source_installation_provider_mismatch`,
`source_credential_provider_mismatch`) rather than the `404` that cross-org
ownership failures use — the row is the caller's own, so there is no existence
signal to hide. The point is that an incoherent binding fails at the write, not
as a checkout error on a host hours later.

## Trigger resolution

`src/client/sources/webhook-trigger.ts` turns
`(provider, installation, repository, branch, sha)` into environments. Three
things there are easy to get wrong:

- **Both attachment models count.** A source is attached either by the
  `source.service_id` / `source.environment_id` columns *or* by a compose
  document naming it at `services.<name>.x-turbopanel.source.sourceId`. The
  Services form writes only the compose reference, so a resolver that read the
  columns alone would ignore most real bindings. Both are resolved, using the
  same `COMPOSE_SOURCE_JSONPATH` that guards source deletion.
- **It reuses the deploy pipeline.** Resolution ends in
  `runEnvironmentDeployForActor`, which is `runEnvironmentDeploy` with an
  `actorType: 'system'` actor whose `actorId` is the triggering `source.id`.
  There is no second enqueue path — see the concurrency note in
  `src/lib/commands/AGENTS.md`.
- **A GitLab delivery names no connection.** GitHub puts the installation id on
  every delivery; GitLab's payload identifies only the project, because a
  webhook has no idea which OAuth connection an operator registered it under.
  `loadInstallations` therefore accepts a `null` external id and treats **every
  live connection for that provider** as a candidate, with the provider-side
  project id doing the narrowing in `findSourcesForRepository`. That is safe
  because a `source` can only carry a project id the connection that created it
  could see.

A source with `defaultBranch` set watches exactly that branch; one that left it
blank watches every branch, because guessing the repository's upstream default
would need a live provider call per delivery.

## Reachability

A LAN-only instance (`https://panel.lan:8443`, a private IP, a `.internal` name)
can clone and mint tokens — both outbound — but no provider can deliver to it.
`GET /sources/:id` therefore returns `webhookUrl`, `webhookReachable`, and
`reachabilityNote`, computed from the operator's public URL list by
`src/lib/git/webhook-reachability.ts` **on the source's own provider path**; a
`provider: 'git'` source has no webhook surface and is given none. The intended alternative for those
instances is the `ref` field on `POST /environments/:id/deploy`.

That field is **accepted and validated but still not honored.** It is threaded
through `runEnvironmentDeploy` → `prepareOneServerDeploy` → `prepareDeployCompose`
as `sourceSelection`, and prepare echoes it back on the prepared result. Prepare
now *does* resolve compose-declared sources into `sourceMaterial[]` and honors a
supplied **`commitSha`** (the webhook path already knows the pushed head) — but
only for the binding whose **`sourceId`** the selection names, so one push never
pins the other repositories bound in the same environment. The commit each other
service builds comes from its own
`x-turbopanel.source.branch` (else the source's default branch) — never from a
ref named on the request. So `PREPARE_HONORS_SOURCE_SELECTION` stays `false` and
the route answers `501 source_ref_unsupported` to any request that sets `ref`.
Building the declared branch while reporting `queued` for "deploy release/1.4" is
the one outcome the caller cannot detect, so it refuses instead. Flipping that
constant is what turns ref-directed deploys on.
