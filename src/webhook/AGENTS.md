# Webhook ingress — AGENTS.md

The inbound webhook surface. Today that is **GitHub** and **GitLab**; the
directory is shaped so a third kind is an adapter, not a third copy of the gate.

```
src/webhook/
├── gate.ts     the six ordered steps, written once
├── routes.ts   registerWebhookRoutes — the one call each entrypoint makes
└── git/        github.ts, gitlab.ts — what makes each provider itself
```

An instance may hold **more than one** GitHub App or GitLab OAuth application —
instance-wide ones an operator registered for everybody, and organization-owned
ones. So a delivery cannot be checked against "the" webhook secret: the surface
has to work out *whose* secret to use before it can authenticate anything. That
is step 2 below (`src/lib/git/resolve-webhook-forge.ts`).

## Why this is its own surface

Every other write surface in this codebase authenticates a *caller we enrolled*:
a browser with a session cookie, or a daemon with a JWT. A webhook has neither.
The caller is the provider, its only credential is one it presents in the request
itself, and what arrives is an **event rather than a call**. That is a different
thing from `/api`, which is why it has its own URL prefix — and, since the same
argument applies to the code, its own top-level directory beside `admin`,
`client`, `daemon` and `developer`.

One consequence is deliberate and easy to undo by accident:

- **No `.use('*')` middleware.** `/webhook` stays out of `PROTECTED_PREFIXES`
  in `src/browser-write-protection.ts`: session middleware would reject every
  delivery, and the cross-origin write gate has no `Origin` to read. Each gate
  authenticates itself.

Registration is **flat** — each gate calls `app.post()` with the absolute paths
from `src/surfaces.ts` rather than mounting a child router at the prefix. Two
gates own paths under `/webhook`, and a shared child router would be one more
object to thread through `registerWebhookRoutes` for no behaviour.

Registration happens in the entrypoints (`src/deno-server.ts`, `src/workers.ts`)
next to `registerDaemonApiRoutes`, through the single `registerWebhookRoutes`
call — **not** inside `registerClientRoutes`.

**Every layer in front of the instance has to know `/webhook`.** `Caddyfile`,
`dev/orchestration/Caddyfile` (both listener blocks), and the `routes` patterns
in `wrangler.jsonc` each enumerate the prefixes they forward and then end in a
catch-all that serves the UI's `index.html`. A prefix missing from one of those
lists does not 404 — it answers **`200` with an HTML page**, which a Git
provider reads as a delivered webhook and never retries. That is silent,
unrecoverable loss of every push, and it is why `src/surfaces.test.ts` pins
these strings.

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

## Two paths per provider

| Path | When it is used |
| --- | --- |
| `/webhook/<provider>` | **Hosted providers.** github.com stamps `X-GitHub-Hook-Installation-Target-ID` on every App delivery and gitlab.com echoes the token we can digest, so the app is identifiable from the request alone and the URL stays clean — nothing internal in it. |
| `/webhook/<provider>/:ref` | **Self-hosted providers.** `:ref` is that app's `forge.webhook_ref`, baked in at registration (GitHub: `hook_attributes.url` in the manifest; GitLab: the per-project hook URL). GitHub Enterprise Server and self-managed GitLab ship on their own cadence, so the header is not a safe single point of failure there — a build that omitted it would 401 every delivery with nothing in the URL to fall back to. |

All of them register the same handler; the ref is simply absent on the bare
path. `webhookPathFor` in `src/lib/git/webhook-reachability.ts` decides which
shape an app is *told* about, from its `base_url`.

## The gate, in order

`gate.ts` runs this sequence for **every** kind, and the order is load-bearing —
three of the six steps are security properties rather than tidiness. It used to
be written out twice, once per provider, with nothing keeping the two in step;
that is exactly the duplication a third kind would have inherited.

