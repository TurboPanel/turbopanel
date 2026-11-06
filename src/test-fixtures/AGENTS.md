# Test Fixtures (`src/test-fixtures/`)

Unit tests use non-production secrets from `src/test-fixtures/secrets.ts`
(`TEST_ONLY_TURBOPANEL_SECRET`). Host-free `managed.ha.reconcile` parser tests
build daemon sealed-envelope strings via `src/test-fixtures/managed-ha-envelopes.ts`
so PR secret scans do not flag static daemon-envelope literals. Vitest Workers config uses the same naming
convention in `wrangler.vitest.jsonc`. The secret scanner allowlists only exact
fixture lines in `.secretscan-allowlist` — do not add broad exclusions.
