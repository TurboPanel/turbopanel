# Compose documents — AGENTS.md

The comment-preserving `ComposeDocument` model, the reserved `x-turbopanel` extension (`placement` is rejected on validate and stripped defensively on input — pin lives on `environment.server_id`, never in compose), the compose linter, overlay merge used by projects and environments, and the deploy compiler's four-model IR (`ir.ts`).

Root context: `../../../AGENTS.md`. Command pipeline (deploy consumes runtime YAML): `../commands/AGENTS.md`. UI editor behavior: `../../../../ui/AGENTS.md`. The UI hides `x-turbopanel` (top-level and per-service) from the YAML surface and re-attaches it on save; the stored `ComposeDocument` and server validation are unchanged.

### The frozen contract

**TurboPanel is a Compose implementation.** Three rules, and they do not move:

1. **Compose says what the workload wants.** Image, command, ports, volumes, networks, healthcheck, `deploy.replicas`, `deploy.resources`, `deploy.placement` — if the Compose Spec already has an expression for it, that is the expression TurboPanel reads. Never invent an `x-` key for a question Compose answers.
2. **`x-turbopanel` says only what Compose cannot express.** One namespace, two blocks: the document root (`principals`) and per service (`serviceKind`, `principal`, `hosting`, `source`, `php`, `cron`, engine/runtime pins). Anything that fits rule 1 does not belong here, and anything that is a *privilege* decision (uid, gid, home, shell, keys, password) does not belong in a document at all — see `ROOT_KEY_REDIRECTS` / `HOSTING_KEY_REDIRECTS`, which say so per key with the message an author sees.
3. **The compiler decides how.** Which server, which slot, which container name, which Docker network, which release tree, which address. A document never pins those; a document that tries is refused rather than quietly honoured (`placement` is the standing example — the pin lives on `environment.server_id`).

The corollary is the one worth writing down: **a second extension namespace is never the answer.** If something cannot be said today, it is said as a new key under `x-turbopanel` with a `field-policy.ts` verdict and a validator message, or it is said in a row where privilege can gate it — not as `x-turbopanel-<something>`, not as a magic label, not as a naming convention.

#### The canonical place for each concern

One row per question an operator can ask, and the one place its answer lives. A second source of truth for any of these is a bug, not a convenience.

| Concern | Canonical place | Notes |
| --- | --- | --- |
| What image/command/ports/volumes | Compose service body | Rule 1. Passthrough unless `field-policy.ts` says otherwise. |
| Replica count / mode | `deploy.replicas` / `deploy.mode` | Interpreted by `../schedule/interpret.ts`; stripped from runtime YAML. |
| Placement constraints & spread | `deploy.placement.*` | Interpreted by the planner. `deploy.placement` is *not* the server pin. |
| Which server an environment runs on | `environment.server_id` | Refused in compose (`PLACEMENT_NOT_STORED_MESSAGE`). |
| Resource ceiling | `deploy.resources` + `service.options.resources` | Compose expresses the request; the org ∩ server ceiling clamps it. |
| What kind of thing a service is | `x-turbopanel.serviceKind` | `container` (default) / `site` / `node`. |
| Which account it runs as | `x-turbopanel.principal` (alias) → `principal` row | Alias in YAML, account on the row. See below. |
| Ingress hostnames / TLS / bind | `x-turbopanel.hosting[]` → `hosting` rows | Never a `ports:` replacement. |
| Git source | `x-turbopanel.source` → `sourceMaterial[]` | Release trees are resolved control-plane side. |
| PHP version / extensions / pool | `x-turbopanel.php` | Keyed 1:1 with the *service*, not the hosting. |
| Scheduled jobs | `x-turbopanel.cron[]` | Rendered as systemd timers under the service's principal. |
| Spanning (TurboFabric) networks | `networks.<key>.driver: overlay` | Compose already expresses overlay intent — no `x-` key. |
| Container naming | `project.options.containerNaming` | A compiler decision, not a document one. |
| Variable & secret values | Variable store (org/project/env/server scopes) | Compose carries refs, never values. |

#### Four field states