1. **Rate limit** (`GITHUB_WEBHOOK_RATE_LIMITER` / `GITLAB_WEBHOOK_RATE_LIMITER`,
   or the Deno Redis limiters). Cheapest check first — it is what protects the
   verification below. Keyed per peer address, the one place in
   `src/daemon/rate-limit/keys.ts` that does so, because the caller has no
   identity until step 3 succeeds. **Separate buckets per provider**, so a
   pipeline-hook flood from one cannot start dropping the other's deliveries.
2. **Resolve the app** (`resolveGithubWebhookForge` / `resolveGitlabWebhookForge`).
   Selection only — nothing is trusted yet; see "Which app sent this?" below.
   Nothing resolves → `401`, never an unauthenticated accept. Every candidate
   missing its webhook secret → `503`, because that gap is on this side.
3. **Raw bytes** — `c.req.arrayBuffer()`, never `c.req.json()`. GitHub's
   signature covers the exact bytes it sent; parsing and re-encoding changes key
   order and escapes and breaks the MAC. GitLab reads the same bytes at the same
   point, both to keep the two surfaces structurally identical and because the
   fallback delivery id is a digest of them.
4. **Verify** — against **that app's** sealed secret. GitHub: HMAC-SHA256.
   GitLab: the static token, compared in constant time. `selectVerifiedApp`
   walks the candidates and keeps the one that actually verifies; nothing
   verifies → `401`, before any database write. The verified app's id is what
   every downstream lookup is then scoped to.
5. **Delivery claim** — the delivery id is claimed once in the `delivery` table
   (`claimWebhookDelivery`, keyed on `(provider, external_delivery_id)`). A
   redelivery answers `204` without re-running side effects. Claiming *after*
   verification is deliberate: otherwise an unauthenticated request could burn
   the id a genuine redelivery needs.
6. **Parse and dispatch** — on `X-GitHub-Event`, or on GitLab's `object_kind`.

Everything answers fast and answers 2xx unless the instance itself is at fault.
A provider reads a non-2xx as "retry me", and retrying will not conjure a server
placement or re-arm a disabled repository.

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
`repository.options.pendingChecks` so the redelivery has something to release.

**Checks are a suite-level signal.** `check_run` describes one job — a repository
with lint, unit, and e2e sends three — so releasing on the first green run would
deploy a commit whose other jobs are still queued, which is exactly what
`autoDeploy: 'checks_passed'` exists to prevent. `successfulCheckSha` therefore
takes a completed successful `check_suite`, or a `check_run` whose nested
`check_suite` has itself concluded `success`. GitLab's `pipeline` is the exact
analogue — one pipeline covers every job in the ref — so `Job Hook` is
deliberately not honored.

## Adding a kind

Implement `WebhookGate<THolder>` and add a line to `routes.ts`. `THolder` is
whatever that kind verifies against — a `Forge` for the git kinds — so a kind
with **no tenant at all** is as expressible as a multi-tenant one: `resolve`
returns a single holder carrying only the instance-wide secret.

Two escape hatches exist for senders that do not look like GitHub. `verify` and
`eventName` receive the **raw bytes** rather than a parsed payload, so a sender
that signs *fields* (Mailgun MACs `timestamp + token`) or names its event in the
body can parse them itself without moving the parse ahead of verification.

Worth knowing before you start — the surface is generic, but three things around
it are still git-shaped and would need widening:

- `delivery.provider` is `CHECK (provider IN ('github','gitlab'))`
  (`src/lib/db/schema.ts`, `migrations/0000_init.sql`). The claim in step 5
  writes it, so a new kind throws on insert until this is widened.
- `WebhookDeliveryProvider` is aliased to `WebhookGitProviderName`
  (`src/lib/db/webhook-delivery-records.ts`) — which is `src/lib/db/`'s only
  dependency on `src/lib/git/`. Decoupling it is the natural moment to break
  that.
