# Source Tree Rules (`src/`)

### Type-checking

- `deno task check:types` type-checks the Deno surface **including the test
  files**. The `deno task test:*` tasks all run `--no-check`, so without it
  nothing catches type drift in tests. It runs first in `pnpm test:hook`.
- Two kinds of test file are excluded from it, both owned by the Workers
  toolchain (`pnpm test:do`): anything importing `vitest` / `cloudflare:test`,
  and anything tagged **`@needs-workers-globals`** in its header — a file that
  reaches a module typed against Workers ambient globals (`CloudflareBindings`,
  `DurableObjectStub`, …).
- **Do not try to give Deno those globals.** `@cloudflare/workers-types`
  redeclares `Request` / `Response` / `fetch` and collides with `lib.deno.ns`;
  hand-declaring the names instead collides with the real workers-types in the
  editor, because `DurableObjectStub` is a **type alias** there and
  `DurableObjectNamespace` is a **class** — neither merges with a local
  interface, and augmenting `Response.webSocket` trips "identical modifiers".
- The supported way to keep a shared module inside the Deno check is the
  narrowing pattern: a local structural type (`HyperdriveBinding`,
  `R2BucketLike`, `CommandQueueBinding`) instead of the Workers global. Prefer
  that over widening the exclusion list.

### Deno lint

- `require-await` is excluded in `deno.json`. Async-without-await is
  load-bearing across this codebase: interface implementations
  (`fake-redis-cell-client.ts`, the noop email/command queues, rate-limit
  contracts, query caches) and object-literal test doubles must return a Promise
  to satisfy their contract, so dropping `async` breaks callers at runtime
  rather than tidying them. Do not re-enable it.
- Import `@std/*` by the **bare specifier** mapped in `deno.json` imports
  (`from '@std/assert'`), never an inline `jsr:` / `npm:` URL — inline
  specifiers trip `no-import-prefix` and `no-unversioned-import`.

### TypeScript style (SonarQube)

- Prefer **`String#replaceAll()`** over **`String#replace()` with a global
  regex** when replacing every occurrence of a substring (`typescript:S7781`).
- Use **`String.raw`** for string literals that contain backslashes so escapes
  stay readable and correct (`typescript:S7780`).
- Prefer **optional chaining** (`obj?.prop`) over `!obj || obj.prop`
  (`typescript:S6582`).
- Use **`new TypeError()`** for type/shape assertions in tests
  (`typescript:S7786`).
- Avoid **nested ternaries** — use `if`/`switch` or helpers
  (`typescript:S3358`).
- Extract helpers when **cognitive complexity** exceeds 15 (`typescript:S3776`).
- Sort strings with **`.sort((a, b) => a.localeCompare(b))`**
  (`typescript:S2871`).
- Mark React component props **`Readonly<{…}>`** (`typescript:S6759`).
- Omit optional parameters instead of passing redundant **`undefined`**
  (`typescript:S4623`).
- Prefer **`String#codePointAt()`** over **`charCodeAt()`** when decoding byte
  strings (`typescript:S7758`).
- Use **`RegExp.exec()`** instead of `String.match()` for single-match
  extraction (`typescript:S6594`).
- Do not leave **`TODO`** in code — use `Future:` in a normal comment
  (`typescript:S1135`).
- Use **RFC 5737 TEST-NET** addresses (e.g. `203.0.113.x`) in tests, not
  arbitrary public IPs (`typescript:S1313`).
- No flaky tests. Do not feed unseeded randomness (`crypto.randomUUID`,
  `Math.random`, `getRandomValues`) into a test where an assertion depends on
  the value's content (substring, prefix, ordering, base64 characters); use a
  fixed value, or a seeded or injected generator. A tamper test must change
  the input for certain (flip a character to a different one, and not only a
  trailing base64 character, whose unused bits may decode the same). No tight
  real-time margins (`setTimeout`/`Date.now` deltas): use a fake clock or wait
  on the event itself. No wall-clock expectations (year, month, day, DST)
  without a fixed clock.
