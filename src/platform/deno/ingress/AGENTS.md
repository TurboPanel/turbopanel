# Self-Hosted Ingress (`src/platform/deno/ingress/`)

Code and admin routes that exist only on the self-hosted build. TurboPanel
High Availability (Workers) must not contain any of it.

- **Import rule.** Only `src/platform/deno/**`, `src/deno.ts` and
  `src/deno-dev.ts` may import this directory, test files included.
  `pnpm check:import-boundaries` fails any other importer (surfaces, features,
  lib, daemon cell).
- **Mounting.** `src/platform/deno/server.ts` imports `admin-routes.ts` and
  passes `registerIngressAdminRoutes` as `registerPlatformAdminRoutes` to
  `registerAdminRoutes`, so the admin session middleware still applies. Add new
  routes inside that registrar; never mount them from anywhere else.
- **Workers answers 404, not 422.** The route does not exist there.
  `src/admin/platform-admin-routes.hostfree.test.ts` and
  `src/workers.entry.test.ts` assert the route table has no `tunnel-token`,
  `ingress` or `acme-dns` paths.
- **ACME boundary.** This directory is scanned by
  `scripts/check-instance-acme-boundary.mjs` as instance code: it must not
  reference an organization ACME opt-in.
- **Prefix.** Every route sits under `/api/admin/v1`, so no Caddy or
  `wrangler.jsonc` `routes` change is needed.
- Today it holds `POST /instance/tunnel-token` (the Workers OpenAPI spec leaves
  that path out), `GET /instance/ingress/trusted-proxies` and
  `POST /instance/ingress/trusted-proxies/refresh`.
- **Provider interface.** `provider.ts` defines `preflight`, `apply`, `status`
  and `remove`; `capabilities.ts` holds the capability table (one record per
  mode, pinned cell by cell by `capabilities.hostfree.test.ts`); `planner.ts`
  checks a hostname against its mode; `registry.ts` maps a mode to a provider.
  Only `direct` and `lan-only` are implemented, the other modes answer "not
  available yet". `apply` stores nothing; callers keep the returned state.
- **Edge set.** `isEdge` in the table must equal `EDGE_MODES` in
  `src/features/install/heartbeat-policy.ts` (that file cannot import this
  directory, so the test lives here). The Deno heartbeat reader is fed the
  hostname modes from `server.ts` every five minutes.
- **Not switched on.** No route calls the registry yet, and the edge go-live
  gate (refuse to apply an edge mode while the fleet is unpinned) lands with
  the first edge provider, after the pin columns exist.
- **Edge ranges.** `edge-ranges.ts` fetches the Cloudflare list (etag, daily) and
  the Bunny lists for the proxy modes in use and keeps them in the `EDGE_TRUST`
  setting (`src/features/install/edge-trust.ts`, Workers-safe). The apply body
  carries `edgeTrust` only to a daemon advertising `instance-edge-trust-v1`;
  Caddy picks the visitor address from them, so `resolvePeerAddress` is unchanged.
  A vendor answer is refused whole (the last good list stays, the error is
  recorded) when any entry is wider than /8 (v4) or /16 (v6), overlaps loopback,
  private, link-local, CGNAT, ULA or multicast space, or the list passes 5000
  entries. Fetches time out after 10 s, refuse redirects and stop reading at
  1 MiB, so a slow vendor cannot stall the maintenance tick or an apply.
