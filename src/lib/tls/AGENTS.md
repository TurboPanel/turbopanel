# TLS & certificate authorities (`src/lib/tls/`)

Web-Crypto-only primitives for the **Organization CA** (managed-database /
ProxySQL / replication leaves) and the org TLS library. Importable from both
the Workers and Deno graphs — no Deno/Node globals, `.ts` relative imports
only.

**Future:** tenant **hosting** leaves (Caddy-fronted web services) remain
operator-pinned library certificates or Caddy `tls internal`. They are never
issued by the Organization CA.

Root context: `../../../AGENTS.md` (Caddy + TLS). Client TLS / SSL mode:
`../managed/AGENTS.md`. Command payload comments:
`../commands/AGENTS.md`. Org TLS routes: `../../client/tls/`. Platform CA path
resolution: `../../server-paths.ts`.

**This file owns the Platform CA vs Organization CA comparison.** Other docs
link here rather than restating the table.

## Platform CA vs Organization CA

| | **Platform CA** | **Organization CA** |
|---|---|---|
| Scope | one per control plane | one active per organization |
| Storage | files under `<stateDir>/tls/` (`ca.crt`, `ca.key`, `ca-bundle.pem`) | `tls` row, `source='organization_ca'`, `ca_state` / `ca_generation`, key sealed `tpsecret` |
| Minted by | `turbopanel/scripts/generate-self-signed-cert.mjs` (`ensureCa()`) | `mintOrganizationCa({ organizationId })` in `turbopanel/src/lib/tls/self-signed.ts` (`O=TurboPanel, OU=Organization CA, CN={org.id}`) |
| Signs | the control-plane Caddy leaf only | managed-database / ProxySQL / replication leaves for that org |
| Consumed by | daemons (`/etc/turbopanel/instance-ca.pem` via `GET /api/daemon/v1/instance/ca`) | ProxySQL, managed engines, binding `<PREFIX>_CA_CERT`, SQL clients |
| Rotation | `TURBOPANEL_TLS_CA_ROTATE=1` + `server.tls.trust.reconcile` | `POST /api/client/v1/tls/ca/rotate` then `POST /tls/ca/retire` |
| Hard rule | org TLS code must never read or write these paths | never anchors daemon → control-plane trust |

## Module map

All of this package is Web-Crypto-only and Workers-safe.

| File | Role |
| --- | --- |
| `self-signed.ts` | `mintOrganizationCa` (subject `O=TurboPanel, OU=Organization CA, CN={organizationId}`), `issueLeafCertificate` (`ORGANIZATION_CA_LEAF_VALID_DAYS` = 90), `mintSelfSignedCertificate`, `verifyCertificateSignature` |
| `parse.ts` | Certificate PEM parse |
| `pem.ts` | PEM encode / decode |
| `keys.ts` | Private-key / certificate match |
| `asn1.ts` | Minimal ASN.1 reader used by parse / issue |
| `match.ts` | Hostname coverage for library certs |
| `metadata.ts` | Persistable TLS metadata columns |
| `types.ts` | Shared types (`TlsSource`, parsed cert, …) |
| `index.ts` | Barrel re-exports |

## Consumers of the Organization CA

Read-only reference — no behavior claims beyond today:

- `loadOrganizationCaSet` in `../../client/tls/organization-ca.ts` — **only**
  Organization-CA reader (`ca_state IN ('active','retired')`); returns
  `{ signer, trustBundlePem }`
- `ensureActiveOrganizationCa` / `buildManagedOrgTlsMaterial` /
  `buildOrgTlsMaterialForServer` / `attachManagedOrgTlsMaterial` in
  `../../client/managed/apply-prepare.ts`
  (leaf signing uses `signer.*`; `caCertPem` / `<PREFIX>_CA_CERT` ship
  `trustBundlePem`; minted engine-leaf details ride command metadata as
  `pendingTlsLeaf` and are upserted onto `leaf` `kind='engine'` only after
  `managed.apply` succeeds)
- `buildOrgTlsForServer` in `../../client/managed/ingress-desired.ts`
  (same pending-metadata path for `leaf` `kind='ingress'` on
  `managed.ingress.reconcile` success)
- `computeBindingVariableSet` in `../../client/bindings/materialize.ts`
-   `GET /tls/ca` / `POST /tls/ca/rotate` / `GET /tls/ca/rotation` /
  `POST /tls/ca/retire` / `GET /tls/ca/download` in
  `../../client/tls/routes.ts` (JSON and download serve the overlap bundle;
  rotate fans existing `managed.apply` / `managed.ingress.reconcile` commands
  and rematerializes bindings — see `../commands/AGENTS.md`. Repeat POST
  while `in_progress` resumes the stored cursor without minting another
  generation. `GET /tls/ca` also returns `leafHealth: { dueCount,
  caGeneration, caNotAfter }` (one indexed COUNT on `leaf` for this org
  plus the active Organization CA generation and expiry). `TlsPublicRow`
  includes `caGeneration`. `POST /tls/ca/retire`
  advances `retired` → `revoked` only after every tracked command succeeded
  and binding rematerialize rows are not failed).
  `PATCH /tls/:id` with `revoke: true` on an Organization CA row is rejected
  (`409` `organization_ca_retire_required`); Organization CA retirement is
  exclusively `POST /tls/ca/retire`.