Every Compose key carries one of four verdicts — `passthrough`, `interpreted`, `runtime-generated`, `unsupported` — plus an orthogonal `runtime: keep | strip`. The registry and the reasoning are in [Field policy](#field-policy-field-policyts) below; do not restate the table anywhere else.

### Compose documents (`src/lib/compose/`)

`project.options.compose` / `environment.options.compose` store a
**ComposeDocument** (`version: 1`, `data`, `presentation`) so YAML comments,
blank lines, and section order survive editor round-trips. Presentation comments
keep **key** vs **value** fields separate (`keyBefore`/`keyInline` vs
`before`/`inline`) so nested `#` lines and trailing scalar comments do not
collide on the same path. Sequence-item trailing comments (e.g.
`- "3001:3001"  # host port`) are keyed by index (`ports[0]`); walkers must use
yaml's `isMap`/`isSeq` — both node types expose `items`, so a naive `items`
check misclassifies sequences as maps and drops those comments. APIs and deploy
reject anything that is not a ComposeDocument (or an intentionally empty value).
Project/environment create and PATCH also run the compose linter
(`lintComposeYaml` / `blockingComposeLintIssues` in `src/lib/compose/lint.ts`)
after structural checks — unknown keys, services missing `image`/`build` (except
**`site`** services declared under `services.<name>.x-turbopanel`),
etc. return **400** `{ error: "compose_invalid", issues }` (empty-draft “no
services” warnings are allowed). Deploy uses `composeDocumentToRuntimeYaml`
(presentation stripped).

### Validation pipeline (five stages, in this order)

Ordering is load-bearing — each stage assumes the ones before it passed, and
`compile-runtime.ts` assumes all four.

1. **Upstream Compose Specification** — `upstream-schema.ts` over
   `vendor/compose-spec.schema.json`, a byte-identical copy of
   `compose-spec/compose-spec` `schema/compose-spec.json` pinned at revision
   `4e2fe7602af8c965ab4fef891e9dde9c5940775f`. **Never fetched from upstream
   `main`** — not at runtime, not at build time, not in a test; a schema that
   moves under the deployment is a validator whose verdict on an unchanged
   document changes without a commit. Refreshing it means a new pin plus the
   rows in `vendor/README.md`. **Every assertion keyword the vendored document
   uses is evaluated** — all thirteen of `$ref`, `type`, `enum`, `properties`,
   `patternProperties`, `additionalProperties`, `required`, `items`, `oneOf`,
   `pattern`, `minimum`, `maximum`, `uniqueItems` — with `oneOf` a real
   exactly-one-branch check that descends, and the closest failing branch
   supplying the diagnostics. `IMPLEMENTED_SCHEMA_KEYWORDS` plus the keyword
   sweep in `upstream-schema.test.ts` is the guard: a vendored refresh that
   introduces a fourteenth keyword fails the sweep rather than silently
   validating less. Three *nodes* are skipped, never a keyword — interpolated
   scalars (`{$VAR}` / `${VAR}` stand for a value the schema cannot see; they
   are substituted in `apply-variables.ts`), empty/null values (a half-typed
   draft, and the editor lints on every keystroke), and `!reset` / `!override`
   subtrees (merged elsewhere, and validated in full at deploy time).
   Unknown keys at the document root and at `services.<name>` are **not**
   reported here — stage 3
   owns those two levels and can offer a “did you mean”. One voice per path.
2. **`x-turbopanel` extension schema** — `validateComposeDocument` /
   `collectRootExtensionValidationIssues` (`validate.ts`, `root-extension.ts`,
   `service-kind.ts`): container-forbids-principal, node-forbids-`image`/`build`,
   per-kind field membership, and the authored-root rejection of `placement`
   (the pin lives on `environment.server_id`).
3. **Semantic linter** — `lintComposeYaml` (`lint.ts`): unknown keys against
   `field-policy.ts`, services missing `image`/`build` (host-native and
   Railpack-built kinds exempt), `x-turbopanel.source.sourceId` resolution +
   one-repository-per-project, `x-turbopanel.principal` alias resolution,
   hosting hostname/`targetPort`-matches-kind and `tls`/`bind` ref resolution,
   overlay tag advisories, and the `deploy:` field-state pass below. (The
   *requirement* that a `site` / `node` service have an account to run as is a
   deploy-prepare gate — `principal_required_for_service_kind` — not a lint
   rule, because it depends on rows the linter cannot see.)
4. **Policy** — the deploy-time-only stage, run with the linter's
   `strict: true` posture. `validateComposeForDeploy` (`validate-for-deploy.ts`)
   is the deploy-time entry point for **all four** stages over the *merged
   effective* document, not just this one: stages 1–3 guard the write boundary
   for each stored *layer*, but a deploy runs the merge of several, and no save
   ever saw that. An overlay `!reset` that removes the base `image`, or the root
   `x-turbopanel.principals` map a base alias depends on, is two valid saves
   whose sum is not runnable. Two error kinds reach `deploy-prepare.ts`:
   `{ kind: "compose_merged_invalid" }` → **422**
   `{ error: "compose_merged_invalid", issues }` for a stage-1–3 failure of the
   merge, and `{ kind: "compose_field_unsupported" }` → **422**
   `{ error: "compose_field_unsupported", issues }` for this stage. Distinct on
   purpose: the first means “these layers do not merge into a document we can
   run”, the second means “valid Compose naming something this platform does not
   implement”, and an operator sent after the wrong one looks for a mistake that
   is not there.

   The gate runs in `planEnvironmentDeploy` (`lib/schedule/plan-deploy.ts`)
   **before** `reconcileServicesFromCompose` / `registerComposeVolumes` /
   `registerComposeMounts`, so a deploy that is going to be refused cannot
   reshape the control plane on its way to being refused. The verdict rides on
   `PlannedDeploy.composeValidated` into each per-server
   `prepareDeployCompose`, which skips re-deriving it for the identical merge —
   a skip, never a bypass: a caller that has not validated leaves the flag unset
   and prepare gates itself.
5. **Compiler** — `compile-runtime.ts`, which is entitled to assume 1–4 ran.

### Field policy (`field-policy.ts`)

The single registry of what TurboPanel does with each Compose field — top-level,
service-level, `deploy.*`, and `deploy.placement.*`. It replaced three
hand-maintained lists that had already drifted from each other: the linter's
`TOP_LEVEL_KEYS` / `SERVICE_KEYS` (which only answered “is this spelled right”)
and `compile-runtime.ts`'s `SCHEDULER_ONLY_DEPLOY_KEYS` (which **silently
deleted** `update_config`, `rollback_config`, `endpoint_mode` and `placement`
from `deploy:` with no diagnostic anywhere).

Four states: `passthrough` (copied as authored), `interpreted` (TurboPanel reads
it and acts), `runtime-generated` (TurboPanel writes it; an authored value is
not the source of truth), `unsupported` (no behavior — reported, never dropped
in silence, and carrying a `reason` the diagnostic quotes).

A second, orthogonal axis, `runtime: "keep" | "strip"`, decides whether a
`deploy:` key survives into compiled runtime YAML;
`DEPLOY_KEYS_STRIPPED_FROM_RUNTIME` is derived from it and is the only list
`compile-runtime.ts` consults. `mode` / `replicas` / `placement` are
`interpreted` + `strip` (the scheduler already decided; standalone Docker must
not reinterpret it); the three `unsupported` keys strip too, as defense in depth
so a document that somehow got past stage 4 still cannot leak a field Docker
would act on. `resources` is `passthrough` + `keep`, `restart_policy` and
`labels` are `interpreted` + `keep`.

**Four keys are also judged below the key level, not only by name.** A supported
key can still be given a value — or a sub-key — this platform would quietly turn
into something else, and `lint.ts` refuses those next to the per-key verdicts:

- `deploy.replicas` must be a whole number ≥ 1 (`lintDeployReplicas`).
  `resolveReplicaPolicy` would otherwise discard the value and fall back to
  `service.options.instances` or `1`, deploying a different count in silence.
- `deploy.mode: replicated-job` / `global-job` are refused
  (`lintDeployMode`), with the same `field_unsupported` code the unsupported
  *keys* carry — advisory while editing, blocking at deploy. Their meaning is
  finite work that completes; TurboPanel schedules long-running replicas it
  restarts when they exit, and `parseDeployMode` folds any non-`global` value
  into `replicated`, so accepting them would deploy a service that never
  finishes and never reports completion. The `mode` **key** stays `interpreted`
  + `strip`; only those two values are refused. `replicated` and `global` are
  unaffected.
- `deploy.resources.reservations` is refused (`lintDeployResources`), under a
  `resources` key that is otherwise passthrough — see below.
- `deploy.restart_policy` on a `serviceKind: node` service is checked field by
  field (`lintNativeRestartPolicy`), because that is the one lane where
  TurboPanel *translates* the key instead of handing it to Docker — see below.