- Add **`// NOSONAR rule-key — reason`** when a semantic type alias or path
  check is intentional (`typescript:S6564`, `typescript:S5443`).
- Deno tests: Sonar `typescript:S2187` only recognizes `test()` / `it()` /
  `describe()`, not `Deno.test`. **Every `*.test.ts` file that would otherwise
  call `Deno.test(...)` MUST** either use BDD
  (`import { describe, it } from '@std/testing/bdd'`) or alias `Deno.test` —
  never leave a bare `Deno.test(` in a test file. The canonical alias (same
  pattern as `../turbopaneld`, applied to all existing Deno test files) is
  placed once, right after the imports:

  ```ts
  /**
   * Jest/Mocha-shaped alias for {@link Deno.test}.
   *
   * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
   * reports Deno suites as empty; keep this alias so analysis sees real tests.
   */
  const test = Deno.test.bind(Deno);
  ```

  Then call `test('...', () => { … })` (or the object form `test({ name, fn })`)
  instead of `Deno.test(...)`. When adding a new Deno test file, add this alias
  from the start **and claim the file in the test inventory** (next section).

### Adding tests (inventory)

A new suite that is not claimed by a runner never executes in CI and never
appears in `coverage/lcov.info`. After adding, renaming, or deleting a
`*.test.ts`, run **`pnpm check:test-inventory`** (`scripts/check-test-inventory.mjs`)
— it is wired into `pnpm test:hook` and CI `build.yml`. Claim each file in
**exactly one** bucket via its **filename suffix** (or an explicit
`SERVICE_DEPENDENT` row):

| Suite kind                                                                       | Claim it                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deno (`@std/assert`, `const test = Deno.test.bind(Deno)`, `@std/testing/bdd`)    | `*.test.ts` / `*.hostfree.test.ts` / `*.deno.test.ts` under `src/` or `scripts/` (`scripts/test-coverage.sh` walks those trees)                                          |
| Workers / Durable Object (`vitest`, `cloudflare:test`, `@needs-workers-globals`) | `*.workers.test.ts` / `*.workers-e2e.test.ts` / `*.entry.test.ts` (`vitest.config.ts` `test.include` suffix globs)                                                                    |
| Needs a service CI does not start (Redis, …)                                     | `SERVICE_DEPENDENT` in `scripts/check-test-inventory.mjs` **with a reason** — the only sanctioned way to leave a suite out of both runners                                           |

Do not give a Deno suite a Workers suffix. Coverage-attribution traps and the
LCOV merge live in [`scripts/AGENTS.md`](./scripts/AGENTS.md).

**Suffix semantics.** Host-free Deno suites use **`.hostfree.test.ts`** only.
Workers/Durable Object suites that must run under Vitest use
**`.workers.test.ts`**, **`.workers-e2e.test.ts`**, or **`.entry.test.ts`**.
`scripts/generate-test-lists.mjs --write` rebuilds both inventories as suffix
globs.

### Workers-reachable imports

Modules imported (transitively) from `src/workers.ts` must bundle under
Wrangler/esbuild. **Do not** use Deno import-map-only specifiers there —
`@std/*`, bare `jsr:…`, or other Deno-only APIs — unless there is a matching
`wrangler.jsonc` `alias` (see the SMTP shims). Prefer Web Crypto and small local
helpers (e.g. hex in `src/lib/machine-key.ts` /
`src/daemon/authn/server-key.ts`). **Do not** call `crypto.getRandomValues`,
`crypto.subtle.*`, `fetch`, or `setTimeout` at module load — Cloudflare startup
validation fails with error 10021
(`Disallowed operation called
within global scope`); mint keys and do I/O inside
a handler. Deno-only entrypoints (`src/deno.ts`, developer drizzle studio, Redis
cell) may keep `@std/*`. Guard: `pnpm check:workers-bundle`.