## Where the Platform CA lives instead

- `../../server-paths.ts` (`resolveInstanceTlsCa*` / `TURBOPANEL_TLS_CA*`)
- `../../../scripts/generate-self-signed-cert.mjs` (`ensureCa()`)
- `../../admin/tls-trust-reconcile.ts`
- `../../daemon/api-routes.ts` (`GET /api/daemon/v1/instance/ca`)

## Hard rule + guard

Organization CA / org TLS library code (`src/lib/tls/`, `src/client/tls/`) must
never reference `TURBOPANEL_TLS_CA*`, `resolveInstanceTlsCa*`, `ca-bundle.pem`,
or `instance-ca.pem`, and must never import `server-paths.ts`. Enforced by
`pnpm check:ca-boundary` (`scripts/check-ca-boundary.mjs`), chained into
`test:hook` immediately after `check:vocabulary` and gated in CI `build.yml`
before `pnpm test:coverage`.

The guard has **no allowlist entries** other than its own script path (`SELF`),
which is required because the script contains the forbidden literals. Widening
that allowlist (or adding scan exemptions) needs review — it is how Platform CA
paths would leak into Organization CA code. Prefer moving a legitimate Platform
CA reference out of `src/lib/tls/` / `src/client/tls/` over punching a hole.

## Leaf tracking + renewal sweep

Managed leaves from `issueLeafCertificate` are 90-day and used to be minted
transiently on every `managed.apply` / `managed.ingress.reconcile`. They are
now tracked in **`leaf`** (`src/lib/db/schema.ts` `leaf`) as
successfully **deployed** leaf state — not payload generation:

| Column | Role |
| --- | --- |
| `kind` | `'ingress'` (ProxySQL frontend, one per server) or `'engine'` (per `node`) |
| `ca_id` / `ca_generation` | signing Organization CA row + generation |
| `not_after` | leaf expiry (`timestamptz`) |

Re-issuance **upserts** (partial uniques `uniq_leaf_ingress_server` /
`uniq_leaf_engine_node`) — no history. Helpers:
`src/client/tls/leaf-tracking.ts`. Mint sites (`buildOrgTlsMaterialForServer` /
`buildOrgTlsForServer`) persist freshly minted details as command metadata
(`pendingTlsLeaf`); the command consumer upserts `leaf` only on success of
`managed.apply` / `managed.ingress.reconcile`. Enqueue or terminal failure
leaves the previous deployed `notAfter` visible to `loadDueTlsLeaves` /
`countDueTlsLeavesForOrganization`.

**Due:** remaining lifetime < issued lifetime / 3 (30 days of the 90-day
default) **or** `ca_generation` no longer matches the org's active signer.
Sweep query (`loadDueTlsLeaves`) is org-agnostic, ordered by `not_after`
ascending, keyset-cursor paginated (`notAfter`, `id`), `LIMIT`
`LEAF_RENEWAL_BATCH_SIZE` (10) — never `OFFSET`, never per-org enumeration.

Per due row the sweep reuses existing enqueue paths (`enqueueManagedIngressReconcile`
/ `enqueueApplyForManagedCluster` from `rotation-fanout.ts`) — it does not fork
a second reissue path. Successful **command** (not merely enqueue) remints a
90-day leaf and upserts the tracking row, so the leaf drops out of the due set.

**Lease + cursor:** `setting` row `LEAF_RENEWAL_SWEEP_LOCK` (owner + expiry +
last keyset cursor, steal-stale CAS) — same lease shape as `REENCRYPT_SWEEP_LOCK`
/ `tryBeginReencryptSweep`, plus a resumable cursor. The cursor advances after
each bounded batch and is reset only when the sweep completes (`rows.length <
limit`) or the stored cursor is invalid. Overlapping Workers isolates or a Deno
tick cannot double-fan-out; later due rows still progress when earlier rows keep
failing.

**Scheduled entry points:**

| Runtime | Tick | DB client |
| --- | --- | --- |
| Workers | existing cron (`workers.ts` `scheduled()` → `runOfflineSweep`) piggybacks one bounded batch on the **already-open** Hyperdrive client after `runSystemReconcileSweep` | reuse; never a second client |
| Deno | `startDenoServer` (`src/deno-server.ts`, covers `deno.ts` / `deno-dev.ts`) — first Deno-side scheduled surface besides cell maintain; `LEAF_RENEWAL_SWEEP_INTERVAL_MS` (5 min), overlap-guarded | **fresh** `createDenoDb()` per tick, always `endDbConnection` in `finally` |

Module: `src/client/tls/leaf-renewal-sweep.ts`. `GET /tls/ca` exposes
`leafHealth: { dueCount, caGeneration, caNotAfter }` via one org-scoped COUNT
plus the active Organization CA generation and expiry.

## Naming

Never write bare "the CA" in code comments, docs, API copy, or UI strings —
always **Platform CA** or **Organization CA**.