`deploy.placement.max_replicas_per_node` is **not** unsupported: the scheduler
enforces it. `interpretServiceSchedule` parses it onto
`ServiceScheduleSpec.maxReplicasPerNode` and `planEnvironmentSchedule` caps how
many of a service's replicas land on any one host, refusing with its own
`max_replicas_per_node_exceeded` (422) when the count cannot be spread across
the eligible fleet — its own code because every host is available and every port
is free, and `no_eligible_server` would send an operator looking at labels and
connectivity instead of at the cap. The cap also overrides stickiness: a cap
lowered since the last deploy re-homes slots rather than being honoured only for
new ones.

`deploy.resources.reservations` is **refused at deploy time**
(`DEPLOY_RESOURCES_FIELD_POLICY` in `field-policy.ts`, raised by
`lintDeployResources`), even though the parent `resources` key is passthrough. A
reservation is a scheduler admission requirement — "do not place this anywhere
that cannot promise me this much" — and admitting against one needs a per-host
capacity inventory (how much each server has, how much every placed slot has
claimed) that `lib/db/schema.ts` does not have. Parsing it onto the schedule
spec and letting `planEnvironmentSchedule` place the service exactly as if the
block were absent is worse than refusing it: a successful deploy tells the
operator the placement honoured it. `lib/schedule/interpret.ts` therefore does
not read the field at all. `deploy.resources.limits` is unaffected — it is a
ceiling both engines enforce, standalone Docker Compose directly and the native
lane as `CPUQuota=` / `MemoryMax=` on the generated unit.

