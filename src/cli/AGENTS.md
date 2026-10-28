# Instance Binary Verbs (`src/cli/`)

One binary: the server, the in-process email consumer (below) and the
install-time verbs. Everything the installer used to reach into a source
checkout for is now a verb of the instance binary,
routed by `src/deno.ts` and imported lazily so the server path (which loads
the DuckDB addon at module evaluation and so needs the vendored `.so` on
`LD_LIBRARY_PATH`) is never touched by an install-time run:


- `migrate` (`src/cli/migrate.ts`) — the same two gates as `pnpm migrate`:
  refuse a server without `uuidv7()` (PostgreSQL 18+), then apply the
  migrations under a blocking `pg_advisory_lock` on the same connection the
  drizzle migrator uses, into `public.migration`. The lock key, table, schema
  and version floor are pinned against `scripts/migrate-locked.mjs` /
  `check-postgres-compat.mjs` by `src/cli/migrate.test.ts`. The compile tasks
  `--include migrations`, so the files come out of the binary
  (`import.meta.url`-relative, never the cwd; the embedded VFS is readable
  regardless of the `--allow-read` pins). **After `pnpm generate`, nothing else
  is needed — the next compile embeds the new files.**
- `generate-secret` (`src/cli/generate-secret.ts`) — one
  `TURBOPANEL_SECRET`-shaped value, from `scripts/generate-secret.mjs`.
- `generate-self-signed-cert` (`src/cli/generate-self-signed-cert.ts`) — runs
  `scripts/generate-self-signed-cert.mjs` inside the binary; needs
  `/usr/bin/openssl` and `/usr/bin/hostname` on `--allow-run`, and with no
  `TURBOPANEL_TLS_CERTS_DIR` puts the leaf at `<state dir>/tls/certs` (inside
  `--allow-write`) instead of beside a repo root the binary does not have.
- The email consumer runs **in-process**
  (`src/lib/email/mailer/deno-mailer-consumer.ts`, started from
  `src/platform/deno/server.ts` beside the command consumer, closed on SIGTERM). It
  used to be a separate `turbopanel-mailer` binary and unit whose one reason
  to exist was an unrestricted outbound `--allow-net` kept away from the
  instance; the instance binary carries that flag itself since the egress
  allowlist was dropped (2026-09-18), so the split bought nothing but a second
  ~470 MB binary. The RabbitMQ queue stays (durability, rate limiting); the
  senders and job parser live in `src/lib/email/mailer/`. Only
  `src/platform/deno/server.ts` may import the consumer — it drags amqplib and the
  nodemailer SMTP sender into the graph, which the Workers build shims out.

`src/deno-compile-permissions.test.ts` pins all of the above. `deno compile`
with BYONM copies the whole `node_modules` tree into the binary, so the
release job type-checks against the full tree, then reinstalls
production-only (`pnpm install --prod`) before `deno task compile` — the dev
tree (wrangler + workerd, vitest, drizzle-kit, esbuild) is the difference
between ~480 MB and ~200 MB. The compile tasks therefore run `--no-check`:
a pruned tree has no `@types/node` for a checking compile to resolve.
