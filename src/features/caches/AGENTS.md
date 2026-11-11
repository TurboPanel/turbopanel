# Project caches (`src/features/caches/`)

A project cache is one native Valkey process per row of `cache`, run as a chosen
Hosting Account of the environment, on the environment's server. Persistence and
eviction are the engine defaults; TurboPanel sets the memory limit, the socket or
loopback port, the named login (`app`, default user off) and the unit's memory
ceiling. Not a managed engine: `../managed/` is untouched.

**Workers rule:** every function uses the `db` it is handed; nothing is kept
between calls.

## Wire (feature `project-cache-v1`)

- Everything is sent only to a daemon that lists the feature
  (`PROJECT_CACHE_FEATURE`). Without it a write answers 409
  `daemon_update_needed` ("Update the daemon on this server to use project
  caches"), and a deploy that has a cache or a reach port is refused the same
  way; with none, `caches` and `helperReach` are left absent, never sent empty.
- With the feature, `environment.deploy` always carries the complete `caches`
  set for that server (an empty list clears it) and `helperReach`. A
  hostings-only run carries neither (absent leaves the host alone).
- `cache.apply` carries `{ environmentId, caches, removed? }`. It never prunes a
  cache that is only unlisted, so a delete sends `removed[]`. The data goes only
  when `deleteData` is set (the route default is on).
- `passwordSha256` is the SHA-256 of the UTF-8 password text. The plain password
  reaches sites only as a sealed variable.
- Ports are in the listen band 18080-18999 (the column allows more; the wire does
  not). Cache ports are reserved for every environment through
  `listReservedListenPorts`.

## Variables

`variables.ts` computes `REDIS_*` (the prefix is per cache) after binding output
and database references, at three call sites: deploy prepare (per service),
the hosting web environment (`withCacheHostingEnv`, before sealing) and secret
rehydrate (reads `deployment.options.cacheConsumers`). Consumers are sites and
`node` apps of the cache's account on the cache's server (`consumers.ts`).
Cache names override inherited scopes with a warning; a service- or
hostname-scope variable with the same name is refused (`conflicts.ts`).

## Helper reach

`x-turbopanel.reach` on a container (`{ port, from }`, validated in
`../compose/service-kind.ts`) publishes `127.0.0.1:<hostPort>:<port>`. All
services in `from` must run as one account; the container must run as one copy.
`reach.ts` plans, allocates (the previous port is kept) and injects the publish
into the compiled document in prepare, and names `TURBOPANEL_HELPER_<NAME>_HOST`
and `_PORT` for each `from` service. Helper ports are recorded in
`deployment.options.helperPorts` and `listenPorts`.

## Results and removal

`results.ts` writes `cache.status` and `cache.metadata` only for ids the command
carried. A failed or timed-out `cache.apply` moves its `applying` rows to
`failed`. `environment.stop` marks the environment's caches `stopped`.
Deleting a cache on an offline server removes the record only. Deleting a Hosting
Account that still has a cache is refused (`usedBy.caches`).