**`deploy.labels` never reaches container `labels:`.** Compose keeps service
metadata and container metadata in two namespaces, and so does the compiler: the
only writer of `labels:` during compile is `mergeServiceLabels`, fed TurboPanel's
own identity labels and nothing else. `deploy.labels` passes through under
`services.<name>.deploy.labels` untouched. A `serviceKind: node` service leaves
the compose document entirely, so `native-app.ts` reads the same block into
`NativeAppServiceSpec.serviceLabels` (both Compose spellings — mapping and
`KEY=VALUE` sequence) so the block survives the split. It stays on the
control-plane side: the daemon deploy payload carries no service-label field,
and adding one is a deliberate wire-contract change, not a side effect of
reading the key. `mergeServiceLabels` is general enough
that a future change could plausibly start feeding it the deploy block and the
breakage would be silent, so the invariant is pinned by
`compile-runtime.hostfree.test.ts` ("never merges deploy.labels into container
labels").

Severity is the caller's, via `ComposeLintOptions.strict`: save-time routes
leave it off (non-blocking warning, so a draft stays editable) and
`validateComposeForDeploy` turns it on (blocking error, because the alternative
is running something quietly different from what the document says). Only the
field-policy diagnostics answer to it — every other rule keeps the blocking
behavior it already had.

`ui/src/lib/compose/field-policy.ts` mirrors the table (minus the `runtime`
axis, which the editor has no use for), and
`field-policy.fixtures.ts` is **byte-identical in both repositories** — `diff`
over the two is the drift check. The instance suite runs the fixtures in both
postures; the UI, which has no deploy-time mode, asserts the permissive column.

Deploy prep (`deploy-prepare.ts`) pipeline order: merge
project+env compose → **`validateComposeForDeploy`** (stages 1-4 above, unless
`planEnvironmentDeploy` already ran it for this request and said so via
`composeValidated`) → `reconcileServicesFromCompose` → interpret Swarm `deploy:`
/ plan `slot` rows (`src/lib/schedule/`) → **`allocateEnvironmentContainers`**
(pre-allocate `container` rows when `project.options.containerNaming` is `uuid`,
or `custom` with an explicit compose `services.<key>.container_name`; replica
identity is `(service, ordinal)` with `ordinal = slot + 1`, not sibling `web-N`
compose keys) → **`registerComposeVolumes`** + **`renameComposeVolumes`**
(auto-register top-level named volumes as `storage` rows and rewrite keys to
their UUID `volumeName`) → build service-options map → resource-limit + health
gates → **`apply-variables.ts`** (parse `{$KEY}` / `{$scope.KEY}` on
`environment` / `build.args`; non-secrets → project `.env` + `${service__KEY}`;
secrets → Compose `secrets:` + `KEY_FILE`; unreferenced secrets not
auto-injected except bindings; reserved `TURBOPANEL_*` keys stripped from user
variables via `platform-variables.ts` — the platform does **not** auto-inject
identity vars into prepared compose; the keys stay reserved for a future opt-in
feature) → **`apply-service-options.ts`** (sole writer of `container_name` for
**single-replica** services: allocation map from deploy-prepare — the allocated
**service** UUID in `uuid` mode (authored YAML `container_name` is **ignored**
there, see `authoredContainerNamesForAllocation`), the authored name in `custom`
mode, nothing when custom has none; **local replica count > 1 omits
`container_name` and sets Compose `scale:`**. When the rename happens, the
friendly name — authored `container_name`, else the compose service key — comes
back as a **network alias** on every network the service joins (a service with
no `networks:` gets an explicit `default`, mapping form), since Docker allows
only one container name — the rename stamps **no labels**; operator-authored
`labels:` are left untouched) → storage material → split site + prune
networks → **`compileRuntimeComposeDocument`** (`compile-runtime.ts`: strip the
`deploy:` keys `field-policy.ts` marks `runtime: "strip"`, filter to this
server's services, rewrite
spanning networks as `external: true` + `name: tpn_<id>`; spanning services with
**more than one local replica** expand into one runtime service per local task
(`<name>-<ordinal>`) so each can carry a distinct `ipv4_address`; `extra_hosts`
lists sibling services that share at least one spanning network, never the
current service). Prepared result also returns `containers`,
`composeServiceExpansion` (identity map — logical key stays the compose key,
except spanning multi-replica compile expansion), `replicaCounts`,
`desiredHash`, and `volumes` for hosting fan-out / preview. Overlay merge:
`mergeComposeOverlay` is placement-agnostic; deploy prep (`deploy-prepare.ts`)
additionally strips `x-turbopanel.placement` from **both** project base and
environment overlay immediately before merging, as a defensive
input-sanitization pass. The UI Overview now edits **either**
`project.options.compose` (base chip) **or** `environment.options.compose`
(overlay) and renders a client-side `mergeComposeOverlay` **Merged compose**
preview; **Prepared** preview and `environment.deploy` send **one compiled
`compose.yaml`** per participating server (`role: 'runtime'`). Users never see
project/environment/platform layers or daemon overlay files. The reserved
top-level `x-turbopanel` extension must not carry `placement` **on stored
project/environment compose** — `validateComposeDocument` rejects it
(`x-turbopanel.placement`), and `src/lib/compose/placement.ts`
(`stripComposePlacement`, `applyComposePlacement`, `isPlacementServerId`,
`TURBOPANEL_EXTENSION_KEY`) strips defensively on deploy/save boundaries.
`applyComposePlacement` is compile-time only: runtime `compose.yaml` (Prepared
preview and `environment.deploy`) is annotated with
`x-turbopanel.placement.server_id` for the participating host so operators can
audit the pin. Docker ignores `x-*`. There is no stored-compose placement
helper, because authored compose is never a placement store. **Placement SoT is
`environment.server_id` as a hard whole-environment pin** (never requires
TurboFabric). When unset, `project.options.defaultServerId` is the unconstrained
fallback and the scheduler (`src/lib/schedule/`) may place `slot` rows from
Compose `deploy.replicas` / `mode: global` / `placement.constraints`
(`node.labels.*` from the `label` table). A plan that would use **two or more
servers** requires org TurboFabric (`422 turbofabric_required`); a one-server
schedule stays ordinary Docker standalone. Compose never stores a pin.
Top-level **`x-turbopanel`** has two disjoint shapes, kept as two types in
`root-extension.ts` (authored) and `placement.ts` (runtime) rather than one
all-optional shape: authored compose may declare **`principals`** (a mapping of
document-local alias to optional `description` / `access` — `none` | `sftp` |
`ssh`, default `none`) and **nothing else**; compiled runtime snapshots carry
**`placement`** and nothing else. There is deliberately **no `schemaVersion`**
— any unrecognized top-level key is a save-time issue, with a redirect message
for `uid` / `gid` / `home` / `shell` / `password` / `authorized_keys` /
`server_id` / `cgroup` naming where each actually lives. Deploy prep strips the
whole key, so no part of it reaches runtime compose.
Per-service **`services.<name>.x-turbopanel`** declares **`serviceKind`** —
`container` (default), `site`, or `node` (see the native-apps section
below). **`site`** takes **optional** **`engine`** (`caddy` | `apache` |
`nginx` | `openlitespeed`, default **`caddy`**, resolved at the control-plane
split so the daemon never sees it absent — a minimal static site is four lines
of compose) and optional relative **`root`** (default `public`), plus
optional operator **`description`** (string, max 500 chars — TurboPanel-only
metadata, not used by Docker) — validated in `src/lib/compose/service-kind.ts` /
`site.ts` and mirrored in the UI Visual editor + linter. Deploy prep
**strips** site services from Docker `composeYaml` into payload
**`sites[]`** (listen port + root); all four engines (`caddy` / `apache` /
`nginx` / `openlitespeed`) are deployable — the daemon vendors OpenLiteSpeed
under `/opt/turbopanel/vendor` (never a distro package) and regenerates its
single `httpd_config.conf` from per-site fragments on apply. After the strip,
deploy prep **prunes** top-level `networks:` entries that no remaining container
service references (`pruneUnreferencedComposeNetworks`) so project-internal
networks used only by site never appear in runtime compose and never
require org `network` rows. **External Docker networks**
(`networks.<key>.external: true` **or** Compose Spec `external: { name: "…" }` /
`external: {}`) must be registered on the org **Networks** screen as
`kind: docker` with required **`options.dockerNetworkName`** matching the
resolved host name (see `docker-external-networks.ts` +
`docker-network-name.ts`); create/patch without a valid name returns **400**
`docker_network_name_required`. Deploy returns
**`422 docker_external_network_unregistered`** when compose references an
unregistered external and sends **`dockerExternalNetworks[]`** to the daemon to
`docker network create` before compose up. Internal compose networks are not
registered — only long-lived externals. **Docker ↔ site
reachability** is daemon-owned: when a deploy carries both container services
and `sites[]`, the daemon injects
`extra_hosts: host.docker.internal:host-gateway` plus
`TURBOPANEL_SITE_<SERVICE>_URL` and
`TURBOPANEL_SITE_ENDPOINTS` on every container service (instance does
not duplicate those fields in the payload). Daemon applies
nginx/apache/OpenLiteSpeed vhosts + hosting Caddy reverse_proxy to
`127.0.0.1:<listenPort>` — see `../../../../turbopaneld/src/deploy/AGENTS.md`.
Editor | Visual tab preference lives in `presentation.editorView` only (never in
compose YAML). Swarm `deploy:` (replicas, constraints, spread) is scheduler
input compiled out of runtime YAML; it is not a per-service compose pin.

### Per-service ownership (`x-turbopanel.principal`) — the declared account

`services.<name>.x-turbopanel` accepts **`principal`**: the **alias** of an
entry in the sibling root `x-turbopanel.principals` map. **Required** on
`serviceKind: site` and `serviceKind: node`, **refused** on `container` (a
container has no account to run as) — both statements come from the one field
table in `service-kind.ts`, so the union, the membership messages, and the
required-field messages cannot disagree. The value is a document-local name,
never a Linux username: `PRINCIPAL_ALIAS_RE` (canonically in `service-kind.ts`,
re-exported by `root-extension.ts`) is the ordinary identifier shape, and the
Unix account it becomes — `username`, `appliedUsername`, uid, gid, home, shell
— is decided control-plane side on the `principal` row.

**Resolution.** The compose parser and validator only check the alias *shape*.
Whether it **resolves** is the linter's rule, sourced the way `knownSourceIds`
is: `lintComposeYaml` takes **`knownPrincipalAliases`** and, when supplied,
emits a blocking `error` at `services.<name>.x-turbopanel.principal` for an
alias the set does not contain; omitted, the rule is **skipped** rather than
false-flagged. The project routes pass this document's own root aliases; the
environment routes pass the project's persisted root ∪ the overlay's own, the
same "an overlay answers to the project's rule" shape `projectRepositoryId`
uses (`src/lib/db/principal-alias-records.ts`).

**Materialization.** At deploy-prepare, right after
`reconcileServicesFromCompose` writes the service rows and **before** either
ownership lane runs, `reconcilePrincipalsFromCompose`
(`src/client/principals/tenancies.ts`) walks every declared alias and upserts
one `principal` row per `(project, alias)` — idempotent on
`metadata.composeAlias`, created with the alias entry's `access` as its initial
shell and never re-asserted after that — plus one `tenancy` edge per service
naming it. It is **additive**: an edge an operator added in the UI is never
deleted here. A service naming an alias the root does not declare is
**`422 principal_alias_unknown`** (defense in depth — the linter refuses this at
save, so reaching it means a stale or unlinted document).

**Precedence.** A declared alias **wins outright** in both lanes —
`attachPrincipalsToSites` (sites) and `resolveBindingPrincipal` (Git releases,
including `node`) skip `pickSolePrincipalId` entirely for that service. The
sole-steward lookup remains the fallback for a document that declares none, so
`site_principal_ambiguous`, `source_principal_ambiguous`,
`site_managed_directory_unowned`, and `site_cron_unowned` become unreachable for
an aliased service but still fire on the un-aliased path. A host-native service
with neither an alias nor any steward is **`422
principal_required_for_service_kind`** — "too many owners" and "none at all" are
different refusals and say so.

### Per-service ingress (`x-turbopanel.hosting`) — materialized into `hosting` rows

`services.<name>.x-turbopanel` accepts an optional **`hosting`** list:
`[{ hostname, pathPrefix?, targetPort?, forceHttps?, tls?: { mode, certificateRef? }, bind?: { scope, ipRef? } }]`
(`src/lib/compose/hosting-extension.ts`). Legal on **every** kind — a container
behind the edge, a site served by a host engine, a supervised `node` process can
each answer on a hostname — which is one row in the same field table
`serviceKind` legality already comes from.

**It is not `ports:`.** A `hosting` entry opens no host port; it declares a
hostname the edge answers on and forwards. `ports:` stays exactly what Compose
says it is, and `HOSTING_KEY_REDIRECTS` says so out loud for `ports`, `publish`,
`protocol`, `certificate*`, `ip*`, `tlsId`, `web`, and the proxy toggles — each
refused with a pointer to where it actually lives rather than a bare "unknown".
Raw `tcp` / `udp` publishing through the edge remains a hosting-row setting
(`options.protocol`) with no compose spelling.

**Shape vs. resolution.** The parser and `collectHostingExtensionValidationIssues`
answer shape only: hostname DNS form, absolute traversal-free `pathPrefix`,
`targetPort` refused on **`site` and `node`** (both are host-native lanes served
on a loopback port TurboPanel allocates — `hostingTargetPortAuthorable` is the
single definition of which kinds may author one, and the deploy path backs it
up: `buildNativeAppServicesForDeploy` allocates native-app ports out of the
shared ledger and never reads a hosting `targetPort`),
`tls.certificateRef` required by — and only by — `tls.mode: certificate`, and a
duplicate `(hostname, pathPrefix)` within one service reported rather than
last-wins merged.

**`tls.mode`.** `internal` (the default when `tls` is omitted) is Caddy's own
self-signed certificate; `certificate` resolves `certificateRef` to a `tls` row
and pins it. **`automatic` is refused** — at save time
(`HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE`) and again at deploy-prepare
(**`422 hosting_tls_mode_unsupported`**). The deploy payload carries one TLS
field, `EnvironmentDeployHosting.tlsId` — a resolved pin, or null meaning
`tls internal` — so there is no wire spelling for "obtain one for me", and
projecting `automatic` as a null pin would answer a request for a managed
certificate with a self-signed one. The mode stays in the type so the refusal
can say that, instead of "unknown mode". Whether a ref **resolves** is sourced the way `knownSourceIds`
is: `lintComposeYaml` takes **`knownTlsIds`** / **`knownIpIds`** (ids *and*
labels — a `tls` name, an `ip` address — since that is what an operator has in
front of them) and emits a blocking error at
`services.<name>.x-turbopanel.hosting[i].tls.certificateRef` / `.bind.ipRef`;
omitted, the rule is **skipped** rather than false-flagged.

**Materialization.** At deploy-prepare, right after
`reconcilePrincipalsFromCompose`, `reconcileHostingsFromCompose`
(`src/client/environments/reconcile-hostings.ts`) upserts one `hosting` row per
entry, keyed on `(serviceId, hostname, pathPrefix)` and stamped
`metadata.composeOwned` (`src/lib/hosting-compose-owner.ts`, the same
jsonb-marker shape `principal.metadata.composeAlias` uses). `options` is written
in the existing `HostingOptions` shape — `hostnames`, `pathPrefix`, `targetPort`,
`proxy.forceHttps`, `bind` — so `buildHostingsForService` / `resolveHttpHostingEntry`
in `deploy-routes.ts` and the daemon's ingress, site, and TLS lanes read the rows
exactly as before and never learn compose exists. Panel-only fields on the row
(`web.env`, PHP hints, `protocol` / `ports`, `description`) are **merged, not
clobbered**; every field compose does author is asserted, including by deletion.
Compose-owned rows whose declaration disappears are pruned.

**Adoption.** A panel-authored row on the same service already serving the
*same* `(hostname, pathPrefix)` is **taken over**, not duplicated — two rows for
one route is what `validateDeployHostings` refuses, so a document that merely
wrote down a route the panel already served would otherwise break the deploy.
The adopted row is stamped `metadata.composeAdopted` as well, and when its
declaration later disappears it is **released** (compose keys stripped, row
kept, panel editing works again) rather than deleted. A panel row that serves
the declared hostname **alongside others** cannot be adopted losslessly and is
reported instead: **`409 hosting_route_conflict`**, naming the row and the
hostnames the takeover would have dropped. Every other row without the marker
is still never touched, adopted, or pruned, which is what keeps this additive.
An unresolvable (or ambiguous) ref is **`422 hosting_tls_ref_unresolved` /
`hosting_ip_ref_unresolved`** — never a silently dropped pin, because a route
that quietly falls back from the named certificate to a self-signed one is the
exact failure the field was added to prevent.

**API posture.** `PATCH` / `DELETE /hostings/{id}` on a compose-owned row is
**`409 hosting_owned_by_compose`** naming the owning `serviceId` and compose
service — not 403, because it is not a permission problem: the next deploy would
overwrite the write. Rows created in the panel keep working unchanged.

### Per-service Git source (`x-turbopanel.source`) — resolved into `sourceMaterial[]`

`services.<name>.x-turbopanel` accepts an optional **`source`** block:
`{ sourceId, branch?, subdirectory?, buildCommand?, startCommand?, outputDirectory? }`
(`src/lib/compose/service-kind.ts` — `parseServiceSourceExtension`,
`SOURCE_BRANCH_MAX_LENGTH` / `SOURCE_COMMAND_MAX_LENGTH`; the path fields reuse
the exported `isSafeRoot` rule that already guards `root`). It is no longer
inert. Deploy prep resolves every binding into payload **`sourceMaterial[]`**
(`src/client/environments/deploy-sources.ts`): the `repository` row is loaded
org-scoped, the ref resolves to a commit (GitHub REST for `provider: 'github'`;
generic SSH passes the ref through until `ls-remote` resolution lands), a
short-lived clone credential is minted/resealed as a `tpdaemon` envelope, a
`releaseId` is allocated, and the owning principal is pinned with the same
sole-steward rule site uses (ambiguous →
`source_principal_ambiguous`; unresolvable ref → `source_ref_unresolved`). Each
entry's `commitSha` is folded into **`desiredHash`** (compose YAML + sorted
`composeServiceName=commitSha` pairs) so a redeploy against an unchanged commit
stays a genuine no-op while a moved commit is not; deploys with no
`sourceMaterial[]` hash exactly as before. The daemon release engine
(`../../../../turbopaneld/src/deploy/release/`) checks out, builds, and
atomically promotes `<principalHome>/sites/<serviceId>/current`.

