# Compose documents — AGENTS.md

The comment-preserving `ComposeDocument` model, the reserved `x-turbopanel` extension (`placement` is rejected on validate and stripped defensively on input — pin lives on `environment.server_id`, never in compose), the compose linter, and overlay merge used by projects and environments.

Root context: `../../../AGENTS.md`. Command pipeline (deploy consumes runtime YAML): `../commands/AGENTS.md`. UI editor behavior: `../../../../ui/AGENTS.md`. The UI hides `x-turbopanel` (top-level and per-service) from the YAML surface and re-attaches it on save; the stored `ComposeDocument` and server validation are unchanged.

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
(presentation stripped). Deploy prep (`deploy-prepare.ts`) pipeline order: merge
project+env compose → `reconcileServicesFromCompose` → interpret Swarm `deploy:`
/ plan `task` rows (`src/lib/schedule/`) → **`allocateEnvironmentContainers`**
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
networks → **`compileRuntimeComposeDocument`** (`compile-runtime.ts`: strip
scheduler-only `deploy:` keys, filter to this server's services, rewrite
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
project/environment/platform layers or daemon overlay files. Deprecated
**`composeYaml`** equals that compiled body for older daemons. The reserved
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
fallback and the scheduler (`src/lib/schedule/`) may place `task` rows from
Compose `deploy.replicas` / `mode: global` / `placement.constraints`
(`node.labels.*` from the `label` table). A plan that would use **two or more
servers** requires org TurboFabric (`422 turbofabric_required`); a one-server
schedule stays ordinary Docker standalone. Compose never stores a pin.
Per-service **`services.<name>.x-turbopanel`** declares **`serviceKind`** —
`container` (default), `site`, or `node` (see the native-apps section
below). **`site`** takes required **`engine`** (`apache` | `nginx` |
`openlitespeed`) and optional relative **`root`** (default `public`), plus
optional operator **`description`** (string, max 500 chars — TurboPanel-only
metadata, not used by Docker) — validated in `src/lib/compose/service-kind.ts` /
`site.ts` and mirrored in the UI Visual editor + linter. Deploy prep
**strips** site services from Docker `composeYaml` into payload
**`sites[]`** (listen port + root); all three engines (`apache` /
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

### Per-service Git source (`x-turbopanel.source`) — resolved into `sourceMaterial[]`

`services.<name>.x-turbopanel` accepts an optional **`source`** block:
`{ sourceId, branch?, subdirectory?, buildCommand?, startCommand?, outputDirectory? }`
(`src/lib/compose/service-kind.ts` — `parseServiceSourceExtension`,
`SOURCE_BRANCH_MAX_LENGTH` / `SOURCE_COMMAND_MAX_LENGTH`; the path fields reuse
the exported `isSafeRoot` rule that already guards `root`). It is no longer
inert. Deploy prep resolves every binding into payload **`sourceMaterial[]`**
(`src/client/environments/deploy-sources.ts`): the `source` row is loaded
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
`loadOrganizationSourceIds` (`src/lib/db/source-records.ts`) once per request
and pass it as `lintComposeYaml(…, { knownSourceIds })`; an unresolvable id is a
blocking `error` at `services.<name>.x-turbopanel.source.sourceId`. When
`knownSourceIds` is omitted the check is **skipped**, never failed. Source rows
themselves are org-owned (`src/client/sources/routes.ts`); deleting one still
referenced by a stored compose returns **409** `source_referenced_by_compose`.
`ui/src/lib/compose/service-kind.ts` + `lint.ts` mirror the types and both
rules.

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
(`{ composeServiceName, serviceId, listenPort, framework, nodeVersion?, resources?, accountLimits? }`)
the same way it strips sites, and their releases ride the
ordinary `sourceMaterial[]` lane unchanged. **One loopback-port ledger covers
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

Deploy does **not** send that authoring chain to daemons. After merge + schedule + allocate, `compileRuntimeComposeDocument` emits one runtime document per participating server. Managed ingress `extra_hosts` are per bound consumer service (reserved ProxySQL address on a spanning network that service joins), never server-global — co-resident bindings still join `turbopanel-managed`, and a remote extra_hosts entry on one service must not drop that attachment for others. `renderRuntimeComposeFiles` wraps it as `[{ filename: 'compose.yaml', role: 'runtime', source: 'inline', content }]`. Non-secret variables persist in a generated project `.env` (`envFile`); compiled YAML uses `${service__KEY}` interpolation. Secret `{$KEY}` / `{$scope.KEY}` refs (and binding-owned secrets) compile to Compose standalone `secrets:` with host `file:` paths under `/run/turbopanel/deployments/<projectId>/<environmentId>/secrets/` plus a courtesy `KEY_FILE` path — values travel as `variableMaterial[]` `tpdaemon` envelopes, never in YAML. Daemon overlay fragments (storage, Traefik, site reachability) merge **into that single file** on the host and do **not** inject secrets. The deprecated **`composeYaml`** field is the same compiled body for older daemons and for UI display; it is not a second file.

### Spanning networks (TurboFabric)

Spanning `network(kind='compose')` compiles to `external: true` + `name: tpn_<networkId>`; each local task's address comes from `task.address` and is emitted as `networks.<key>.ipv4_address`; multi-replica spanning services expand to `<name>-<ordinal>` so each replica carries a distinct address.

**`serviceDnsName` contract** (`src/lib/naming.ts`) is the single naming authority: most-specific-first, `('web', 1, 'env-1') → ['web-1.env-1', 'web.env-1']`, `('web', null, 'env-1') → ['web.env-1']`. Compile emits these as static `extra_hosts` for sibling services that share at least one spanning network (never the service itself, never cross-environment/cross-project). **Why the shape matters:** these entries are a stop-gap superseded by an embedded resolver in the daemon later — keeping the name set behind `serviceDnsName` makes that a drop-in swap.

**`fabricNetworks[]` vs `dockerExternalNetworks[]`** — both end up as pre-`compose up` `docker network create`, but they are disjoint sets with different owners: `dockerExternalNetworks[]` are operator-registered org `network(kind='docker')` rows with `options.dockerNetworkName` (unregistered → **422** `docker_external_network_unregistered`); `fabricNetworks[]` (`{ name, subnet, gateway?, mtu? }`) are platform-owned `tpn_*` routed bridges derived from `segment` rows. **Record why:** `tpn_*` must never hit the external-network registration gate — it is allocated by the compiler, not declared by the operator, so requiring a registry row would make every spanning deploy fail. It also gives the daemon a belt-and-braces path if `server.fabric.reconcile` lands stale.