- Rate-limit keys are `git:webhook:<provider>:<peer>`
  (`src/daemon/rate-limit/keys.ts`) — domain-prefixed rather than
  traffic-class-prefixed. `webhook:<kind>:<peer>` generalises, but it is a
  breaking change to live counters and `rate-limit/keys.test.ts` pins the
  current strings.
- Cloudflare needs a rate-limiter binding in **three** places in
  `wrangler.jsonc` (default, `env.testing`, `env.live`), each with its own
  `namespace_id`.

The URL plumbing, though, is free: `/webhook/*` is already forwarded by every
fronting layer, so `/webhook/<kind>` inherits it.

## Events

| Event | Handling |
| --- | --- |
| `push` | `resolveGithubPushTrigger` — branch + head SHA → deploys |
| `push` (branch delete) | dropped: the all-zero `after` SHA / `deleted: true` is not a deploy trigger |
| `check_suite` / `check_run` | **suite**-level success only; releases a SHA parked by `autoDeploy: 'checks_passed'` |
| `installation` | `suspend` / `deleted` set `suspended_at`; `unsuspend` / `created` / `new_permissions_accepted` clear it |
| `installation_repositories` | logged only — no `repository` row is mutated |
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
`repository` rows referencing it survive, so reinstalling the App restores every
repository binding instead of orphaning it.

## Providers

Everything provider-specific — listing repositories, resolving a ref to a commit,
minting a clone credential, verifying a delivery, parsing a payload — sits behind
the `GitProvider` interface in `src/lib/git/git-provider.ts`, with one
implementation per `repository.provider` value (`github`, `gitlab`, and `git`, the
degenerate generic-SSH one). `resolveGitProvider(row.provider)` is the single
dispatch; deploy-prepare and the repository picker call it rather than testing
the column. Adding a third hosted provider is a new implementation plus a row in
that registry, not another branch in four files.

The two GitLab clone lanes are worth knowing about, because they are what keeps
deploy-prepare down to two cases rather than four:

- **OAuth connection** (`connectionId`) — an access token is minted per
  deploy from the sealed pair on the connection row and sealed straight into
  the payload. GitLab **rotates the refresh token on every use**, so
  `mintGitlabAccessToken` writes the new pair back before returning; that write
  is the one place GitLab's token lifecycle is not stateless like GitHub's.
- **Deploy key** (`secretId`) — a generated read-only Ed25519 key,
  the same lane `provider: 'git'` uses. `POST /repositories/gitlab/deploy-keys` mints
  it, seals the private half, and returns the public half **once**. That is the
  recommended non-human path: the key belongs to the project, so no individual
  leaving the organization breaks its deploys.

Exactly one of the two, never both — `assertProviderAuthShape` rejects the
ambiguous pair at the write boundary rather than letting deploy-prepare guess.

### Registered applications, and who owns them

Neither hosted provider works until an application is registered. Those live in
the **`forge`** table, not in a settings row, and an instance may hold as many
as it needs:

| `organization_id` | Meaning | Managed through |
| --- | --- | --- |
| `NULL` | **Instance-wide** — any organization may connect through it | `GET`/`POST`/`PATCH`/`DELETE` `/api/admin/v1/forges` (role-gated) |
| set | Owned by that organization alone | the same verbs under `/api/client/v1/forges` (`organization:manage`) |

An organization *reads* instance-wide apps — the connect flow has to be able to
offer them — but may never edit one; that is a `403`, not a `404`, because the
caller already knows it exists. Both surfaces share `src/client/forges/`, so
the two cannot drift into accepting different shapes for the same resource. The
admin surface deliberately sees only instance-wide rows: `createAdminAccessMiddleware`
resolves no organization, so it has no scope in which to edit an org-owned app.

Every write is partial — an omitted key keeps its stored value, so a form can
save a rename without the operator re-pasting a private key it was never shown —
and an explicit `null` clears a nullable field. Reads report **presence only**;
sealed material is never returned.

