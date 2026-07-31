# Managed engines (`src/lib/managed/`)

Pure-TypeScript registry for environment-scoped managed database/cache engines
(Postgres first). Importable from both the Workers and Deno graphs — no
Deno/Node globals, `.ts` relative imports only.

## Spec contract

Each engine implements `ManagedEngineSpec` (`types.ts`): identity defaults
(`defaultImage`, `defaultPort`, `rootUsername`, `principalProvider`),
`parseSettings`, `buildRuntimeSpec`, `buildConnectionInfo`, and declarative
`userOperations` (no SQL text — the daemon owns statement construction).

**Extension rule:** a new engine = one spec file + one registry entry in
`MANAGED_ENGINE_SPECS` + one status entry in `MANAGED_ENGINE_STATUS`. Nothing
else.

## Runtime spec rules

1. **No plaintext secrets.** Credential slots in `ManagedRuntimeSpec.env` use
   the literal `ManagedSecretPlaceholder` (`${TURBOPANEL_MANAGED_ROOT_PASSWORD}`).
   The daemon substitutes from the decrypted `credentials[]` envelope. Plaintext
   passwords must never appear in a runtime spec.
2. **Native port, no remap.** Compose fragments never include a `ports:` key.
   The container listens on the engine's native port; exposure is Traefik's job
   via `exposure`.
3. **Named volumes only.** `volumes[]` are Docker named volumes — never host
   bind paths. Config/TLS dirs are relative mounts under managed state.
   Volume **names** must satisfy `SAFE_IDENTIFIER_RE` /
   `SAFE_VOLUME_NAME_RE` (`^[A-Za-z_]\w*`, ≤63 chars) — use underscores, not
   hyphens (e.g. `managed_<uuid_with_underscores>_data`).
4. **TLS is a request.** `tlsMaterial` asks the daemon to generate key material;
   the instance never ships private keys in the spec.
5. **Docker option denylist.** `MANAGED_DOCKER_OPTION_DENYLIST` rejects
   `privileged`, `network_mode`, `volumes`, `ports`, `cap_add`, etc. Denied or
   unknown keys make `parseSettings` return `null` (API → 400).

## Settings

Shared shape in `settings.ts` (`ManagedSettings`): `image`, `ssl`, `resources`
(reuses `ServiceOptions['resources']` + `clampManagedResources`),
`dockerOptions` (strict allowlist), `engineConfig` (16 KiB cap), `exposure`
(`HostingBindScope` from `hosting-options.ts`), `backups` (`retentionKeep`,
`parseBackupSettings`). Parser semantics: absent → defaults; malformed/denied
→ `null`.

## Backup descriptor

`ManagedEngineSpec.backup` (`types.ts`) is an **optional** capability —
engines without it are simply unsupported for backup/restore (the API and
daemon both check for its presence rather than special-casing engine codes).
It carries `artifactExtension` (from the `MANAGED_BACKUP_ARTIFACT_EXTENSIONS`
allowlist — `dump` \| `sql`), `supportsDatabaseScope` /
`supportsInstanceScope`, `defaultRetentionKeep` / `maxRetentionKeep`, and an
`executor: { kind: 'docker-exec', dumpClient, restoreClient }`.

**Same rule as `userOperations`: no argv or SQL text here.** The descriptor
only names the client binaries (`pg_dump` / `pg_restore` for Postgres) —
the daemon's `ManagedEngineRuntime.backup` (mirrored in
`daemon/src/managed/engines/`) owns actual argv construction. This keeps the
instance spec import-safe on both Workers and Deno and keeps command
construction in one place (the daemon, which also validates identifiers
before they reach argv).

Postgres backs up via `pg_dump -Fc` (custom format), per-database only —
`supportsInstanceScope: false` documents `pg_dumpall` as an explicit future
seam. **Scheduled backups are also an explicit future seam** — this pass adds
on-demand create/delete/restore only; no timers, no cron, no retention sweep
outside of the retention-keep pruning that runs on every successful backup.

## Container naming

The engine container is named `<service.id>-1` via `managedContainerName`
(`src/lib/naming.ts`). When `exposure.enabled`, apply-prepare also allocates a
second `service` + ordinal-1 `container` for the dedicated Traefik ingress
(`composeServiceName` = `managedIngressComposeServiceName(engine)` →
`<engine>-ingress`; container name again `<ingressServiceId>-1`). The engine
compose **project** stays `turbopanel-managed-<managedId>`; the ingress
project is `turbopanel-managed-<managedId>-ingress`. Engine-spec volume keys
(`pgdata`, …) are deliberately left alone because Compose namespaces them
under the engine project, so they are already unique per managed service.

`buildManagedApplyPayload` (`src/client/managed/apply-prepare.ts`) explicitly
creates those rows via `ensureManagedContainerAllocation` (instead of relying
on reconcile auto-creation), stamps engine `containerName` and optional
`ingress: { serviceId, composeServiceName, containerName }` onto the
`managed.apply` payload, and prunes pending null-id ingress container rows
when exposure is disabled (leaving the `service` row for idempotent reuse).
Coverage: `src/client/managed/apply-prepare.test.ts` calls
`buildManagedApplyPayload` for both exposure-enabled and exposure-disabled
paths (not only the lower-level allocator).
