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
- Today it holds `POST /instance/tunnel-token`.