`startCommand` **is** carried on the wire now
(`EnvironmentDeploySourceBuild.startCommand`, same non-secret validation as
`buildCommand`): a `serviceKind: node` service is supervised from it. It is
inert for every other kind — the release engine never executes it. Because a
source may legitimately be pre-wired on any `serviceKind`, the linter still
emits a **non-blocking** advisory (`blocking: false`) rather than gating on
`serviceKind`. **Where `sourceId` resolution lives:** the compose parser and
linter are pure and have no database, so "does this id exist for the org?" is
enforced at the write boundary — project/environment create + PATCH load
`loadOrganizationRepositoryIds` (`src/lib/db/repository-records.ts`) once per request
and pass it as `lintComposeYaml(…, { knownSourceIds })`; an unresolvable id is a
blocking `error` at `services.<name>.x-turbopanel.source.sourceId`. When
`knownSourceIds` is omitted the check is **skipped**, never failed. Source rows
themselves are org-owned (`src/client/repositories/routes.ts`); deleting one still
referenced by a stored compose returns **409** `source_referenced_by_compose`.
`ui/src/lib/compose/service-kind.ts` + `lint.ts` mirror the types and both
rules.

**One repository per project.** `project.repository_id` names the single Git
repository a project *is*; `null` means the project is not repository-backed.
Every `x-turbopanel.source.sourceId` in a project's compose (base **and** every
environment overlay) has to name that row — a second distinct id is a blocking
`error` at `services.<name>.x-turbopanel.source.sourceId`. The per-service block
is unchanged and still carries `branch` / `subdirectory` / `buildCommand`, which
is how one checkout builds several services out of a monorepo. Enforced by
`lintComposeYaml(…, { projectRepositoryId })` — omitted skips the rule (same
contract as `knownSourceIds`), `null` weakens it to "at most one distinct id"
because the save that introduces the first repository is the one the project
**adopts** it on (`adoptProjectRepository`, `src/lib/db/repository-records.ts`).
Adoption never overwrites an existing binding; moving a bound project is an
explicit `PATCH /projects/:id` with `repositoryId` (or `null` to unbind), which
is validated against the same rule in the same save. Deleting a repository a
project is bound to returns **409** alongside the compose reference check, and
the FK is `ON DELETE RESTRICT` behind it. `ui/src/lib/compose/lint.ts` mirrors
this rule too.