`POST /forges/github/manifest` is the supported way to create a GitHub App:
it returns a manifest whose `hook_attributes.url` is already the new app's
scoped webhook path, so the App is born self-identifying. GitHub then sends
the operator's browser to `GET …/github/manifest/callback`, which stores the
credentials and **302s** to `/<orgId>/projects/git-apps` (or `/admin/git`)
with `created=` or `error=` — never a JSON body. Manual registration
stays available for GitHub Enterprise Server and for an App that already exists.
A manifest App is created `public: true` on purpose — **a private GitHub App can
only be installed on the account that owns it**, so one meant to serve several
organizations has to be public.

`connection.forge_id` names the app a connection was granted through. Token
minting resolves the app from that column (`mintGithubInstallationToken`,
`mintGitlabAccessToken`) rather than from a single instance-wide config, which
is what lets two connections with the same provider-side id mint against
different private keys, on different origins.

### Which app sent this?

Resolution runs before verification and only *selects* a candidate key.

**GitHub.** The `:ref` in the path is authoritative. Failing that,
`X-GitHub-Hook-Installation-Target-ID` holds — for a webhook whose
`…-Target-Type` is `integration`/`app` — the **App id**, not the installation
id. Every installation of one App shares it, so it selects the *app* and never
the installation. Keeping that straight is the whole game: matching an
installation on the App id would mean one App installed across several accounts
only ever deploys for whichever row was created first. The App id picks the
**key**; the payload's `installation.id` picks the **tenant**.

More than one row can match an App id, because a numeric App id is unique per
origin rather than globally — github.com and a GHES instance can each hold one.
So resolution returns a candidate *list* and `selectVerifiedApp` keeps whichever
secret actually verifies.

**GitLab** sends no such header. It echoes the configured secret verbatim in
`X-Gitlab-Token`, so the token *is* the routing signal: apps store a digest of
it (`hashWebhookToken`) and the fallback is one indexed lookup. The digest only
**finds** the row — `verifyGitlabWebhookToken` still does the constant-time
compare against the sealed value. Because a weak token would be brute-forceable
offline by anyone holding the table, hand-entered GitLab tokens have a minimum
length and the ones we mint are 32 random bytes.

**A ref and a header that disagree is a `401`.** It means the URL and the
signing credentials belong to different apps, which would otherwise surface as
deliveries silently landing on the wrong tenant.

### Write-boundary compatibility

Ownership is not the only thing `POST`/`PATCH /repositories` checks about a named
`connectionId` or `secretId` — the row also has to belong to the lane the
repository is on:

- `connection.provider` must equal `repository.provider`. A GitLab repository pointing
  at a GitHub connection is unclonable: deploy-prep dispatches on
  `repository.provider`, so `mintGitlabAccessToken` would be handed a row with no
  `oauth_envelope`.
- `secret.provider` must be `git_deploy_key`, and only `git` / `gitlab`
  repositories may name a credential at all. `secret` is one table for every
  sealed secret the organization holds, so an org-owned S3 or SFTP credential
  passes the ownership test and is still nothing a clone can use.

Both answer `400` with a specific code (`source_installation_provider_mismatch`,
`source_credential_provider_mismatch`) rather than the `404` that cross-org
ownership failures use — the row is the caller's own, so there is no existence
signal to hide. The point is that an incoherent binding fails at the write, not
as a checkout error on a host hours later.

## Trigger resolution

`src/client/repositories/webhook-trigger.ts` turns
`(provider, installation, repository, branch, sha)` into environments. Three
things there are easy to get wrong:

- **Both attachment models count.** A repository is attached either by the
  `repository.service_id` / `repository.environment_id` columns *or* by a compose
  document naming it at `services.<name>.x-turbopanel.source.sourceId` (compose
  document field, intentionally still named `source`). The
  Services form writes only the compose reference, so a resolver that read the
  columns alone would ignore most real bindings. Both are resolved, using the
  same `COMPOSE_SOURCE_JSONPATH` that guards repository deletion.