### Native apps (`serviceKind: node`) — `native-app.ts`

`services.<name>.x-turbopanel` accepts a third **`serviceKind: node`**: a
Git-backed process supervised on the host by a generated systemd unit, in
neither Docker Compose nor a document root. It requires **`source`** (without a
repository there is nothing to check out, build, or supervise —
`validateNodeConsistency`), and rejects `image` / `build` outright rather than
ignoring them, because deploy strips the service out of runtime compose entirely
and the image would never be pulled. Two optional hints are valid **only** on
this kind: **`framework`** (`auto` | `node` | `next`, default `auto` — `auto`
defers to the daemon's post-build detection) and **`nodeVersion`** (a pin like
`24` / `24.17.0`, never a range). `node` joins `site` in the linter's
image/build exemption (`isHostNativeServiceKind`) and in the per-layer strip
(`collectSiteServiceNames` / `stripSiteServicesFromLayer`,
both host-native-wide despite the historical names).

Deploy prep strips node services into payload **`nativeAppServices[]`**
(`{ composeServiceName, serviceId, listenPort, framework, nodeVersion?, resources?, accountLimits?, restartPolicy?, serviceLabels? }`)
the same way it strips sites, and their releases ride the
ordinary `sourceMaterial[]` lane unchanged. **Plain Compose keys the split would otherwise take with it.** A node service is
removed from `containerServices`, so any ordinary Compose key on its body leaves
with it unless `native-app.ts` reads it out first. Two do:

- `deploy.restart_policy` → `NativeAppServiceSpec.restartPolicy`, carried in
  **Compose** vocabulary. What TurboPanel could honour on this lane is bounded —
  `condition` must be `none` / `on-failure` / `any`, `delay` and `window` must be
  Compose durations, and `max_attempts` must be at least 1 (`StartLimitBurst=0`
  means *no* rate limit to systemd, the opposite of "do not retry").
  `readNativeAppRestartPolicy` returns what it can carry **plus** the authored
  keys it cannot, and `lintNativeRestartPolicy` turns each of those into a
  `field_unsupported` diagnostic — advice while editing, a refusal at deploy.
  Nothing is dropped in silence. Container services keep the whole Compose
  vocabulary: Docker reads it itself.
- `deploy.labels` → `NativeAppServiceSpec.serviceLabels`, service metadata. Both
  Compose spellings are read (a mapping, or a sequence of `KEY=VALUE`). It never
  becomes container `labels:` on either lane.