- **It reuses the deploy pipeline.** Resolution ends in
  `runEnvironmentDeployForActor`, which is `runEnvironmentDeploy` with an
  `actorType: 'system'` actor whose `actorId` is the triggering `repository.id`.
  There is no second enqueue path — see the concurrency note in
  `src/lib/commands/AGENTS.md`.
- **Every lookup is scoped to the verified app.** `loadInstallations` takes the
  `app_id` of the app whose secret verified the delivery, and that predicate is
  load-bearing rather than an optimization: `connection` is unique on
  `(organization_id, forge_id, external_installation_id)`, so the same GitHub
  installation id legitimately exists as a row for several organizations.
  Matching on provider and external id alone returned all of them, and one
  organization's push deployed another organization's environments.
  `applyProviderInstallationEvent` carries the same predicate, or one
  organization's uninstall would suspend everybody's row for that account.

  For an **instance-wide** app the predicate narrows to the app rather than to
  one tenant — several organizations connect through it by design — and the
  final narrowing is the repository id. That is sound only because an
  installation may be claimed by one organization per app: `installation_id`
  arrives as a query parameter the caller can retype, so the callback both
  verifies the installation exists under the App and refuses one another
  organization already holds (`assertConnectionUnclaimed`). Without those two
  checks a second organization could name someone else's installation, and the
  shared App's key would happily mint a token for it.
- **A GitLab delivery names no connection.** GitHub puts the installation id on
  every delivery; GitLab's payload identifies only the project, because a
  webhook has no idea which OAuth connection an operator registered it under.
  `loadInstallations` therefore accepts a `null` external id and treats every
  live connection **granted through that app** as a candidate, with the
  provider-side project id doing the narrowing in `findSourcesForRepository`.
  That is safe because a `repository` can only carry a project id the connection
  that created it could see. Scoping to the app is what keeps this from
  spanning the whole instance — including projects on a *different* GitLab
  origin whose numeric ids happen to collide, since `base_url` is per app.

A repository with `defaultBranch` set watches exactly that branch; one that left it
blank watches every branch, because guessing the repository's upstream default
would need a live provider call per delivery.

## Reachability

A LAN-only instance (`https://panel.lan:8443`, a private IP, a `.internal` name)
can clone and mint tokens — both outbound — but no provider can deliver to it.
`GET /repositories/:id` therefore returns `webhookUrl`, `webhookReachable`, and
`reachabilityNote`, computed from the operator's public URL list by
`src/lib/git/webhook-reachability.ts` **on the repository's own provider path, with
the `webhook_ref` of the app behind its connection**; a `provider: 'git'`
repository has no webhook surface and is given none, and a deploy-key repository has no
app, so it falls back to the bare path. The intended alternative for those
instances is the `ref` field on `POST /environments/:id/deploy`.

That field is **accepted and validated but still not honored.** It is threaded
through `runEnvironmentDeploy` → `prepareOneServerDeploy` → `prepareDeployCompose`
as `sourceSelection`, and prepare echoes it back on the prepared result. Prepare
now *does* resolve compose-declared sources into `sourceMaterial[]` and honors a
supplied **`commitSha`** (the webhook path already knows the pushed head) — but
only for the binding whose **`sourceId`** the selection names, so one push never
pins the other repositories bound in the same environment. The commit each other
service builds comes from its own
`x-turbopanel.source.branch` (else the repository's default branch) — never from a
ref named on the request. So `PREPARE_HONORS_SOURCE_SELECTION` stays `false` and
the route answers `501 source_ref_unsupported` to any request that sets `ref`.
Building the declared branch while reporting `queued` for "deploy release/1.4" is
the one outcome the caller cannot detect, so it refuses instead. Flipping that
constant is what turns ref-directed deploys on.