Both ride the wire. `deploy-prepare.ts` copies them onto
`EnvironmentDeployNativeAppService.restartPolicy` / `.serviceLabels`
(`lib/commands/schemas.ts`), the daemon re-validates them in
`instance/commands/contracts.ts` — the payload is untrusted input to that
process, and every one of these values ends up as a systemd directive — and
`deploy/native/unit.ts` is the single place the **Compose** vocabulary becomes
systemd's: `condition` → `Restart=` (`any` is `always`, `none` is `no`),
`delay` → `RestartSec=`, `max_attempts` → `StartLimitBurst=`, and `window` →
`StartLimitIntervalSec=`. The two rate-limit directives are `[Unit]`, not
`[Service]`, so they are emitted apart from `Restart=`. A payload that carries
no policy renders the historical `Restart=on-failure` / `RestartSec=2`
verbatim, so adding the field rewrote no existing unit and restarted no tenant
app. `serviceLabels` carries no behaviour: it is recorded as one sorted
`X-TurboPanel-Labels=<json>` line, so `systemctl show` answers on the native
lane what `docker inspect` answers on the container one, and JSON escaping is
what stops a label value containing a newline from becoming a directive of its
own.

**One loopback-port ledger covers
both lanes**: `splitSiteServices` and `splitNativeAppServices` share a
`usedPorts` set, and so do `assignSiteListenPorts` /
`assignNativeAppListenPorts` at payload-assembly time — a vhost and an app
handed the same 127.0.0.1 port would leave whichever bound second dead with no
diagnostic near the cause. The resolved port is folded into `desiredHash`
alongside each source's `commitSha`, so a moved port is a genuinely different
desired state rather than a no-op redeploy that never re-renders the unit.

`serviceId` is deliberately **not** produced by prepare. It is resolved at
payload assembly (`buildNativeAppServicesForDeploy` →
`resolveDeployReleaseServiceId`) with the exact precedence the daemon's
`resolveReleaseServiceId` uses — hostings, then tcp/udp ingress, then the
compose key — because deriving the release-tree segment twice from different
inputs would point a unit's `WorkingDirectory` at a tree nothing ever published.
`resources` comes from the same clamped service options containers use;
`accountLimits` is the effective org ∩ server ceiling, repeated on every app of
a principal so the daemon can build one `turbopanel-<username>.slice` per
account. Daemon side: `../../../../turbopaneld/src/deploy/native/`.

### Multi-file compose merge + layer model

Merge semantics are now **Compose Spec–faithful** rather than a shallow deep-merge: `mergeComposeDocuments` (`merge.ts`) resolves each attribute per the [Compose Spec merge rules](https://docs.docker.com/reference/compose-file/merge/) — sequences with unique keys (`ports`, `volumes`, `secrets`/`configs`, `expose`/`extra_hosts`) **append with attribute-specific key-based / scalar dedup**, while `dns` / `dns_search` / `tmpfs` / `env_file` and other plain lists **append preserving duplicates**, map/list-dual attributes (`labels`, `environment`, `depends_on`, `extra_hosts`) are normalized then key-merged, and `command` / `entrypoint` / `services.<name>.healthcheck.test` always **fully replace** (never append) per spec. Authors can escape the default behavior with the reserved **`!reset`** (delete the key) and **`!override`** (force full replacement instead of append/merge) YAML tags — stored compose lives in Postgres jsonb, so `tags.ts` encodes them as JSON-safe `ComposeTaggedValue` sentinels (`{ __turbopanelComposeTag: 'reset' | 'override', value }`) on parse and restores the real YAML tags on stringify.

`layers.ts` introduces the **`ComposeLayer`** type (`{ role: 'project' | 'environment' | 'platform', filename, document }`) and `mergeComposeLayers` (a thin left fold over `mergeComposeDocuments`, later layers win) as the **authoring** merge model (project + optional environment). Per-layer pure transforms — site strip (`stripSiteServicesFromLayer`), volume rename (`renameComposeVolumesInLayer`), and placement strip (`stripComposePlacementFromLayer`) — operate on one `ComposeLayer` at a time (looking through `!reset`/`!override` tags via `mapThroughTag` and preserving them) so each authored document stays independently valid compose. **Network pruning stays merged-view-only** (`pruneUnreferencedComposeNetworks`) and is intentionally not exposed per-layer — pruning a network from one layer could delete a network another layer still references; it only ever runs against the fully merged effective document.

Deploy does **not** send that authoring chain to daemons. After merge + schedule + allocate, `compileRuntimeComposeDocument` emits one runtime document per participating server. Managed ingress `extra_hosts` are per bound consumer service (reserved ProxySQL address on a spanning network that service joins), never server-global — co-resident bindings still join the organization's managed network (bare-UUID name from the `network(kind='managed')` row, sent as `managedNetwork` — see `../db/AGENTS.md`), and a remote extra_hosts entry on one service must not drop that attachment for others. `renderRuntimeComposeFiles` wraps it as `[{ filename: 'compose.yaml', role: 'runtime', source: 'inline', content }]`. Non-secret variables persist in a generated project `.env` (`envFile`); compiled YAML uses `${service__KEY}` interpolation. Secret `{$KEY}` / `{$scope.KEY}` refs (and binding-owned secrets) compile to Compose standalone `secrets:` with host `file:` paths under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` plus a courtesy `KEY_FILE` path — values travel as `variableMaterial[]` `tpdaemon` envelopes, never in YAML. Daemon overlay fragments (storage, Traefik, site reachability) merge **into that single file** on the host and do **not** inject secrets. The deprecated **`composeYaml`** field is the same compiled body for older daemons and for UI display; it is not a second file.

### The compiler IR — four models (`ir.ts`)

The deploy compiler has always had four stages; `ir.ts` gives the three boundaries between them names, so the chain is a type signature instead of a set of local variables threaded through one 3,300-line function.

```
ComposeLayer[]  ──mergeComposeLayers──▶  Application  ──reconcile/schedule/allocate──▶  ResolvedApplication  ──split + compileRuntimeCompose + edge──▶  ServerDeployment
   (authored)                            (normalized)                                    (placed)                                                       (per server)
```

1. **Authored** — `ComposeLayer[]` (`layers.ts`), described in the section above. Deliberately *not* redeclared in `ir.ts`: the authored stage already has a type, and a second name for it is exactly the drift this module exists to remove.
2. **`Application`** — the merged document read once into named parts: per service its `kind`, its parsed `x-turbopanel`, its interpreted `deploy:` (`ServiceScheduleSpec`, from `../schedule/interpret.ts` — the same interpreter the planner uses), its `hosting[]` and its principal alias; plus the root's principal aliases and the top-level `networks` / `volumes` / `secrets` / `configs`. **A read view, not a new parse pass.** Every field comes from a parser that already existed (`service-kind.ts`, `hosting-extension.ts`, `root-extension.ts`, `../schedule/interpret.ts`); what changed is that those are called once per document instead of ad hoc per call site. Pure and DB-free — the linter, the visual editor and a deploy can all build the same model from the same bytes.
3. **`ResolvedApplication`** — the same services after the control plane answered what a document cannot: which `service.id` each compose key reconciled into, which `principal.id` each alias materialized into, where the scheduler placed every replica (`slots[]`, each marked `local` for the server this slice compiles for), which containers were allocated, what the clamped resource ceiling is. `scheduled` distinguishes *no plan* (unscheduled: everything runs here) from *a plan that placed nothing here* (nothing runs here) — conflating the two would silently deploy a whole environment onto one host.
4. **`ServerDeployment`** — what one server is told to run, **in full**: the compiled runtime document and its material, the host-native lanes (sites, native apps, sources), *and* the edge — `hostings[]`, their `tlsMaterial[]`, `hostingIngress` / `hostingIngressNetwork`, and the org's `listenerPorts`. Its fields are the daemon-facing `EnvironmentDeploy*` wire types from `../commands/schemas.ts` **verbatim**; `PreparedDeployCompose` (`../../client/environments/deploy-prepare.ts`) is this type plus control-plane bookkeeping that never reaches a daemon (hooks, container rows, the expansion map, soft warnings, the echoed source selection). **The edge belongs to the compiler, not to the route.** It used to be assembled in `deploy-routes.ts` after `prepareDeployCompose` returned, which left "one server deploy" split across a compiler and a transport layer and made `ServerDeployment` a name for only half of it; `prepareDeployCompose` now returns the whole object and the deploy route enqueues it. Preview compiles no edge — the same rule that empties `variableMaterial` / `storageMaterial` for a dry run, applied to a sealed TLS key and to `ensureSystemHierarchy`, which *provisions* a server's shared ingress project.

`buildApplicationModel` and `buildResolvedApplication` are **projections over values the caller already computed**. They reach no database and decide nothing, which is the property that makes naming the stages safe: the pipeline order (merge → validate → reconcile → interpret `deploy:` → schedule → allocate → split → compile) is unchanged, and so is every byte a daemon receives. `ResolvedApplication` is fed the clamped ceiling per service (`resourcesByComposeServiceName`), and the later steps that need one — the native-app unit limits, the org/server resource gate — read it back off `ResolvedApplication.services[]` rather than the loose `service.options` map, so the stage is the source of truth it claims to be instead of a partial projection two call sites can disagree with. `ResolvedApplication.principals` is the same alias → `principal.id` map `reconcilePrincipalsFromCompose` returns, which is what materializes `principal` / `tenancy` rows — see `../db/AGENTS.md`.

### Spanning networks (TurboFabric)

**`networks.<key>.driver: overlay` is the authored contract.** A compose network is TurboFabric-eligible only when the merged document's top-level `networks:` declares it with `driver: overlay`; `collectSpanningComposeNetworkKeys` (`../fabric/spanning.ts`, via `readOverlayDeclaredNetworkKeys`) then intersects that declared set with the keys whose members land on ≥2 servers. **Server count alone no longer promotes a network** — before, any key whose services happened to be scheduled onto two hosts silently became a `tpn_*` routed bridge (the implicit `default` included), so a placement decision changed what the document meant and `driver: bridge` was indistinguishable from declaring nothing. Compose already has a standard expression for overlay intent, so TurboPanel reads that instead of inventing an `x-` key. A document with no `networks:` block never spans; `networks.default.driver: overlay` opts the default network in like any other key.

**`NETWORK_FIELD_POLICY` is the strict-attribute gate** (`field-policy.ts`, `classifyNetworkKey(key, driver)`). An overlay network is not handed to a Docker overlay driver — there is no Swarm control plane — it is materialized as a `network(kind='compose')` row whose per-host segments compile to a routed bridge, so four attributes an overlay driver would have read have nothing to read them and are `unsupported` **only when `driver: overlay`**: `ipam` (the subnet is allocated per host out of that host's relay prefix), `driver_opts` (no overlay driver to receive them), `attachable` (a Swarm service-network flag; every container here is already standalone), `enable_ipv6` (fabric and segment allocator are IPv4-only). On a `bridge` or default network all four stay `passthrough` and go straight to Docker exactly as before. `lint.ts` emits them as `field_unsupported` — non-blocking warning at save, blocking error under `strict: true` — plus a non-blocking `turbofabric_required` note on the `driver:` line itself; the linter is pure and cannot see the fabric row, so the real 422 stays in `lib/schedule/planner.ts`.

Spanning `network(kind='compose')` compiles to `external: true` + `name: tpn_<networkId>`; each local slot's address comes from `slot.address` and is emitted as `networks.<key>.ipv4_address`; multi-replica spanning services expand to `<name>-<ordinal>` so each replica carries a distinct address. `compile-runtime.ts` and the external-network gate are unchanged by the eligibility rule: both already read only the `spanningNetworks: Map<key, tpn_name>` / the *authored* document, never `driver:`.

**`serviceDnsName` contract** (`src/lib/naming.ts`) is the single naming authority: most-specific-first, `('web', 1, 'env-1') → ['web-1.env-1', 'web.env-1']`, `('web', null, 'env-1') → ['web.env-1']`. Compile emits these as static `extra_hosts` for sibling services that share at least one spanning network (never the service itself, never cross-environment/cross-project). **Why the shape matters:** these entries are a stop-gap superseded by an embedded resolver in the daemon later — keeping the name set behind `serviceDnsName` makes that a drop-in swap.

**`fabricNetworks[]` vs `dockerExternalNetworks[]`** — both end up as pre-`compose up` `docker network create`, but they are disjoint sets with different owners: `dockerExternalNetworks[]` are operator-registered org `network(kind='docker')` rows with `options.dockerNetworkName` (unregistered → **422** `docker_external_network_unregistered`); `fabricNetworks[]` (`{ name, subnet, gateway?, mtu? }`) are platform-owned `tpn_*` routed bridges derived from `subnet` rows (compose-bridge CIDRs, not datacenter subnets). **Record why:** `tpn_*` must never hit the external-network registration gate — it is allocated by the compiler, not declared by the operator, so requiring a registry row would make every spanning deploy fail. The bypass is structural rather than a special case: a spanning network is authored `driver: overlay` and never sets `external:`, and `collectComposeExternalDockerNetworkNames` matches only an authored `external:` on the *pre-compile* document. It also gives the daemon a belt-and-braces path if `server.fabric.reconcile` lands stale.

